import { useRef, useState } from 'react';
import { api, APIError } from './lib/api';
import type { Contact } from './lib/chat-types';
import type { GroupDetail } from './lib/group-types';
import { Modal } from './components/Modal';

export function CreateGroupDialog({ friends, hasMore, onLoadMore, onClose, onCreated }: { friends: Contact[]; hasMore: boolean; onLoadMore: () => Promise<void>; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [submitted, setSubmitted] = useState(false);
  const attempt = useRef<{ clientRequestId: string; name: string; description: string; friendUserIds: string[] } | null>(null); const created = useRef<string | null>(null);
  async function create() {
    if (busy) return; setBusy(true); setError('');
    try {
      if (!created.current) {
        attempt.current ??= { clientRequestId: crypto.randomUUID(), name: name.trim(), description: description.trim(), friendUserIds: selected };
        setSubmitted(true);
        const result = await api<GroupDetail>('/api/v1/groups', { method: 'POST', body: attempt.current }); created.current = result.conversation.id;
      }
      await onCreated(created.current); onClose();
    } catch (cause) { if (!created.current && cause instanceof APIError && [400, 403, 422].includes(cause.status)) { attempt.current = null; setSubmitted(false); } setError(cause instanceof Error ? cause.message : '创建未完成，请重试确认同一次创建的结果。'); }
    finally { setBusy(false); }
  }
  return <Modal open title="创建群聊" onClose={onClose} dismissible={!busy}><form onSubmit={(event) => { event.preventDefault(); void create(); }} className="group-form"><p>只有你先成为群主。选中的好友会收到邀请，需要本人确认；默认加入审核开启。</p><fieldset disabled={busy || submitted}><label>群名称<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label><label>群简介<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} /></label><legend>邀请好友（可选，最多 20 位）</legend><div className="group-friend-picker">{friends.filter((friend) => friend.relationship === 'friend' && !friend.blocked).map((friend) => <label className="group-check" key={friend.id}><input type="checkbox" checked={selected.includes(friend.id)} disabled={!selected.includes(friend.id) && selected.length >= 20} onChange={(event) => setSelected((current) => event.target.checked ? [...current, friend.id] : current.filter((id) => id !== friend.id))} /><span>{friend.nickname}<small>@{friend.username}</small></span></label>)}{!friends.length && <p>还没有可邀请的好友，也可以先创建群聊。</p>}</div></fieldset>{hasMore && <button type="button" className="text-button" disabled={busy || submitted} onClick={() => { setBusy(true); void onLoadMore().catch((cause) => setError(cause instanceof Error ? cause.message : '好友加载失败')).finally(() => setBusy(false)); }}>加载更多好友</button>}{error && <p className="form-error" role="alert">{error}</p>}{submitted && !created.current && <p className="field-hint">表单已锁定。重试会确认同一次创建，不会生成新的创建请求。</p>}<button className="primary-button" disabled={busy || !name.trim()}>{busy ? '正在创建并同步…' : submitted ? '重试并确认创建结果' : '创建群聊'}</button></form></Modal>;
}
