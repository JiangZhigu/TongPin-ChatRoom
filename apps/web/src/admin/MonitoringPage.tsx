import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, APIError } from '../lib/api';
import type { AdminAlert, AdminMonitoring, AdminPage, AdminThresholds } from '../lib/admin-types';
import { ActionButton, AdminContext, bytesText, DataTable, dateText, EmptyRow, errorText, numberText, PageHeading, Pagination, statusText } from './AdminShared';
import { thresholdLabels } from './AdminActionDialog';

type LiveResource<T> = { data?: T; error?: string; receivedAt?: number };
type MonitorState = { key: string; pending: boolean; monitoring: LiveResource<AdminMonitoring>; alerts: LiveResource<AdminPage<AdminAlert>> };

function useLiveMonitoring(after: string) {
  const { deny, revision } = useContext(AdminContext); const key = `${revision}:${after}`;
  const [state, setState] = useState<MonitorState>({ key, pending: false, monitoring: {}, alerts: {} });
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true; let inFlight = false; let hasCompleted = false; let timer: number | undefined; let controller: AbortController | null = null;
    setState({ key, pending: false, monitoring: {}, alerts: {} });
    function schedule() { window.clearTimeout(timer); if (active && document.visibilityState === 'visible') timer = window.setTimeout(() => void refresh(), 10000); }
    async function refresh() {
      if (!active || inFlight || document.visibilityState !== 'visible') return;
      window.clearTimeout(timer); inFlight = true; controller = new AbortController(); const request = controller;
      setState((current) => ({ ...current, pending: true }));
      async function read<T>(path: string) {
        try { return await api<T>(path, { signal: request.signal }); }
        catch (cause) {
          if (active && !request.signal.aborted && cause instanceof APIError && (cause.status === 401 || cause.status === 403)) {
            active = false; request.abort(); window.clearTimeout(timer); setState({ key, pending: false, monitoring: {}, alerts: {} }); deny();
          }
          throw cause;
        }
      }
      const [monitorResult, alertResult] = await Promise.allSettled([
        read<AdminMonitoring>('/api/v1/admin/monitoring'),
        read<AdminPage<AdminAlert>>(`/api/v1/admin/alerts?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`),
      ]);
      if (!active || request.signal.aborted) return;
      const receivedAt = Date.now();
      function updated<T>(previous: LiveResource<T>, result: PromiseSettledResult<T>): LiveResource<T> { return result.status === 'fulfilled' ? { data: result.value, receivedAt } : { ...previous, error: errorText(result.reason) }; }
      // Keep the existing table nodes and data throughout a refresh, including failures.
      setState((current) => ({ key, pending: false, monitoring: updated(current.monitoring, monitorResult), alerts: updated(current.alerts, alertResult) }));
      inFlight = false; hasCompleted = true; schedule();
    }
    function visibilityChanged() { window.clearTimeout(timer); if (document.visibilityState === 'visible' && !inFlight) { if (hasCompleted) schedule(); else void refresh(); } }
    refreshRef.current = () => void refresh(); document.addEventListener('visibilitychange', visibilityChanged); void refresh();
    return () => { active = false; window.clearTimeout(timer); controller?.abort(); refreshRef.current = () => {}; document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [after, key, deny]);
  return { ...(state.key === key ? state : { key, pending: false, monitoring: {}, alerts: {} }), refresh: useCallback(() => refreshRef.current(), []) };
}

function Freshness({ title, resource, sampleAt, pending }: { title: string; resource: LiveResource<unknown>; sampleAt?: number | null; pending: boolean }) {
  return <>{resource.error && <p role="alert" className="form-error">{title}刷新失败：{resource.error} {resource.data ? `仍显示旧数据；上次成功读取 ${dateText(resource.receivedAt)}${sampleAt == null ? '' : `，旧样本时间 ${dateText(sampleAt)}`}。` : '尚无可用数据。'}请点击“刷新监控”重试。</p>}{resource.receivedAt !== undefined && <p className="admin-meta">{title}上次成功读取：{dateText(resource.receivedAt)}{pending ? ' · 正在核对更新，暂保留已有内容' : ''}</p>}{resource.data === undefined && !resource.error && <p role="status">{pending ? `正在读取${title}…` : `页面可见时开始读取${title}。`}</p>}</>;
}

function Alerts({ params, resource, pending }: { params: URLSearchParams; resource: LiveResource<AdminPage<AdminAlert>>; pending: boolean }) { return <><Freshness title="告警" resource={resource} pending={pending} />{resource.data && <><DataTable caption="告警与恢复记录" headings={['告警', '状态', '观测值 / 阈值', '首次 / 最近发生', '恢复时间']}>{resource.data.items.length ? resource.data.items.map((alert) => <tr key={alert.id}><th scope="row">{alert.title}</th><td><span className={`admin-badge ${alert.status}`}>{alert.status === 'active' ? '告警中' : statusText(alert.status)}</span></td><td>{numberText(alert.value)} / {numberText(alert.threshold)}</td><td>{dateText(alert.firstSeenAt)}<br />{dateText(alert.lastSeenAt)}</td><td>{alert.resolvedAt === null ? '尚未恢复' : dateText(alert.resolvedAt)}</td></tr>) : <EmptyRow count={5} />}</DataTable><Pagination page={resource.data} params={params} path="/admin/monitoring" /></>}</>; }
export function MonitoringPage({ params }: { params: URLSearchParams }) {
  const live = useLiveMonitoring(params.get('after') || ''); const resource = live.monitoring; const data = resource.data; const sample = data?.latest;
  const metrics: [string, string][] = sample ? [['CPU', `${numberText(sample.cpuPercent)}${sample.cpuPercent == null ? '' : '%'}`], ['进程内存', bytesText(sample.rssBytes)], ['线程', numberText(sample.threads)], ['HTTP 请求', numberText(sample.requests)], ['HTTP 4xx / 5xx', `${numberText(sample.clientErrors)} / ${numberText(sample.serverErrors)}`], ['HTTP P95', `${numberText(sample.latencyP95Ms)} ms`], ['WebSocket 请求 / 错误', `${numberText(sample.wsRequests)} / ${numberText(sample.wsErrors)}`], ['WebSocket P95', `${numberText(sample.wsLatencyP95Ms)} ms`], ['数据库等待 P95', `${numberText(sample.dbWaitP95Ms)} ms`], ['数据库写入 / 错误', `${numberText(sample.dbWrites)} / ${numberText(sample.dbWriteErrors)}`], ['运行时长', `${numberText(sample.uptimeSeconds)} 秒`]] : [];
  return <><PageHeading title="系统监控" description="进程每 10 秒采样，最多保留 720 点；页面可见时每轮读取完成后 10 秒更新，缺失采样显示未知。"><button className="secondary-button" onClick={live.refresh} disabled={live.pending}>刷新监控</button></PageHeading><Freshness title="监控" resource={resource} sampleAt={sample?.sampledAt ?? data?.sampledAt} pending={live.pending} />{data && <><p className="admin-meta">进程启动 {dateText(data.processStartedAt)} · 最近采样 {dateText(sample?.sampledAt)} · 策略版本 {data.policyVersion}</p>{sample ? <div className="admin-metrics">{metrics.map(([label, value]) => <article key={label}><h2>{label}</h2><strong>{value}</strong></article>)}</div> : <p className="warning-note">进程尚无采样，当前运行指标未知。</p>}<section className="admin-panel"><h2>存储与任务</h2><dl className="admin-facts">{([['磁盘总量', bytesText(data.storage.totalBytes)], ['磁盘可用', bytesText(data.storage.freeBytes)], ['磁盘使用率', `${numberText(data.storage.usedPercent)}%`], ['数据库', bytesText(data.storage.databaseBytes)], ['WAL', bytesText(data.storage.walBytes)], ['附件物理用量', bytesText(data.storage.attachmentBytes)], ['计费用量', bytesText(data.storage.chargedBytes)], ['任务等待 / 执行', `${data.queues.pending} / ${data.queues.running}`], ['任务完成 / 失败', `${data.queues.completed} / ${data.queues.failed}`], ['最早等待任务', dateText(data.queues.oldestPendingAt)]]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section><section className="admin-panel"><h2>采样历史</h2><DataTable caption="当前进程采样历史（最近在前）" headings={['时间', 'CPU %', '内存', 'HTTP P95 ms', '数据库等待 P95 ms']}>{data.samples.length ? [...data.samples].reverse().map((point) => <tr key={point.sampledAt}><th scope="row">{dateText(point.sampledAt)}</th><td>{numberText(point.cpuPercent)}</td><td>{bytesText(point.rssBytes)}</td><td>{numberText(point.latencyP95Ms)}</td><td>{numberText(point.dbWaitP95Ms)}</td></tr>) : <EmptyRow count={5} />}</DataTable></section><section className="admin-panel"><h2>告警阈值</h2><dl className="admin-facts">{(Object.keys(thresholdLabels) as (keyof AdminThresholds)[]).map((key) => <div key={key}><dt>{thresholdLabels[key]}</dt><dd>{numberText(data.thresholds[key])}</dd></div>)}</dl><ActionButton request={{ action: 'monitoring.thresholds', targetIds: ['instance'], labels: ['当前实例监控策略'], initial: { values: data.thresholds } }}>调整阈值</ActionButton></section></>}<section className="admin-panel"><h2>告警与恢复</h2><Alerts params={params} resource={live.alerts} pending={live.pending} /></section></>;
}
