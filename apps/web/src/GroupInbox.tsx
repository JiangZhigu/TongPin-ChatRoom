import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import type { Page } from './lib/chat-types';
import type { GroupApplication, GroupInvite } from './lib/group-types';
import { applicationLabel } from './GroupInviteEntry';

// A display-only paginated resource; aborted requests cannot replace a new page.
export function useGroupPage<T>(path: string | null, revision: number) {
  const [items, setItems] = useState<T[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0); const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (after?: string) => {
    if (!path) return; controller.current?.abort(); const request = new AbortController(); controller.current = request; setBusy(true); setError('');
    try { const page = await api<Page<T>>(`${path}${after ? `?after=${encodeURIComponent(after)}` : ''}`, { signal: request.signal }); if (!request.signal.aborted) { const key = (item: T) => { const record = item as { id?: string; periodId?: string }; return record.id || record.periodId; }; setItems((previous) => after ? [...previous, ...page.items.filter((item) => !previous.some((old) => key(old) === key(item)))] : page.items); setCursor(page.nextCursor); } }
    catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败，请重试。'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }, [path]);
  useEffect(() => { setItems([]); setCursor(null); setError(''); if (path) void load(); return () => controller.current?.abort(); }, [path, revision, retry, load]);
  return { items, cursor, busy, error, more: () => { if (cursor) void load(cursor); }, retry: () => { if (cursor && items.length) void load(cursor); else setRetry((value) => value + 1); } };
}

export function GroupPageStatus({ page }: { page: Pick<ReturnType<typeof useGroupPage>, 'busy' | 'error' | 'cursor' | 'more' | 'retry'> }) {
  return <>{page.error && <p className="form-error" role="alert">{page.error}<button className="text-button" onClick={page.retry}>重试加载</button></p>}{page.busy && <p role="status">正在加载…</p>}{page.cursor && <button className="load-more-button" disabled={page.busy} onClick={page.more}>加载更多</button>}</>;
}

export function GroupInbox({ onRefresh, onOpenGroup }: { onRefresh: () => Promise<void>; onOpenGroup: (id: string) => Promise<void> }) {
  const [tab, setTab] = useState<'invitations' | 'applications'>('invitations'); const [revision, setRevision] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const attempts = useRef(new Map<string, string>());
  const invites = useGroupPage<GroupInvite>(tab === 'invitations' ? '/api/v1/group-invites/mine' : null, revision);
  const applications = useGroupPage<GroupApplication>(tab === 'applications' ? '/api/v1/group-applications/mine' : null, revision);
  async function act(action: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await action(); await onRefresh(); setRevision((value) => value + 1); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); } finally { setBusy(false); } }
  async function apply(invite: GroupInvite) { let id = attempts.current.get(invite.id); if (!id) { id = crypto.randomUUID(); attempts.current.set(invite.id, id); } const result = await api<GroupApplication>(`/api/v1/group-invites/${encodeURIComponent(invite.id)}/apply`, { method: 'POST', body: { clientRequestId: id } }); setNotice(`${applicationLabel(result.status)}。请在“我的入群申请”查看进度。`); }
  return <section className="group-inbox" aria-label="群邀请与申请"><h2>群邀请与申请</h2><div className="page-tabs"><button aria-pressed={tab === 'invitations'} onClick={() => setTab('invitations')}>收到的群邀请</button><button aria-pressed={tab === 'applications'} onClick={() => setTab('applications')}>我的入群申请</button></div><p className="field-hint">加入需要你本人确认；加入后只可查看本次加入之后的消息。</p>{error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}{tab === 'invitations' ? <><ul className="group-record-list">{invites.items.map((invite) => <li key={invite.id}><div><strong>{invite.groupName}</strong><p>{invite.creator.nickname} 邀请你加入 · {invite.remaining} 个可用名额</p><small>有效期至 {new Date(invite.expiresAt).toLocaleString('zh-CN')}</small><p>{({ available: '可以申请加入', expired: '已过期', revoked: '已撤销', exhausted: '名额已用完', full: '群已满员', unavailable: '邀请不可用' })[invite.state]}</p></div>{invite.state === 'available' && <button className="secondary-button" disabled={busy} onClick={() => void act(() => apply(invite))}>确认申请加入</button>}</li>)}</ul>{!invites.items.length && !invites.busy && !invites.error && <p>暂时没有收到群邀请。</p>}<GroupPageStatus page={invites} /></> : <><ul className="group-record-list">{applications.items.map((item) => <li key={item.id || item.inviteId}><div><strong>{item.groupName}</strong><p>{applicationLabel(item.status)}{item.status === 'approved' && !item.currentMember ? '，当前已不在群中' : ''}</p><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><div className="group-actions">{item.currentMember && <button className="secondary-button" disabled={busy} onClick={() => void act(() => onOpenGroup(item.conversationId))}>打开群聊</button>}{item.status === 'pending' && item.id && <button className="text-button" disabled={busy} onClick={() => void act(async () => { const result = await api<GroupApplication>(`/api/v1/group-applications/${encodeURIComponent(item.id!)}/cancel`, { method: 'POST', body: {} }); setNotice(applicationLabel(result.status)); })}>取消申请</button>}</div></li>)}</ul>{!applications.items.length && !applications.busy && !applications.error && <p>还没有入群申请记录。</p>}<GroupPageStatus page={applications} /></>}<button className="text-button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>刷新群邀请与申请</button></section>;
}
