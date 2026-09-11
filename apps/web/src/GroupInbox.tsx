import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import type { Page } from './lib/chat-types';
import type { GroupApplication, GroupInvite } from './lib/group-types';
import { applicationLabel } from './GroupInviteEntry';

// A display-only paginated resource; aborted requests cannot replace a new page.
export function useGroupPage<T>(path: string | null, revision: number) {
  const [items, setItems] = useState<T[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0); const controller = useRef<AbortController | null>(null);
  const loadedPages = useRef(0);
  const load = useCallback(async (after?: string) => {
    if (!path) return; controller.current?.abort(); const request = new AbortController(); controller.current = request; setBusy(true); setError('');
    try { const page = await api<Page<T>>(`${path}${after ? `?after=${encodeURIComponent(after)}` : ''}`, { signal: request.signal }); if (!request.signal.aborted) { const key = (item: T) => { const record = item as { id?: string; periodId?: string }; return record.id || record.periodId; }; setItems((previous) => after ? [...previous, ...page.items.filter((item) => !previous.some((old) => key(old) === key(item)))] : page.items); setCursor(page.nextCursor); loadedPages.current = after ? loadedPages.current + 1 : 1; } }
    catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败，请重试。'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }, [path]);
  const revalidate = useCallback(async () => {
    if (!path) return;
    const depth = Math.max(1, loadedPages.current); controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setItems([]); setCursor(null); setBusy(true); setError('');
    try {
      const refreshed: T[] = []; const seen = new Set<string>(); let next: string | null = null; let count = 0;
      do {
        const page: Page<T> = await api<Page<T>>(`${path}${next ? `?after=${encodeURIComponent(next)}` : ''}`, { signal: request.signal });
        if (request.signal.aborted) return;
        for (const item of page.items) { const record = item as { id?: string; periodId?: string }; const key = record.id || record.periodId; if (!key || !seen.has(key)) { refreshed.push(item); if (key) seen.add(key); } }
        next = page.nextCursor; count++;
      } while (next && count < depth);
      setItems(refreshed); setCursor(next); loadedPages.current = count;
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败，请重试。'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }, [path]);
  useEffect(() => { loadedPages.current = 0; setItems([]); setCursor(null); setError(''); if (path) void load(); return () => controller.current?.abort(); }, [path, revision, retry, load]);
  return { items, cursor, busy, error, revalidate, more: () => { if (cursor) void load(cursor); }, retry: () => { if (cursor && items.length) void load(cursor); else setRetry((value) => value + 1); } };
}

export function GroupPageStatus({ page }: { page: Pick<ReturnType<typeof useGroupPage>, 'busy' | 'error' | 'cursor' | 'more' | 'retry'> }) {
  return <>{page.error && <p className="form-error" role="alert">{page.error}<button className="text-button" onClick={page.retry}>重试加载</button></p>}{page.busy && <p role="status">正在加载…</p>}{page.cursor && <button className="load-more-button" disabled={page.busy} onClick={page.more}>加载更多</button>}</>;
}

type DirectInviteAttempt = { clientRequestId: string; uncertain: boolean; result: GroupApplication | null; sourceInvite: GroupInvite; authority: number };
export type GroupInboxEvents = (listener: (event: { type: string; entityRef: string; conversationId: string | null }) => void) => () => void;
const applicationText = (application: GroupApplication) => application.currentMember ? '你已是群成员' : ['approved', 'already_member'].includes(application.status) ? '此前已加入群聊，当前已不在群中' : applicationLabel(application.status);

export function GroupInbox({ onRefresh, onOpenGroup, subscribeGroupEvents }: { onRefresh: () => Promise<void>; onOpenGroup: (id: string) => Promise<void>; subscribeGroupEvents?: GroupInboxEvents }) {
  const [tab, setTab] = useState<'invitations' | 'applications'>('invitations');
  const [revision, setRevision] = useState(0); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [attempts, setAttempts] = useState(() => new Map<string, DirectInviteAttempt>());
  const active = useRef(false);
  const authority = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const invites = useGroupPage<GroupInvite>(tab === 'invitations' ? '/api/v1/group-invites/mine' : null, revision);
  const applications = useGroupPage<GroupApplication>(tab === 'applications' ? '/api/v1/group-applications/mine' : null, revision);
  useEffect(() => subscribeGroupEvents?.((event) => {
    if (!['access.revoked', 'conversation.updated', 'account.changed', 'task.resync'].includes(event.type)) return;
    authority.current++; setNotice('');
    void invites.revalidate(); void applications.revalidate();
  }), [subscribeGroupEvents, invites.revalidate, applications.revalidate]);

  async function act(action: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); if (!active.current) return; await onRefresh(); if (active.current) setRevision((value) => value + 1); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { if (active.current) setBusy(false); }
  }
  async function apply(invite: GroupInvite, newRequest = false) {
    const previous = attempts.get(invite.id);
    const operationAuthority = authority.current;
    // Unknown writes retain their key through page/tab refreshes. A confirmed
    // terminal outcome gets a new key only via the explicit reapply action.
    const clientRequestId = previous?.uncertain ? previous.clientRequestId : newRequest || invite.application === null ? crypto.randomUUID() : previous?.clientRequestId || crypto.randomUUID();
    setAttempts((current) => new Map(current).set(invite.id, { clientRequestId, uncertain: true, result: null, sourceInvite: invite, authority: operationAuthority }));
    const result = await api<GroupApplication>(`/api/v1/group-invites/${encodeURIComponent(invite.id)}/apply`, { method: 'POST', body: { clientRequestId } });
    if (!active.current) return;
    setAttempts((current) => new Map(current).set(invite.id, { clientRequestId, uncertain: false, result, sourceInvite: invite, authority: operationAuthority }));
    setNotice('申请操作已确认，当前状态以下方记录为准。');
  }
  function changeTab(next: typeof tab) { setTab(next); setNotice(''); setError(''); }
  function refresh() { setNotice(''); setError(''); setRevision((value) => value + 1); }

  return <section className="group-inbox" aria-label="群邀请与申请">
    <h2>群邀请与申请</h2>
    <div className="page-tabs"><button aria-pressed={tab === 'invitations'} onClick={() => changeTab('invitations')}>收到的群邀请</button><button aria-pressed={tab === 'applications'} onClick={() => changeTab('applications')}>我的入群申请</button></div>
    <p className="field-hint">加入需要你本人确认；加入后只可查看本次加入之后的消息。</p>
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {tab === 'invitations' ? <>
      <ul className="group-record-list">{invites.items.map((invite) => {
        const attempt = attempts.get(invite.id);
        // Undefined is compatibility with a response that predates this field;
        // authoritative null must clear the known application, never fall back.
        const currentAttempt = attempt?.authority === authority.current ? attempt : undefined;
        const application = currentAttempt && !currentAttempt.uncertain && currentAttempt.sourceInvite === invite ? currentAttempt.result : invite.application === undefined ? currentAttempt?.result : invite.application;
        const member = !!application?.currentMember;
        const terminal = application && !member && application.status !== 'pending';
        return <li key={invite.id}>
          <div><strong>{invite.groupName}</strong><p>{invite.creator.nickname} 邀请你加入 · {invite.remaining} 个可用名额</p><small>有效期至 {new Date(invite.expiresAt).toLocaleString('zh-CN')}</small>
            <p>{member ? '当前已加入群聊' : ({ available: '邀请有效', expired: '已过期', revoked: '已撤销', exhausted: '名额已用完', full: '群已满员', unavailable: '邀请不可用' })[invite.state]}</p>
            {application && !attempt?.uncertain && <p>{applicationText(application)}</p>}
            {attempt?.uncertain && <p>上次申请结果尚未确认，刷新或切换页面不会创建新申请。</p>}
          </div>
          {member ? <button className="secondary-button" disabled={busy} onClick={() => void act(() => onOpenGroup(invite.conversationId))}>打开群聊</button>
            : attempt?.uncertain ? <button className="secondary-button" disabled={busy} onClick={() => void act(() => apply(invite))}>重试同一次申请</button>
            : invite.state === 'available' && terminal ? <button className="secondary-button" disabled={busy} onClick={() => void act(() => apply(invite, true))}>再次申请加入</button>
            : invite.state === 'available' && !application ? <button className="secondary-button" disabled={busy} onClick={() => void act(() => apply(invite))}>确认申请加入</button> : null}
        </li>;
      })}</ul>
      {!invites.items.length && !invites.busy && !invites.error && <p>暂时没有收到群邀请。</p>}<GroupPageStatus page={invites} />
    </> : <>
      <ul className="group-record-list">{applications.items.map((item) => <li key={item.id || item.inviteId}>
        <div><strong>{item.groupName}</strong><p>{applicationText(item)}</p><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div>
        <div className="group-actions">{item.currentMember && <button className="secondary-button" disabled={busy} onClick={() => void act(() => onOpenGroup(item.conversationId))}>打开群聊</button>}
          {item.status === 'pending' && item.id && <button className="text-button" disabled={busy} onClick={() => void act(async () => { const result = await api<GroupApplication>(`/api/v1/group-applications/${encodeURIComponent(item.id!)}/cancel`, { method: 'POST', body: {} }); setNotice(applicationLabel(result.status)); })}>取消申请</button>}
        </div>
      </li>)}</ul>
      {!applications.items.length && !applications.busy && !applications.error && <p>还没有入群申请记录。</p>}<GroupPageStatus page={applications} />
    </>}
    <button className="text-button" disabled={busy} onClick={refresh}>刷新群邀请与申请</button>
  </section>;
}
