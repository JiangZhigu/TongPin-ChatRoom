import { useCallback, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, apiBlob, APIError } from '../lib/api';
import type { AdminPage } from '../lib/admin-types';
import type { AdminJob, AdminOperation, ExportParameters } from '../lib/admin-s3-types';
import { Modal } from '../components/Modal';
import { ActionButton, AdminContext, bytesText, DataTable, dateText, EmptyRow, errorText, identityText, PageHeading, queryPath, statusText } from './AdminShared';
import { auditFilterFields } from './AuditPage';

type Snapshot = { operations?: AdminPage<AdminOperation>; jobs?: AdminPage<AdminJob>; receivedAt?: number; error?: string; pending: boolean; key: string };
export function useOperations(operationsPath: string, jobsPath: string) {
  const { deny, revision } = useContext(AdminContext); const key = operationsPath + jobsPath;
  const [state, setState] = useState<Snapshot>({ pending: false, key }); const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true; let inFlight = false; let timer: number | undefined; let request: AbortController | null = null;
    setState((old) => old.key === key ? old : { key, pending: false });
    function schedule() { window.clearTimeout(timer); if (active && document.visibilityState === 'visible') timer = window.setTimeout(() => void refresh(), 5000); }
    async function refresh() {
      if (!active || inFlight || document.visibilityState !== 'visible') return;
      window.clearTimeout(timer); inFlight = true; const controller = new AbortController(); request = controller;
      setState((old) => ({ ...old, pending: true }));
      try {
        const [operations, jobs] = await Promise.all([api<AdminPage<AdminOperation>>(operationsPath, { signal: controller.signal }), api<AdminPage<AdminJob>>(jobsPath, { signal: controller.signal })]);
        if (active && !controller.signal.aborted) setState({ key, pending: false, operations, jobs, receivedAt: Date.now() });
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof APIError && (cause.status === 401 || cause.status === 403)) { active = false; controller.abort(); setState({ key, pending: false }); deny(); return; }
        controller.abort(); setState((old) => ({ ...old, pending: false, error: errorText(cause) }));
      } finally { inFlight = false; schedule(); }
    }
    function visibility() { window.clearTimeout(timer); if (document.visibilityState === 'visible') schedule(); }
    refreshRef.current = () => void refresh(); document.addEventListener('visibilitychange', visibility); void refresh();
    return () => { active = false; window.clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visibility); refreshRef.current = () => {}; };
  }, [operationsPath, jobsPath, key, deny, revision]);
  return { ...(state.key === key ? state : { key, pending: false }), refresh: useCallback(() => refreshRef.current(), []) };
}

const exportFields = [['query', '正文搜索词'], ['conversationId', '会话 ID'], ['senderId', '发送者 ID'], ['ownerId', '文件所有者 ID'], ['kind', '内容或文件类型'], ['status', '内容状态'], ['governance', '文件治理状态'], ['state', '文件处理状态']] as const;
export function ExportForm() {
  const { openAction } = useContext(AdminContext); const [kind, setKind] = useState<ExportParameters['kind']>('content');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const filters: Record<string, string | number> = {};
    for (const [key, value] of data) if (key.startsWith('filter:') && typeof value === 'string' && value.trim()) { const name = key.slice(7); filters[name] = ['fromAt', 'until'].includes(name) ? new Date(value).getTime() : value.trim(); }
    const parameters: ExportParameters = { kind, filters, maxRows: Number(data.get('maxRows')), maxBytes: Number(data.get('maxBytes')), includeFiles: kind !== 'audit' && data.get('includeFiles') === 'on' };
    openAction({ action: 'export.create', targetIds: ['instance'], labels: ['受控导出任务'], parameters: { ...parameters }, parameterSummary: [{ label: '导出类型', value: kind }, { label: '筛选条件', value: JSON.stringify(filters) }, { label: '预算', value: `${parameters.maxRows} 条 / ${bytesText(parameters.maxBytes)}` }, { label: '包含文件', value: parameters.includeFiles ? '是（超预算明确拒绝）' : '否' }] });
  }
  return <section className="admin-panel"><h2>受控导出</h2><p>筛选条件仅留在当前页面；预览显示真实匹配数和预算。文件仅可由创建任务的原管理会话在到期前下载。</p><form className="admin-s3-form" onSubmit={submit}>
    <label>导出类型<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="content">消息内容</option><option value="files">文件</option><option value="audit">审计</option></select></label>
    <div key={kind} className="admin-s3-fields">{(kind === 'audit' ? auditFilterFields : exportFields.filter(([key]) => kind === 'content' ? !['ownerId', 'governance', 'state'].includes(key) : !['senderId', 'status'].includes(key))).map(([key, label]) => <label key={key}>{label}<input name={`filter:${key}`} /></label>)}<label>导出开始时间<input name="filter:fromAt" type="datetime-local" /></label><label>导出结束时间<input name="filter:until" type="datetime-local" /></label></div>
    <label>最多导出条数<input name="maxRows" type="number" required min={1} max={5000} step={1} defaultValue={1000} /></label><label>最大归档字节数<input name="maxBytes" type="number" required min={1024} max={536870912} step={1} defaultValue={104857600} /></label>{kind !== 'audit' && <label key={`include-files:${kind}`} className="admin-check"><input name="includeFiles" type="checkbox" />包含原文件</label>}<button className="primary-button">预览创建导出任务</button>
  </form></section>;
}

export function OperationDownload({ operation, onClose }: { operation: AdminOperation; onClose: () => void }) {
  const { deny } = useContext(AdminContext); const [reason, setReason] = useState(''); const [password, setPassword] = useState(''); const [factor, setFactor] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  const controller = useRef<AbortController | null>(null); const locked = useRef(false); const objectUrl = useRef<string | null>(null); const backup = operation.kind === 'backup.create';
  useEffect(() => { controller.current = new AbortController(); return () => { controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, []);
  async function download(event: FormEvent) {
    event.preventDefault(); if (locked.current || !operation.canDownload) return; const request = controller.current; if (!request || request.signal.aborted) return;
    locked.current = true; setBusy(true); setError(''); setDone(false);
    try {
      let reauthToken: string | undefined;
      if (backup) { const result = await api<{ reauthToken: string }>('/api/v1/auth/reauth', { method: 'POST', body: { password, secondFactor: factor, action: `backup.download:${operation.id}` }, signal: request.signal }); reauthToken = result.reauthToken; if (request.signal.aborted) return; setPassword(''); setFactor(''); }
      const blob = await apiBlob(`/api/v1/admin/operations/${encodeURIComponent(operation.id)}/download`, { body: { reason: reason.trim(), ...(reauthToken ? { reauthToken } : {}) }, signal: request.signal, timeoutMs: 600000 }); if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob); objectUrl.current = url; const link = document.createElement('a'); link.href = url; link.download = `${backup ? 'backup' : 'export'}-${operation.id}.zip`; link.click(); setDone(true);
      window.setTimeout(() => { URL.revokeObjectURL(url); if (objectUrl.current === url) objectUrl.current = null; }, 1000);
    } catch (cause) { if (request.signal.aborted) return; if (cause instanceof APIError && (cause.status === 401 || cause.status === 403) && ['AUTH_REQUIRED', 'SESSION_REVOKED', 'FORBIDDEN'].includes(cause.code)) { deny(); return; } setError(errorText(cause)); }
    finally { locked.current = false; if (!request.signal.aborted) { setBusy(false); setPassword(''); setFactor(''); } }
  }
  return <Modal open title={backup ? '下载完整备份' : '下载受控导出'} onClose={onClose}><p>{backup ? '完整备份下载需再次验证管理员密码与第二因素。' : '仅原创建会话可下载；服务器再次校验权限及到期时间。'}</p><p>归档读取最多等待 10 分钟，可随时取消。浏览器收到归档后仍需核对实际保存结果。</p><p>归档 SHA-256：{operation.sha256 || '服务器未提供'}</p><form className="admin-s3-form" onSubmit={(event) => void download(event)}><fieldset disabled={busy}><label>下载理由<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>{backup && <><label>下载验证密码<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>下载动态码或第二因素恢复码<input required autoComplete="off" value={factor} onChange={(event) => setFactor(event.target.value)} /></label></>}<button className="primary-button">{busy ? '正在安全读取…' : '验证并下载归档'}</button></fieldset></form>{error && <p role="alert" className="form-error">{error}</p>}{done && <p role="status">归档已交给浏览器下载，请在浏览器中核对保存结果。</p>}<button className="text-button" onClick={onClose}>{busy ? '取消读取并关闭' : '关闭下载窗口'}</button></Modal>;
}

export function OperationsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({}); const [after, setAfter] = useState(''); const [jobsAfter, setJobsAfter] = useState(''); const [jobFilters, setJobFilters] = useState<Record<string, string>>({}); const [download, setDownload] = useState<AdminOperation | null>(null);
  const live = useOperations(queryPath('/api/v1/admin/operations', { ...filters, after, limit: '50' }), queryPath('/api/v1/admin/jobs', { ...jobFilters, after: jobsAfter, limit: '50' }));
  const currentDownload = download && live.operations?.items.find((item) => item.id === download.id);
  useEffect(() => { if (download && live.operations && (!currentDownload || !currentDownload.canDownload)) setDownload(null); }, [currentDownload, download, live.operations]);
  function applyFilters(event: FormEvent<HTMLFormElement>, jobs = false) { event.preventDefault(); const next: Record<string, string> = {}; for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === 'string' && value.trim()) next[key] = value.trim(); if (jobs) { setJobFilters(next); setJobsAfter(''); } else { setFilters(next); setAfter(''); } }
  return <><PageHeading title="运维任务与备份" description="页面可见时每轮完成后 5 秒核对任务；隐藏暂停。命令接受不表示处理完成，进度和结果均来自实际处理器。"><button className="secondary-button" disabled={live.pending} onClick={live.refresh}>刷新运维任务</button></PageHeading>
    <ExportForm /><section className="admin-panel"><h2>完整备份与空间维护</h2><p>备份含数据库与私有文件，密钥须独立保管；同盘备份不提供独立故障域。验证和恢复演练仅用于隔离检查，不替换当前数据库。</p><div className="admin-actions"><ActionButton request={{ action: 'backup.create', targetIds: ['instance'], labels: ['当前实例完整备份'], parameters: {} }}>创建完整备份</ActionButton><ActionButton request={{ action: 'storage.cleanup', targetIds: ['instance'], labels: ['当前实例有界空间清理'], parameters: {} }}>预览空间清理</ActionButton></div></section>
    {live.receivedAt && <p>上次成功读取：{dateText(live.receivedAt)}{live.pending ? ' · 正在核对，保留现有数据' : ''}</p>}{live.error && <p role="alert" className="form-error">刷新失败：{live.error}。{live.receivedAt ? `仍显示旧数据，上次成功读取 ${dateText(live.receivedAt)}。` : '尚无可用数据。'}</p>}{!live.operations && !live.error && <p role="status">页面可见时读取运维数据…</p>}
    <section className="admin-panel"><h2>管理操作任务</h2><form className="admin-s3-form" onSubmit={(event) => applyFilters(event)}><label>操作类型<select name="kind"><option value="">全部</option>{['export.create', 'backup.create', 'backup.verify', 'backup.drill', 'storage.cleanup'].map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>任务状态<select name="status"><option value="">全部</option>{['queued', 'running', 'completed', 'failed', 'cancelled'].map((status) => <option key={status} value={status}>{statusText(status)}</option>)}</select></label><button className="secondary-button">筛选操作</button></form>
    {live.operations && <><DataTable caption="管理操作任务" headings={['任务 / 发起者', '状态 / 实际进度', '结果 / 时间', '操作']}>{live.operations.items.length ? live.operations.items.map((item) => <tr key={item.id}><th scope="row">{item.kind}<small>{item.id}</small>{item.creator ? identityText(item.creator) : '系统定时任务'}{item.backupClass && <small>{item.backupClass === 'daily' ? '日备份' : '周备份'}</small>}</th><td>{statusText(item.status)}<p>{item.progress} / {item.total} · {bytesText(item.bytes)}</p>{item.total > 0 && <progress aria-label={`任务 ${item.id} 进度`} value={item.progress} max={item.total} />}</td><td><p>{item.message}</p>{item.errorCode && <p>{item.errorCode}</p>}<time>{dateText(item.updatedAt)}</time><details><summary>任务详情 {item.id}</summary><p>创建 {dateText(item.createdAt)} · 到期 {dateText(item.expiresAt)}</p><p>后台任务：{item.jobId} · 请求：{item.requestId}</p><p>SHA-256：{item.sha256 || '未提供'}</p><pre className="admin-json">{JSON.stringify(item.result, null, 2)}</pre></details></td><td><div className="admin-actions">{item.canCancel && <ActionButton request={{ action: 'operation.cancel', targetIds: [item.id], labels: [item.id], parameters: {} }}>取消未完成步骤</ActionButton>}{item.canRetry && <ActionButton request={{ action: 'operation.retry', targetIds: [item.id], labels: [item.id], parameters: {} }}>重新预览并重建任务</ActionButton>}{item.kind === 'backup.create' && item.status === 'completed' && <><ActionButton request={{ action: 'backup.verify', targetIds: [item.id], labels: [item.id], parameters: {} }}>验证备份</ActionButton><ActionButton request={{ action: 'backup.drill', targetIds: [item.id], labels: [item.id], parameters: {} }}>隔离恢复演练</ActionButton></>}{item.canDownload && <button className="secondary-button" onClick={() => setDownload(item)}>安全下载</button>}</div></td></tr>) : <EmptyRow count={4} />}</DataTable><p>共 {live.operations.total} 条</p><div className="admin-actions">{after && <button className="secondary-button" onClick={() => setAfter('')}>操作首页</button>}{live.operations.nextCursor && <button className="secondary-button" onClick={() => setAfter(live.operations!.nextCursor!)}>下一页操作</button>}</div></>}
    </section><section className="admin-panel"><h2>后台处理任务</h2><form className="admin-s3-form" onSubmit={(event) => applyFilters(event, true)}><label>后台处理器类型<input name="kind" /></label><label>后台任务状态<input name="status" /></label><button className="secondary-button">筛选后台任务</button></form>{live.jobs && <><DataTable caption="后台处理任务" headings={['任务', '状态 / 尝试', '计划 / 结束', '限制 / 操作']}>{live.jobs.items.length ? live.jobs.items.map((item) => <tr key={item.id}><th scope="row">{item.kind}<small>{item.id}</small><details><summary>处理器详情</summary><p>对象 {item.entityId} · 管理操作 {item.operationId || '无'}</p><p>创建 {dateText(item.createdAt)} · 租约截止 {dateText(item.leaseUntil)}</p></details></th><td>{statusText(item.status)} · {item.attempts} 次<p>{item.errorCode}</p></td><td>{dateText(item.runAfter)}<br />{dateText(item.completedAt)}</td><td>{item.limitation && <p>{item.limitation}</p>}{item.canRetry && <ActionButton request={{ action: 'job.retry', targetIds: [item.id], labels: [item.id], parameters: {} }}>预览安全重试任务</ActionButton>}</td></tr>) : <EmptyRow count={4} />}</DataTable><p>共 {live.jobs.total} 条</p><div className="admin-actions">{jobsAfter && <button className="secondary-button" onClick={() => setJobsAfter('')}>后台任务首页</button>}{live.jobs.nextCursor && <button className="secondary-button" onClick={() => setJobsAfter(live.jobs!.nextCursor!)}>下一页后台任务</button>}</div></>}</section>
    {currentDownload?.canDownload && <OperationDownload key={currentDownload.id} operation={currentDownload} onClose={() => setDownload(null)} />}
  </>;
}
