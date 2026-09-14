import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../components/Modal';
import { FormField } from '../components/FormField';
import { api, APIError } from '../lib/api';
import type { AdminAction, AdminCommand, AdminCommandInput, AdminMember, AdminPage, AdminPreview, AdminSecret, AdminThresholds } from '../lib/admin-types';
import { AdminContext, dateText, errorText, identityText, ResourceState, statusText, useResource, type ActionRequest } from './AdminShared';

export const actionLabels: Record<AdminAction, string> = { 'task.delete': '删除群待办', 'task.restore': '恢复群待办', 'task.comment.delete': '删除待办评论', 'task.group.policy': '调整群待办创建策略', 'task_report.close': '处理并关闭待办举报', 'task_report.reopen': '重新打开待办举报', 'user.ban': '封禁账号', 'user.unban': '解除封禁', 'user.mute': '全站禁言', 'user.unmute': '解除全站禁言', 'user.restrict': '调整账号限制', 'user.restore': '恢复冷静期账号', 'user.password_reset': '人工重置密码', 'session.revoke': '撤销会话', 'user.logout_all': '退出全部设备', 'relationship.remove': '解除好友关系', 'friend_request.cancel': '取消好友申请', 'conversation.freeze': '冻结会话', 'conversation.unfreeze': '解冻会话', 'group.member.role': '纠正成员角色', 'group.member.mute': '群内禁言', 'group.member.unmute': '解除群内禁言', 'group.member.remove': '移出群成员', 'group.owner.change': '纠正群主', 'group.dissolve': '解散群聊', 'group.invite.revoke': '撤销群邀请', 'monitoring.thresholds': '修改告警阈值', 'message.review': '标记消息已审阅', 'message.hide': '隐藏消息', 'message.delete': '管理删除消息', 'message.restore': '恢复管理处置', 'file.quarantine': '隔离文件', 'file.release': '解除文件隔离', 'file.revoke': '撤销文件访问', 'user.quota': '调整附件配额', 'report.claim': '领取举报工单', 'report.reopen': '重开举报工单', 'report.reject': '驳回举报', 'report.resolve': '处理举报', 'settings.update': '更新站点策略', 'settings.rollback': '回滚站点策略', 'site_invite.create': '创建站点邀请码', 'site_invite.revoke': '撤销站点邀请码', 'announcement.create': '创建公告发送任务', 'announcement.withdraw': '撤回公告', 'administrator.invite': '邀请管理员', 'administrator.cancel': '取消管理邀请', 'administrator.revoke': '撤销管理权限', 'administrator.factor_reset': '人工恢复第二因素', 'export.create': '创建受控导出任务', 'backup.create': '创建完整备份任务', 'backup.verify': '验证备份', 'backup.drill': '隔离恢复演练', 'storage.cleanup': '空间清理任务', 'operation.cancel': '取消操作任务', 'operation.retry': '重新创建操作任务', 'job.retry': '安全重试后台任务' };
export const thresholdLabels: Record<keyof AdminThresholds, string> = { cpuPercent: 'CPU 使用率（%）', memoryMiB: '内存（MiB）', diskPercent: '磁盘使用率（%）', httpP95Ms: 'HTTP P95（毫秒）', dbWaitMs: '数据库等待（毫秒）', failedJobs: '失败任务数', pendingJobs: '等待任务数' };

function MemberChoice({ groupId, value, onChange }: { groupId: string; value: string; onChange: (value: string) => void }) {
  const [cursor, setCursor] = useState(''); const resource = useResource<AdminPage<AdminMember>>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/members?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
  const [selectedLabel, setSelectedLabel] = useState('');
  return <fieldset className="admin-member-choice"><legend>从现有群成员中选择新群主</legend><ResourceState {...resource} />{value && <p>已选择：{selectedLabel}</p>}{resource.data?.items.map((member) => <label key={member.id}><input type="radio" name="new-owner" checked={value === member.user.id} onChange={() => { onChange(member.user.id); setSelectedLabel(identityText(member.user)); }} />{identityText(member.user)} · {statusText(member.role)}</label>)}<div className="admin-actions">{cursor && <button type="button" className="text-button" onClick={() => setCursor('')}>成员首页</button>}{resource.data?.nextCursor && <button type="button" className="text-button" onClick={() => setCursor(resource.data!.nextCursor!)}>更多成员</button>}</div></fieldset>;
}

export function AdminActionDialog({ request, onClose, onChanged }: { request: ActionRequest; onClose: () => void; onChanged: () => void }) {
  const { deny } = useContext(AdminContext); const controller = useRef<AbortController | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [fixedParameters] = useState(() => structuredClone(request.parameters || {}));
  const [quotaBytes, setQuotaBytes] = useState(request.initial?.quotaBytes ?? 0); const [defaultQuota, setDefaultQuota] = useState(false);
  const [reason, setReason] = useState(''); const [until, setUntil] = useState(''); const [role, setRole] = useState<'admin' | 'member'>(request.initial?.role || 'member'); const [userId, setUserId] = useState('');
  const [uploadDisabled, setUploadDisabled] = useState(request.initial?.uploadDisabled ?? false); const [groupCreationDisabled, setGroupCreationDisabled] = useState(request.initial?.groupCreationDisabled ?? false);
  const [thresholds, setThresholds] = useState(request.initial?.values);
  const [input, setInput] = useState<AdminCommandInput | null>(null); const [preview, setPreview] = useState<AdminPreview | null>(null); const [command, setCommand] = useState<AdminCommand | null>(null);
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false); const [secret, setSecret] = useState<AdminSecret | null>(null); const [secretAttempted, setSecretAttempted] = useState(false); const [needsPreview, setNeedsPreview] = useState(false);
  useEffect(() => { controller.current = new AbortController(); return () => controller.current?.abort(); }, []);
  useEffect(() => { if (!secret) return; const timer = window.setTimeout(() => setSecret(null), Math.max(0, secret.expiresAt - Date.now())); return () => window.clearTimeout(timer); }, [secret]);
  const live = () => controller.current !== null && !controller.current.signal.aborted;
  function fail(cause: unknown) { if (!live()) return; if (cause instanceof APIError && ((cause.status === 401 || cause.status === 403) && !['REAUTH_FAILED', 'REAUTH_REQUIRED', 'INVALID_SECOND_FACTOR', 'INVALID_PASSWORD'].includes(cause.code))) { deny(); return; } setError(errorText(cause)); }
  async function readCommand() {
    const signal = controller.current?.signal;
    try { const result = await api<AdminCommand>(`/api/v1/admin/commands/${encodeURIComponent(operationId)}`, { signal }); if (!live()) return; setCommand(result); setUnknown(false); setError(''); if (!['queued', 'running'].includes(result.status)) onChanged(); }
    catch (cause) { fail(cause); }
  }
  useEffect(() => {
    if (!command || !['queued', 'running'].includes(command.status)) return;
    let disposed = false; let timer: number | undefined;
    async function poll() { if (disposed) return; if (document.visibilityState === 'visible') await readCommand(); if (!disposed) timer = window.setTimeout(() => void poll(), 2000); }
    timer = window.setTimeout(() => void poll(), 2000);
    return () => { disposed = true; window.clearTimeout(timer); };
    // A new receipt replaces this timer; each request is separated by at least two seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, operationId]);
  async function makePreview(event: FormEvent) {
    event.preventDefault(); if (lock.current) return; if (reason.trim().length < 3) { setError('请填写至少 3 个字符的操作理由。'); return; } lock.current = true; setBusy(true); setError('');
    let parameters: Record<string, unknown> = fixedParameters;
    if (request.action.endsWith('.mute')) { const parsed = new Date(until).getTime(); if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + 30 * 86400000) { setError('禁言截止时间必须在未来 30 天内。'); setBusy(false); lock.current = false; return; } parameters = { until: parsed }; }
    if (request.action === 'user.restrict') parameters = { uploadDisabled, groupCreationDisabled };
    if (request.action === 'group.member.role') parameters = { role };
    if (request.action === 'group.owner.change') { if (!userId) { setError('请选择一位现有群成员。'); setBusy(false); lock.current = false; return; } parameters = { userId }; }
    if (request.action === 'monitoring.thresholds') parameters = { values: thresholds };
    if (request.action === 'user.quota') parameters = { quotaBytes: defaultQuota ? null : quotaBytes };
    const nextInput = input || { operationId, action: request.action, targetIds: request.targetIds, parameters, reason: reason.trim() }; setInput(nextInput);
    try { const result = await api<AdminPreview>('/api/v1/admin/commands/preview', { method: 'POST', body: nextInput, signal: controller.current?.signal }); if (!live()) return; setPreview(result); setNeedsPreview(false); }
    catch (cause) { if (live() && cause instanceof APIError) { if (cause.code === 'COMMAND_EXISTS') setUnknown(true); else if (['PREVIEW_EXPIRED', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(cause.code)) setNeedsPreview(true); else if (cause.status > 0 && cause.status < 500) setInput(null); } fail(cause); }
    finally { if (live()) setBusy(false); lock.current = false; }
  }
  async function execute(event: FormEvent) {
    event.preventDefault(); if (lock.current || !preview || unknown || command) return;
    if (preview.expiresAt <= Date.now()) { setNeedsPreview(true); setError('预览已到期，请重新查看最新目标与影响。'); return; }
    lock.current = true; setBusy(true); setError(''); let executionSent = false;
    try {
      const { reauthToken } = await api<{ reauthToken: string }>('/api/v1/auth/reauth', { method: 'POST', body: { password, action: `admin.execute:${operationId}` }, signal: controller.current?.signal });
      if (!live()) return; setPassword(''); executionSent = true;
      const result = await api<AdminCommand>('/api/v1/admin/commands/execute', { method: 'POST', body: { operationId, reauthToken }, signal: controller.current?.signal });
      if (!live()) return; setCommand(result); onChanged();
    } catch (cause) { if (!live()) return; if (executionSent) { if (cause instanceof APIError && ['PREVIEW_EXPIRED', 'TARGET_CHANGED', 'VERSION_CONFLICT', 'ADMIN_PREVIEW_EXPIRED', 'ADMIN_TARGET_CHANGED'].includes(cause.code)) setNeedsPreview(true); else setUnknown(true); } fail(cause); }
    finally { if (live()) { setBusy(false); setPassword(''); } lock.current = false; }
  }
  function resetPreview() { setOperationId(crypto.randomUUID()); setInput(null); setPreview(null); setNeedsPreview(false); setError(''); setPassword(''); }
  async function revealSecret() {
    if (lock.current || secretAttempted) return; lock.current = true; setSecretAttempted(true); setBusy(true); setError('');
    try { const result = await api<AdminSecret>(`/api/v1/admin/commands/${encodeURIComponent(operationId)}/secret`, { method: 'POST', body: {}, signal: controller.current?.signal }); if (live() && result.expiresAt > Date.now()) setSecret(result); }
    catch (cause) { fail(cause); } finally { if (live()) setBusy(false); lock.current = false; }
  }
  return <Modal open title={actionLabels[request.action]} onClose={onClose} dismissible={!busy}><div className="admin-action-dialog">
    <p>操作编号：<code>{operationId}</code></p>
    {!preview && !command && !unknown && !needsPreview && <form onSubmit={(event) => void makePreview(event)}><fieldset disabled={busy || !!input}><p>已选 {request.targetIds.length} 个目标</p><ul>{request.labels.map((label, index) => <li key={request.targetIds[index]}>{label}</li>)}</ul>
      {request.action.endsWith('.mute') && <FormField label="禁言截止时间" type="datetime-local" required value={until} onChange={(event) => setUntil(event.target.value)} hint="最多 30 天，按当前设备时区输入。" />}
      {request.action === 'user.restrict' && <><label className="admin-check"><input type="checkbox" checked={uploadDisabled} onChange={(event) => setUploadDisabled(event.target.checked)} />禁止上传</label><label className="admin-check"><input type="checkbox" checked={groupCreationDisabled} onChange={(event) => setGroupCreationDisabled(event.target.checked)} />禁止创建群聊</label></>}
      {request.action === 'group.member.role' && <label className="form-field">目标角色<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="member">普通成员</option><option value="admin">群管理员</option></select></label>}
      {request.action === 'group.owner.change' && request.groupId && <MemberChoice groupId={request.groupId} value={userId} onChange={setUserId} />}
      {request.action === 'monitoring.thresholds' && thresholds && (Object.keys(thresholdLabels) as (keyof AdminThresholds)[]).map((key) => <FormField key={key} label={thresholdLabels[key]} type="number" required min={0} step="any" max={key === 'cpuPercent' || key === 'diskPercent' ? 100 : undefined} value={thresholds[key]} onChange={(event) => setThresholds({ ...thresholds, [key]: event.target.valueAsNumber })} />)}
      {request.parameterSummary && <dl className="admin-facts">{request.parameterSummary.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
      {request.action === 'user.quota' && <><label className="admin-check"><input type="checkbox" checked={defaultQuota} onChange={(event) => setDefaultQuota(event.target.checked)} />恢复站点默认配额</label>{!defaultQuota && <FormField label="附件配额（字节）" type="number" required min={0} step={1} value={quotaBytes} onChange={(event) => setQuotaBytes(event.target.valueAsNumber)} />}<p>缩小配额只限制新增上传，不删除已有附件。</p></>}
      <label className="form-field">操作理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={500} required /></label></fieldset><button className="primary-button" disabled={busy}>{busy ? '正在生成预览…' : input ? '重取同一操作预览' : '预览目标与影响'}</button>{input && !busy && <p>请求参数已固定。重取预览使用同一操作编号；关闭可放弃尚未执行的预览。</p>}</form>}
    {preview && !command && <><section className="admin-preview"><h3>服务端操作预览</h3><p>{preview.targetCount} 个目标 · 到期 {dateText(preview.expiresAt)}</p><p>理由：{preview.reason}</p><ul>{preview.targets.map((target) => <li key={target.id}><strong>{target.label}</strong><p>{statusText(target.detail)}</p><small>{target.id}</small></li>)}</ul><h4>将产生的影响</h4><ul>{preview.impacts.map((impact, index) => <li key={index}>{impact}</li>)}</ul></section>{!unknown && !needsPreview && <form onSubmit={(event) => void execute(event)}><fieldset disabled={busy}><FormField label="管理员当前密码" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button className="primary-button danger-button">{busy ? '正在验证并执行…' : '验证身份并执行'}</button></fieldset></form>}{needsPreview && <button className="secondary-button" onClick={resetPreview}>重新预览最新目标</button>}</>}
    {!preview && needsPreview && <button className="secondary-button" onClick={resetPreview}>重新预览最新目标</button>}
    {error && <p role="alert" className="form-error">{error}{request.action.startsWith('settings.') && needsPreview ? ' 请关闭窗口并刷新运行配置，基于最新版本重新核对变更。' : ''}</p>}
    {unknown && <section className="warning-note"><h3>执行结果尚未确认</h3><p>请使用本操作编号核对结果。不要重新创建或重复执行同一处罚。</p><button className="secondary-button" disabled={busy} onClick={() => void readCommand()}>核对同一操作结果</button></section>}
    {command && <section aria-live="polite"><h3>执行结果：{statusText(command.status)}</h3>{['announcement.create', 'export.create', 'backup.create', 'backup.verify', 'backup.drill', 'storage.cleanup', 'operation.retry', 'job.retry'].includes(request.action) && <p className="warning-note">此处是命令处理回执；任务被接受不代表已完成。请在公告发送记录或运维任务页核对实际进度和最终结果。</p>}<p>总计 {command.total} · 成功 {command.succeeded} · 失败 {command.failed} · 待处理 {command.pending}</p>{['queued', 'running'].includes(command.status) && <p>页面可见时每隔至少 2 秒更新进度；关闭窗口不会取消服务器任务。</p>}<ul className="admin-results">{command.items.map((item) => <li key={item.id}><strong>{item.label}</strong><span>{statusText(item.status)}</span>{item.message && <p>{item.message}</p>}{item.code && <small>结果代码：{item.code}</small>}</li>)}</ul><button className="secondary-button" onClick={() => void readCommand()}>刷新操作结果</button>
      {['user.password_reset', 'site_invite.create'].includes(request.action) && command.secretAvailable && !secretAttempted && <><p>{request.action === 'site_invite.create' ? '站点邀请码仅可由当前会话在生成后 5 分钟内领取一次；邀请码有效期以领取后显示为准。' : '恢复凭据仅可由当前会话在生成后 5 分钟内领取一次；凭据有效期以领取后显示为准。'}</p><button className="primary-button" disabled={busy} onClick={() => void revealSecret()}>{request.action === 'site_invite.create' ? '显示一次性站点邀请码' : '显示一次性恢复凭据'}</button></>}
      {secret && <div className="admin-secret"><h4>{secret.kind === 'site_invite' || request.action === 'site_invite.create' ? '请安全交付站点邀请码' : '请安全交付给账号本人'}</h4>{secret.kind !== 'site_invite' && request.action !== 'site_invite.create' && <p>账号：{secret.username}</p>}<p><code>{secret.credential}</code></p><p>有效期至 {dateText(secret.expiresAt)}。{secret.kind === 'site_invite' || request.action === 'site_invite.create' ? '受邀者在同频注册页的“站点邀请码”栏填写此内容。' : '本人在同频登录页选择“忘记密码？联系管理员”，填写用户名和此一次性重置凭据后设置新密码。'}</p><button className="secondary-button" onClick={() => setSecret(null)}>隐藏凭据</button></div>}
      {secretAttempted && !secret && <p className="warning-note">{request.action === 'site_invite.create' ? '本次邀请码已隐藏、到期或领取结果未知，不能再次领取。请核对交付情况；需要取消时在邀请码列表撤销。' : '本次凭据已隐藏、到期或读取结果未知，不能再次读取。请核对交付情况；确需重置时人工重新发起，新凭据会使旧凭据失效。'}</p>}    </section>}
    <button className="text-button" disabled={busy} onClick={onClose}>{command || unknown ? '关闭结果窗口' : '取消'}</button>
  </div></Modal>;
}
