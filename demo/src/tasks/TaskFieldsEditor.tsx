import { useCallback } from 'react';
import { FormField } from '../components/FormField';
import type { TaskClient } from '../lib/tasks-client';
import type { TaskFields, TaskMeta } from '../lib/tasks-types';
import { priorityLabels, TaskLoadState, useGroupMembers, useTaskResource } from './TaskShared';

export function useCreationPolicy(client: TaskClient, groupId: string | null, enabled: boolean) {
  return useTaskResource(useCallback(() => client.groupSettings(groupId!), [client, groupId]), enabled && !!groupId);
}
export function AssignmentPicker({ groupId, userId, value, onChange, allowOthers, disabled }: { groupId: string | null; userId: string; value: string | null; onChange: (value: string | null) => void; allowOthers: boolean; disabled?: boolean }) {
  const resource = useGroupMembers(groupId, userId, !!groupId && allowOthers && !disabled);
  const selectedLoaded = !value || value === userId || resource.members.some((item) => item.user.id === value);
  return <div className="task-assignment"><label className="form-field">负责人<select aria-label="负责人" disabled={disabled} value={value || ''} onChange={(event) => onChange(event.target.value || null)}><option value="">待认领</option><option value={userId}>我</option>{allowOthers && resource.members.filter((item) => item.user.id !== userId).map((item) => <option key={item.user.id} value={item.user.id}>{item.user.nickname} (@{item.user.username})</option>)}{!selectedLoaded && <option value={value!} disabled>当前负责人（尚待成员核对）</option>}</select></label>{allowOthers && <><TaskLoadState {...resource} />{resource.next && <button type="button" className="text-button" disabled={resource.loading || disabled} onClick={resource.more}>加载更多当前群成员</button>}<p className="task-hint">从真实群成员分页列表选择；提交时再次核对当前成员资格。</p></>}{!allowOthers && <p className="task-hint">当前创建权限只提供本人负责或待认领。已有其他负责人不会被自动改写。</p>}</div>;
}
export function TaskFieldsEditor({ fields, onChange, userId, groupId, meta, allowAssignOthers, assignDisabled = false, disabled = false, includeLabels = true }: { fields: TaskFields; onChange: (next: TaskFields) => void; userId: string; groupId: string | null; meta: TaskMeta; allowAssignOthers: boolean; assignDisabled?: boolean; disabled?: boolean; includeLabels?: boolean }) {
  function change<K extends keyof TaskFields>(key: K, value: TaskFields[K]) { onChange({ ...fields, [key]: value }); }
  return <fieldset className="task-form-fields" disabled={disabled}>
    <FormField label="待办标题" required value={fields.title} onChange={(event) => change('title', event.target.value)} hint="1–120 个字符，保存前可继续编辑。" />
    <label className="form-field">待办描述<textarea rows={5} value={fields.description} onChange={(event) => change('description', event.target.value)} /><small>纯文本，最多 4,000 个字符 / 16 KiB；Enter 换行。</small></label>
    <div className="task-fields-grid"><label className="form-field">优先级<select value={fields.priority} onChange={(event) => change('priority', event.target.value as TaskFields['priority'])}>{Object.entries(priorityLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><FormField label="截止日期" type="date" value={fields.dueOn || ''} onChange={(event) => change('dueOn', event.target.value || null)} /><FormField label="任务时区" required value={fields.dueTimezone} onChange={(event) => change('dueTimezone', event.target.value)} hint="截止日期与提醒均以此时区解释。" /></div>
    {groupId ? <AssignmentPicker groupId={groupId} userId={userId} value={fields.assigneeId} onChange={(id) => change('assigneeId', id)} allowOthers={allowAssignOthers} disabled={disabled || assignDisabled} /> : <p className="task-hint">个人待办仅本人可见、由本人负责。</p>}
    {meta.enhanced && includeLabels && !groupId && <><label className="form-field">个人清单<select value={fields.listId || ''} onChange={(event) => change('listId', event.target.value || null)}><option value="">未加入清单</option>{meta.labels.filter((item) => item.kind === 'list').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><fieldset className="task-tag-picker"><legend>个人标签</legend>{meta.labels.filter((item) => item.kind === 'tag').map((item) => <label key={item.id}><input type="checkbox" checked={fields.tagIds?.includes(item.id) || false} onChange={(event) => change('tagIds', event.target.checked ? [...(fields.tagIds || []), item.id] : (fields.tagIds || []).filter((id) => id !== item.id))} />{item.name}</label>)}{!meta.labels.some((item) => item.kind === 'tag') && <p>尚未创建标签，可在“偏好与分类”中添加。</p>}</fieldset></>}
  </fieldset>;
}
