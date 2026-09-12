import { MoreTaskConversations, type TaskConversationPaging } from './TaskShared';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import type { Conversation } from '../lib/chat-types';
import type { TaskClient } from '../lib/tasks-client';
import type { Task, TaskCreate, TaskDraft, TaskFields, TaskMeta, TaskPatch, TaskSnapshot } from '../lib/tasks-types';
import { AssignmentPicker, TaskFieldsEditor, useCreationPolicy } from './TaskFieldsEditor';
import { CommandFeedback, TaskConflict, taskError, TaskLoadState, TaskUnavailable, useTaskCommand, useTaskState } from './TaskShared';

export type TaskSourcePreview = { messageId: string; conversationId: string; text: string; available?: boolean; revision?: number };
export type TaskFormProps = { client: TaskClient; userId: string; conversations: Conversation[]; meta: TaskMeta; task?: Task; mode?: 'create' | 'edit' | 'copy'; initialGroupId?: string; source?: TaskSourcePreview; onRefreshSource?: () => void; snapshot?: { messageId: string; value: TaskSnapshot }; draft?: TaskDraft; onSaved: (task: Task) => void; onClose: () => void; onDraftSaved?: () => void } & TaskConversationPaging;
const fromTask = (task: Task): TaskFields => ({ title: task.title, description: task.description, priority: task.priority, dueOn: task.dueOn, dueTimezone: task.dueTimezone, assigneeId: task.assignee?.id || null, listId: task.listId, tagIds: task.tagIds });
export function TaskForm(props: TaskFormProps) { return <Form key={`${props.userId}:${props.task?.id || props.draft?.id || 'new'}:${props.mode || ''}`} {...props} />; }
function Form({ client, userId, conversations, meta, task, mode = task ? 'edit' : 'create', initialGroupId, source, onRefreshSource, snapshot, draft, onSaved, onClose, onDraftSaved, ...paging }: TaskFormProps) {
  const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const state = useTaskState(client); const command = useTaskCommand(client); const [base, setBase] = useState(task);
  const draftCreate = draft?.kind === 'create' ? draft.payload as TaskCreate : undefined;
  const [scope, setScope] = useState<'personal' | 'group'>(mode === 'copy' ? 'group' : task?.scope || draftCreate?.scope || (initialGroupId ? 'group' : 'personal'));
  const [groupId, setGroupId] = useState(mode === 'copy' ? initialGroupId || '' : task?.groupId || draftCreate?.groupId || initialGroupId || '');
  const [fields, setFields] = useState<TaskFields>(() => ({ ...(task ? fromTask(task) : { title: snapshot?.value.title || '', description: snapshot?.value.description || '', priority: snapshot?.value.priority || 'normal', dueOn: snapshot?.value.dueOn || null, dueTimezone: snapshot?.value.dueTimezone || meta.preferences.timezone, assigneeId: userId, listId: null, tagIds: [] }), ...draft?.payload, ...(mode === 'copy' ? { assigneeId: userId, listId: null, tagIds: [] } : {}) }));
  const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [savingDraft, setSavingDraft] = useState(false); const [draftId, setDraftId] = useState(draft?.id); const [saved, setSaved] = useState<Task | null>(null); const [cleanupError, setCleanupError] = useState('');
  const sourceUnavailable = !!source && source.available !== true;
  useEffect(() => { setConfirmed(false); }, [source?.messageId, source?.revision, source?.available]);
  const current = task ? state.entities[task.id] : undefined; const unavailable = !!task && (!current || state.invalid[task.id] || current.viewerId !== userId);
  const policy = useCreationPolicy(client, scope === 'group' ? groupId || null : null, state.online && (mode === 'create' || mode === 'copy'));
  const sourceGroup = source ? conversations.find((item) => item.id === source.conversationId && item.kind === 'group') : undefined;
  const group = conversations.find((item) => item.id === groupId && item.kind === 'group');
  const allowOthers = mode === 'edit' ? !!current?.capabilities.assign : !!policy.data?.canManage;
  const currentPermission = mode === 'edit' ? !!current?.capabilities.edit : mode === 'copy' ? !!current?.capabilities.copyToGroup : true;
  const creationPermission = mode === 'edit' ? true : scope === 'group' ? !!policy.data?.canCreate : meta.canCreatePersonal;
  const reason = mode === 'edit' ? current?.capabilities.writeReason : scope === 'group' ? policy.data?.writeReason : meta.writeReason;
  const locked = command.busy || command.unknown || savingDraft || !!saved;
  const taskTitle = mode === 'copy' ? '创建群副本' : mode === 'edit' ? '编辑待办' : snapshot ? '将静态副本存为我的待办' : source ? '从消息创建待办' : '新建待办';
  function data(): TaskCreate | TaskPatch {
    const common: TaskFields = { title: fields.title.trim(), description: fields.description, priority: fields.priority, dueOn: fields.dueOn || null, dueTimezone: fields.dueTimezone.trim(), assigneeId: scope === 'personal' ? userId : fields.assigneeId };
    if (scope === 'personal' && meta.enhanced) { common.listId = fields.listId || null; common.tagIds = fields.tagIds || []; }
    if (mode === 'edit' && base) {
      const old = fromTask(base); const patch: TaskPatch = {};
      for (const key of Object.keys(common) as (keyof TaskFields)[]) if ((key !== 'assigneeId' || current?.capabilities.assign) && JSON.stringify(common[key]) !== JSON.stringify(old[key])) Object.assign(patch, { [key]: common[key] });
      return patch;
    }
    return { ...common, scope, groupId: scope === 'group' ? groupId : null, ...(source ? { sourceMessageId: source.messageId } : draftCreate?.sourceMessageId ? { sourceMessageId: draftCreate.sourceMessageId } : {}), ...(snapshot ? { snapshotMessageId: snapshot.messageId } : draftCreate?.snapshotMessageId ? { snapshotMessageId: draftCreate.snapshotMessageId } : {}) };
  }
  function validate() {
    if (sourceUnavailable) return '来源消息当前不可用，请重新核对。';
    if ([...fields.title.trim()].length < 1 || [...fields.title.trim()].length > 120) return '标题须为 1–120 个字符。';
    if ([...fields.description].length > 4000 || new TextEncoder().encode(fields.description).byteLength > 16384) return '描述不能超过 4,000 个字符或 16 KiB。';
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: fields.dueTimezone.trim() }).format(); } catch { return '请输入有效的任务时区，例如 Asia/Shanghai。'; }
    if (scope === 'group' && !groupId) return '请选择当前群。';
    if ((mode === 'copy' || source || snapshot || draftCreate?.sourceMessageId || draftCreate?.snapshotMessageId) && !confirmed) return '请先核对来源或共享范围并确认。';
    return '';
  }
  async function submit() {
    if (command.busy || savingDraft || saved || !state.online || !currentPermission || !creationPermission || unavailable || sourceUnavailable) return;
    if (draft && draft.expiresAt <= Date.now()) { setError('此草稿已过期，不能直接提交。请返回草稿列表确认建立新草稿。'); return; }
    const issue = validate(); setError(issue); if (issue) return;
    const payload = data(); if (mode === 'edit' && !Object.keys(payload).length) { setError('尚未修改任何字段。'); return; }
    const fingerprint = JSON.stringify({ mode, id: base?.id, etag: base?.etag, payload });
    const result = await command.run(fingerprint, (key) => mode === 'edit' ? client.patch(base!, payload, key) : mode === 'copy' ? client.copyToGroup(base!, { title: fields.title.trim(), description: fields.description, priority: fields.priority, dueOn: fields.dueOn, dueTimezone: fields.dueTimezone.trim(), assigneeId: fields.assigneeId, groupId, acknowledgeShared: true }, key) : client.create(payload as TaskCreate, key), base?.id);
    if (!result.ok) return; setSaved(result.value); setNotice('');
    if (draftId) { try { await client.deleteDraft(draftId); if (mounted.current) onDraftSaved?.(); } catch (cause) { if (mounted.current) setCleanupError(`服务器已保存，但旧本机草稿尚未删除：${taskError(cause)}。请在草稿列表删除旧条目，勿再次提交。`); } }
  }
  async function saveDraft() {
    if (locked || unavailable || mode === 'copy') return; setSavingDraft(true); setError(''); setNotice('');
    try { const savedDraft = await client.saveDraft({ ...(draftId ? { id: draftId } : {}), kind: mode === 'edit' ? 'edit' : 'create', taskId: mode === 'edit' ? base!.id : null, baseEtag: mode === 'edit' ? base!.etag : null, payload: data() }); if (!mounted.current) return; setDraftId(savedDraft.id); setNotice('已保存本机任务草稿，尚未提交。联网后须重新核对身份、权限及最新版本，并由你确认提交。'); onDraftSaved?.(); }
    catch (cause) { if (mounted.current) setError(taskError(cause)); } finally { if (mounted.current) setSavingDraft(false); }
  }
  if (unavailable || client.userId !== userId || meta.actorId !== userId) return <Modal open title="待办不可用" onClose={onClose}><TaskUnavailable onClose={onClose} /></Modal>;
  return <Modal open title={taskTitle} dismissible={!command.busy && !savingDraft} onClose={onClose}><div className="task-form-dialog">
    {saved ? <section role="status"><h3>{mode === 'edit' ? '待办修改已保存' : mode === 'copy' ? '新的群待办已创建' : '待办已创建'}</h3><p>{mode === 'copy' ? '原个人待办仍为私密实体。新群待办可由当前及未来成员读取。' : '服务器已确认保存。此步骤没有向聊天发送卡片。'}</p>{cleanupError && <p className="task-error">{cleanupError}</p>}<button className="primary-button" onClick={() => onSaved(saved)}>查看已保存待办</button></section> : <>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {mode !== 'edit' && <fieldset className="task-form-fields" disabled={locked}><label className="form-field">可见范围<select value={scope} disabled={mode === 'copy' || !!snapshot || !!draftCreate?.snapshotMessageId} onChange={(event) => { setScope(event.target.value as typeof scope); if (sourceGroup && event.target.value === 'group') setGroupId(sourceGroup.id); setFields({ ...fields, assigneeId: userId, listId: null, tagIds: [] }); setConfirmed(false); }}><option value="personal">个人 · 仅自己可见</option>{(!source || sourceGroup) && <option value="group">群共享</option>}</select></label>{scope === 'group' && <label className="form-field">所属群<select required value={groupId} onChange={(event) => { setGroupId(event.target.value); setFields({ ...fields, assigneeId: userId }); setConfirmed(false); }}><option value="">选择当前群</option>{conversations.filter((item) => item.kind === 'group' && (!source || item.id === source.conversationId)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}</fieldset>}
        <p className={scope === 'personal' ? 'task-private-note' : 'warning-note'}>{scope === 'personal' ? '个人待办仅本人可见；分享静态副本不开放原任务。' : '群共享：当前及未来加入的成员可见当前摘要、描述与检查项。'}</p>
        {scope === 'group' && mode !== 'edit' && state.online && <TaskLoadState {...policy} />}{mode !== 'edit' && !source && <MoreTaskConversations {...paging} />}
        {source && <section className="task-source-preview"><h3>消息来源预览</h3><p>{sourceUnavailable ? '来源消息当前不可用，请重新核对。' : source.text || '此消息没有可复制的文本。'}</p>{onRefreshSource && <button type="button" className="secondary-button" disabled={locked || !state.online} onClick={onRefreshSource}>重新核对来源消息</button>}<p>只建立经服务器核对的来源关系，不自动复制附件或分享任务。</p></section>}
        <TaskFieldsEditor fields={fields} onChange={setFields} userId={userId} groupId={scope === 'group' ? groupId || null : null} meta={meta} allowAssignOthers={allowOthers} assignDisabled={mode === 'edit' && !current?.capabilities.assign} disabled={locked || !currentPermission} />
        {(mode === 'copy' || source || snapshot || draftCreate?.sourceMessageId || draftCreate?.snapshotMessageId) && <label className="task-check"><input type="checkbox" checked={confirmed} disabled={locked || sourceUnavailable} onChange={(event) => setConfirmed(event.target.checked)} />{mode === 'copy' ? '我已核对以上选中字段，确认创建新群实体并让当前及未来成员可见' : snapshot || draftCreate?.snapshotMessageId ? '我已核对静态副本内容，确认创建自己的新待办，不修改原任务' : '我已核对消息来源与所选可见范围，确认创建独立待办'}</label>}
        {scope === 'group' && !group && <p className="task-error">该群不在当前群列表中，请重新同步或选择可用群。</p>}
        {reason && <p className="warning-note">{reason}</p>}{!currentPermission && <p className="warning-note">当前没有编辑或复制权限。</p>}
        {!state.online && <p className="warning-note">当前离线，只能保存创建或编辑草稿；不会自动创建、改派或分享。</p>}
        {error && <p role="alert" className="task-error">{error}</p>}<CommandFeedback {...command} />
        {command.conflict && <TaskConflict latest={command.conflict} draft={data() as Record<string, unknown>} onAccept={() => { setBase(command.conflict!); command.clear(); }} />}
        <div className="task-actions"><button className="primary-button" disabled={command.busy || savingDraft || !state.online || !currentPermission || !creationPermission || sourceUnavailable || !!command.conflict || (scope === 'group' && !group)}>{command.busy ? '正在提交…' : command.unknown ? '用同一编号核对并重试' : mode === 'copy' ? '确认创建群副本' : mode === 'edit' ? '保存待办修改' : '确认创建待办'}</button>{mode !== 'copy' && <button type="button" className="secondary-button" disabled={locked} onClick={() => void saveDraft()}>{savingDraft ? '正在保存草稿…' : '保存本机草稿'}</button>}</div>
      </form>{notice && <p role="status" className="success-note">{notice}</p>}
    </>}
    <button className="text-button" disabled={command.busy || savingDraft} onClick={onClose}>关闭</button>
  </div></Modal>;
}

/** A separate assignment form preserves content when the server grants assignment only. */
export function TaskAssignmentDialog({ client, task, userId, onClose }: { client: TaskClient; task: Task; userId: string; onClose: () => void }) {
  const state = useTaskState(client); const current = state.entities[task.id]; const [base, setBase] = useState(task); const [assignee, setAssignee] = useState(task.assignee?.id || null); const command = useTaskCommand(client);
  if (!current || state.invalid[task.id]) return <Modal open title="负责人调整" onClose={onClose}><TaskUnavailable onClose={onClose} /></Modal>;
  return <Modal open title="调整负责人" onClose={onClose} dismissible={!command.busy}><p>选择当前群成员，修改时会核对最新版本和成员资格。</p><AssignmentPicker groupId={current.groupId} userId={userId} value={assignee} onChange={setAssignee} allowOthers={current.capabilities.assign} disabled={command.busy || command.unknown || !current.capabilities.assign} /><CommandFeedback {...command} />{command.conflict && <TaskConflict latest={command.conflict} draft={{ assigneeId: assignee }} onAccept={() => { setBase(command.conflict!); command.clear(); }} />}<button className="primary-button" disabled={!state.online || !current.capabilities.assign || command.busy || !!command.conflict} onClick={() => void command.run(JSON.stringify({ kind: 'assign', id: base.id, etag: base.etag, assignee }), (key) => client.patch(base, { assigneeId: assignee }, key), base.id).then((result) => { if (result.ok) onClose(); })}>确认调整负责人</button></Modal>;
}
