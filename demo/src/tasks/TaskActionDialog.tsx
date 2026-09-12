import { useState } from 'react';
import { Modal } from '../components/Modal';
import { FormField } from '../components/FormField';
import type { TaskClient } from '../lib/tasks-client';
import type { CheckItem, Reminder, Task, TaskStatus } from '../lib/tasks-types';
import { CommandFeedback, statusLabels, TaskConflict, TaskUnavailable, useTaskCommand, useTaskState } from './TaskShared';

export type TaskAction = { kind: 'status'; status: TaskStatus } | { kind: 'remove' | 'restore' | 'claim' | 'release' | 'check.add' } | { kind: 'check.toggle' | 'check.edit' | 'check.remove'; item: CheckItem } | { kind: 'comment.remove'; commentId: string } | { kind: 'reminder' } | { kind: 'mark'; field: 'followed' | 'bookmarked'; value: boolean };
const actionTitle = (action: TaskAction) => action.kind === 'status' ? `设为${statusLabels[action.status]}` : action.kind === 'mark' ? `${action.value ? '' : '取消'}${action.field === 'followed' ? '关注' : '收藏'}待办` : ({ remove: '删除待办', restore: '恢复待办', claim: '认领待办', release: '释放负责人', 'check.add': '添加检查项', 'check.toggle': '更新检查项', 'check.edit': '编辑检查项', 'check.remove': '删除检查项', 'comment.remove': '删除评论', reminder: '设置到期提醒' } as const)[action.kind];
export function TaskActionDialog({ client, task, action, onClose, onChanged }: { client: TaskClient; task: Task; action: TaskAction; onClose: () => void; onChanged?: () => void }) {
  const state = useTaskState(client); const current = state.entities[task.id]; const command = useTaskCommand(client); const [base, setBase] = useState(task); const [text, setText] = useState(action.kind === 'check.edit' ? action.item.text : ''); const [confirmed, setConfirmed] = useState(false); const [reminder, setReminder] = useState<Reminder>(task.reminder); const [success, setSuccess] = useState(false);
  if (!current || state.invalid[task.id] || current.viewerId !== client.userId) return <Modal open title="待办操作" onClose={onClose}><TaskUnavailable onClose={onClose} /></Modal>;
  const caps = current.capabilities; const check = 'item' in action ? current.checkItems.find((item) => item.id === action.item.id) : null;
  const allowed = action.kind === 'status' ? caps.progress : action.kind === 'remove' ? caps.remove : action.kind === 'restore' ? caps.restore : action.kind === 'claim' ? caps.claim : action.kind === 'release' ? caps.release : action.kind === 'check.toggle' ? caps.checkToggle && !!check : action.kind.startsWith('check.') ? caps.checkStructure && (action.kind === 'check.add' || !!check) : action.kind === 'comment.remove' ? caps.comment : !current.deletedAt && state.enhanced;
  const incomplete = action.kind === 'status' && action.status === 'done' && base.checkItems.some((item) => !item.done);
  const requiresConfirm = incomplete || ['remove', 'restore', 'check.remove', 'comment.remove'].includes(action.kind);
  const snapshot = { action, text: text.trim(), reminder, confirmIncomplete: incomplete && confirmed };
  async function perform() {
    if (command.busy || !allowed || !state.online || success || (requiresConfirm && !confirmed)) return;
    const result = await command.run(JSON.stringify({ id: base.id, etag: base.etag, ...snapshot }), (key) => {
      switch (action.kind) {
        case 'status': return client.patch(base, { status: action.status, ...(incomplete ? { confirmIncomplete: true } : {}) }, key);
        case 'remove': return client.remove(base, key);
        case 'restore': return client.restore(base, key);
        case 'claim': return client.claim(base, key);
        case 'release': return client.release(base, key);
        case 'check.add': return client.addCheck(base, text.trim(), key);
        case 'check.edit': return client.editCheck(base, action.item, { text: text.trim() }, key);
        case 'check.toggle': return client.editCheck(base, action.item, { done: !action.item.done }, key);
        case 'check.remove': return client.removeCheck(base, action.item, key);
        case 'comment.remove': return client.removeComment(base, action.commentId, key);
        case 'reminder': return client.reminder(base, reminder, key);
        case 'mark': return client.mark(base, { [action.field]: action.value }, key);
      }
    }, base.id);
    if (result.ok) { setSuccess(true); onChanged?.(); }
  }
  return <Modal open title={actionTitle(action)} dismissible={!command.busy} onClose={onClose}><div className="task-action-dialog"><p>{current.title}</p>{success ? <p role="status" className="success-note">服务器已确认此项操作。</p> : <form onSubmit={(event) => { event.preventDefault(); void perform(); }}><fieldset disabled={command.busy || command.unknown || !allowed}>
    {action.kind === 'check.add' || action.kind === 'check.edit' ? <FormField label="检查项文本" required value={text} onChange={(event) => setText(event.target.value)} /> : null}
    {action.kind === 'reminder' && <><label className="form-field">提醒规则<select value={reminder.rule} onChange={(event) => setReminder({ ...reminder, rule: event.target.value as Reminder['rule'] })}><option value="none">不提醒</option><option value="day_before">到期前一天</option><option value="due_day">到期当天</option></select></label><FormField label="提醒时间" type="time" required value={reminder.time} onChange={(event) => setReminder({ ...reminder, time: event.target.value })} /><p>任务时区：{current.dueTimezone}。提醒由服务器持久任务处理，站内通知不保证浏览器关闭后的系统推送。</p></>}
    {action.kind === 'remove' && <p>待办将进入 30 天回收期，实时引用不再显示正文；已发送的个人静态副本不随之删除。</p>}
    {action.kind === 'restore' && <p>恢复需要当前仍有权限且处于回收期限内。</p>}
    {incomplete && <p className="warning-note">还有未完成的检查项。完成待办不会把它们自动勾选。</p>}
    {requiresConfirm && <label className="task-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{incomplete ? '我确认保留未勾选检查项，并将待办标为完成' : '我已核对并确认此项操作'}</label>}
    </fieldset>{!allowed && <p className="warning-note">{caps.writeReason || '当前没有此项操作权限。'}</p>}{!state.online && <p className="warning-note">请联网后重新核对，任务操作不会自动重放。</p>}<CommandFeedback {...command} />{command.conflict && <TaskConflict latest={command.conflict} draft={action.kind === 'status' ? { status: action.status } : action.kind.startsWith('check.') ? { text } : { title: base.title, assigneeId: base.assignee?.id || null }} onAccept={() => { setBase(command.conflict!); setConfirmed(false); command.clear(); }} />}<button className="primary-button" disabled={command.busy || !allowed || !state.online || !!command.conflict || (requiresConfirm && !confirmed)}>{command.busy ? '正在提交…' : command.unknown ? '用同一编号核对并重试' : '确认提交操作'}</button></form>}<button className="text-button" disabled={command.busy} onClick={onClose}>关闭</button></div></Modal>;
}
