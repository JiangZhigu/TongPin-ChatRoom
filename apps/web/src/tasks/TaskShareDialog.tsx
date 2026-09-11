import { MoreTaskConversations, type TaskConversationPaging } from './TaskShared';
import { useState } from 'react';
import { Modal } from '../components/Modal';
import type { Contact, Conversation } from '../lib/chat-types';
import type { TaskClient } from '../lib/tasks-client';
import type { Task, TaskShareResult } from '../lib/tasks-types';
import { CommandFeedback, priorityLabels, TaskConflict, TaskLoadState, TaskUnavailable, useGroupMembers, useTaskCommand, useTaskState } from './TaskShared';

type TaskShareProps = { client: TaskClient; task: Task; conversations: Conversation[]; contacts: Contact[]; onClose: () => void } & TaskConversationPaging;
export function TaskShareDialog(props: TaskShareProps) { return <ShareDialog key={`${props.client.userId}:${props.task.id}`} {...props} />; }
function ShareDialog({ client, task, conversations, contacts, onClose, ...paging }: TaskShareProps) {
  const state = useTaskState(client); const current = state.entities[task.id]; const command = useTaskCommand(client); const [base, setBase] = useState(task); const [destination, setDestination] = useState(''); const [includeDescription, setIncludeDescription] = useState(false); const [confirmed, setConfirmed] = useState(false); const [receipt, setReceipt] = useState<TaskShareResult | null>(null);
  const members = useGroupMembers(task.groupId, client.userId, task.scope === 'group' && state.online);
  if (!current || state.invalid[task.id] || current.viewerId !== client.userId) return <Modal open title="分享待办" onClose={onClose}><TaskUnavailable onClose={onClose} /></Modal>;
  const live = current.scope === 'group'; const memberIds = new Set(members.members.map((item) => item.user.id)); const friends = new Set(contacts.filter((item) => item.relationship === 'friend' && !item.blocked).map((item) => item.id));
  const destinations = conversations.filter((item) => item.canSend && (!live || item.id === current.groupId || (item.kind === 'direct' && item.peer && friends.has(item.peer.id) && memberIds.has(item.peer.id))));
  const payload = { destinationConversationId: destination, mode: live ? 'live' as const : 'snapshot' as const, includeDescription: !live && includeDescription };
  return <Modal open title={live ? '发送群待办实时引用' : '分享个人待办静态副本'} dismissible={!command.busy} onClose={onClose}><div className="task-share-dialog">
    {receipt ? <section role="status"><h3>卡片消息已发送</h3><p>服务器已确认消息 {receipt.messageId}。任务状态和消息已读是两件独立的事。</p><p>会话：{receipt.conversationId}</p></section> : <form onSubmit={(event) => { event.preventDefault(); if (command.busy || !confirmed || !state.online || !current.capabilities.share || !destinations.some((item) => item.id === destination)) return; void command.run(JSON.stringify({ id: base.id, etag: base.etag, payload }), (key) => client.share(base, payload, key), base.id).then((result) => { if (result.ok) setReceipt(result.value); }); }}>
      <p className="warning-note">{live ? '实时引用不会授予访问权。仅能发送到本群，或与当前同群好友的私聊；退群后旧卡片将不可用。' : '此副本是消息发送时的静态内容。原待办继续保持私密，后续修改或删除不会同步到副本。'}</p>
      <section className="task-share-preview" aria-label="分享内容预览"><span className="task-scope">{live ? '群待办 · 实时引用' : '个人待办 · 静态副本'}</span><h3>{current.title}</h3><p>优先级：{priorityLabels[current.priority]} · 截止：{current.dueOn || '无'} {current.dueOn ? current.dueTimezone : ''}</p>{!live && includeDescription && <p className="task-description">{current.description || '无描述'}</p>}{!live && <p>不包含原任务 ID、来源、检查项或评论，也不提供查看原任务入口。</p>}</section>
      <fieldset disabled={command.busy || command.unknown || !current.capabilities.share}>{!live && <label className="task-check"><input type="checkbox" checked={includeDescription} onChange={(event) => { setIncludeDescription(event.target.checked); setConfirmed(false); }} />在静态副本中包含描述</label>}
      <label className="form-field">发送到会话<select required value={destination} onChange={(event) => { setDestination(event.target.value); setConfirmed(false); }}><option value="">选择当前可发送的会话</option>{destinations.map((item) => <option key={item.id} value={item.id}>{item.title}{item.kind === 'group' ? '（群）' : '（私聊）'}</option>)}</select></label>
      {live && <><TaskLoadState {...members} />{members.next && <button type="button" className="text-button" disabled={members.loading} onClick={members.more}>继续核对群成员，显示更多同群好友私聊</button>}<p className="task-hint">私聊候选仅包含已核对的当前群成员与好友交集；未出现在当前会话列表的目标需先返回聊天打开会话。</p></>}
      <MoreTaskConversations {...paging} /><label className="task-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对以上内容和接收会话，确认发送{live ? '实时引用' : '静态副本'}</label></fieldset>
      {!current.capabilities.share && <p className="warning-note">{current.capabilities.writeReason || '当前不能分享此待办。'}</p>}<CommandFeedback {...command} />{command.conflict && <TaskConflict latest={command.conflict} draft={{ title: base.title, description: includeDescription ? base.description : '', dueOn: base.dueOn, priority: base.priority }} onAccept={() => { setBase(command.conflict!); setConfirmed(false); command.clear(); }} />}<button className="primary-button" disabled={!state.online || !confirmed || !destination || command.busy || !!command.conflict || !current.capabilities.share}>{command.busy ? '正在发送卡片…' : command.unknown ? '以同一编号核对卡片发送' : '确认发送卡片'}</button><p className="task-hint">分享失败不会重新创建待办；重试只处理本次卡片消息。</p>
    </form>}<button className="text-button" disabled={command.busy} onClick={onClose}>关闭</button>
  </div></Modal>;
}
