import { useState } from 'react';
import type { AdminPage } from '../lib/admin-types';
import type { AdminAuditEvent, AdminRuntimeLog } from '../lib/admin-s3-types';
import { DataTable, dateText, EmptyRow, identityText, PageHeading, queryPath, ResourceState, useResource } from './AdminShared';

export const auditFilterFields = [['actorId', '发起账号 ID'], ['subjectId', '对象 ID'], ['action', '动作'], ['result', '结果'], ['requestId', '请求 ID'], ['jobId', '任务 ID']] as const;
export function AuditPage() {
  const [tab, setTab] = useState<'audit' | 'logs'>('audit'); const [filters, setFilters] = useState<Record<string, string>>({}); const [after, setAfter] = useState('');
  const resource = useResource<AdminPage<AdminAuditEvent | AdminRuntimeLog>>(queryPath(`/api/v1/admin/${tab}`, { ...filters, after, limit: '50' }));
  return <><PageHeading title="审计与运行日志" description="审计保留当前 180 天；运行日志保留 30 天且最多 10,000 条，仅采集脱敏错误与关联 ID。" />
    <div className="page-tabs"><button aria-pressed={tab === 'audit'} onClick={() => { setTab('audit'); setFilters({}); setAfter(''); }}>管理审计</button><button aria-pressed={tab === 'logs'} onClick={() => { setTab('logs'); setFilters({}); setAfter(''); }}>运行日志</button></div>
    <form key={tab} className="admin-s3-form admin-panel" onSubmit={(event) => { event.preventDefault(); const next: Record<string, string> = {}; for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === 'string' && value.trim()) next[key] = key === 'fromAt' || key === 'until' ? String(new Date(value).getTime()) : value.trim(); setFilters(next); setAfter(''); }}>
      {(tab === 'audit' ? auditFilterFields : auditFilterFields.filter(([key]) => ['requestId', 'jobId'].includes(key))).map(([key, label]) => <label key={key}>{label}<input name={key} /></label>)}
      {tab === 'logs' && <label>日志级别<select name="level"><option value="">全部</option><option value="warning">警告</option><option value="error">错误</option></select></label>}
      <label>开始时间<input name="fromAt" type="datetime-local" /></label><label>结束时间<input name="until" type="datetime-local" /></label><button className="primary-button">筛选记录</button>
    </form><ResourceState {...resource} />{resource.data && <><DataTable caption={tab === 'audit' ? '管理审计记录' : '脱敏运行日志'} headings={['时间', '动作 / 错误', '发起者 / 对象', '结果', '详情']}>{resource.data.items.length ? resource.data.items.map((item) => <tr key={item.id}><th scope="row">{dateText(item.createdAt)}</th><td>{'action' in item ? item.action : item.code}</td><td>{'actor' in item ? <>{item.actor ? identityText(item.actor) : '系统'}<br />{item.subjectId}</> : item.actorId || '系统'}</td><td>{'result' in item ? item.result : `${item.level} / ${item.status ?? '未知'}`}</td><td><details><summary>查看记录 {item.id}</summary>{'reason' in item && <><p className="admin-preserve-text">理由：{item.reason}</p><p>设备：{item.device}</p><pre className="admin-json">{JSON.stringify(item.details, null, 2)}</pre></>}{'route' in item && <p>路由模板：{item.route}</p>}<p>请求 ID：{item.requestId || '无'}</p><p>任务 ID：{item.jobId || '无'}</p></details></td></tr>) : <EmptyRow count={5} />}</DataTable><p>共 {resource.data.total} 条。空列表表示当前筛选和采集范围内没有记录。</p><div className="admin-actions">{after && <button className="secondary-button" onClick={() => setAfter('')}>记录首页</button>}{resource.data.nextCursor && <button className="secondary-button" onClick={() => setAfter(resource.data!.nextCursor!)}>下一页记录</button>}<button className="secondary-button" onClick={resource.retry}>刷新记录</button></div></>}
  </>;
}
