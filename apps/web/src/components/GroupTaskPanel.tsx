import { useCallback, useState } from 'react';
import { Check, ClipboardList, Plus } from 'lucide-react';
import type { TaskClient } from '../lib/tasks-client';
import type { Task } from '../lib/tasks-types';
import { TaskActionDialog } from '../tasks/TaskActionDialog';
import { useTaskResource, useTaskState } from '../tasks/TaskShared';
import '../styles-group-task-panel.css';

export function GroupTaskPanel({ client, groupId, onOpenTask, onViewAll, onCreate }: {
  client: TaskClient; groupId: string; onOpenTask: (id: string) => void; onViewAll: () => void; onCreate: () => void;
}) {
  const state = useTaskState(client);
  const [completing, setCompleting] = useState<Task | null>(null);
  const resource = useTaskResource(useCallback(async () => {
    const [open, done, settings] = await Promise.all([
      client.list({ view: 'group', groupId, status: 'open', limit: 6 }),
      client.list({ view: 'group', groupId, status: 'done', limit: 1 }),
      client.groupSettings(groupId),
    ]);
    return { open, done, settings };
  }, [client, groupId, state.listRevision]), state.online && state.enabled);
  const data = resource.data;
  const valid = data?.open.actorId === client.userId && data.done.actorId === client.userId && data.settings.groupId === groupId;
  const tasks = valid ? data.open.items.flatMap(({ id }) => {
    const task = state.entities[id];
    return task && !state.invalid[id] && task.viewerId === client.userId && task.groupId === groupId && !task.deletedAt && task.status !== 'done' ? [task] : [];
  }) : [];
  const total = valid ? data.open.total + data.done.total : 0;
  const complete = valid ? data.done.total : 0;
  return <section className="group-task-panel" aria-label="群待办概览">
    <header><h2><ClipboardList size={16} />群待办</h2><button className="text-button" onClick={onViewAll}>查看全部 ›</button></header>
    <p className="group-task-subtitle">共在一个群，也共享下一步。</p>
    {valid && <div className="group-task-progress"><div><span>本群任务</span><span>{complete} / {total} 已完成</span></div><progress aria-label="本群任务完成比例" value={complete} max={total || 1} /></div>}
    <div className="group-task-items">
      {!state.online ? <p className="group-task-empty">连接恢复后同步群待办。</p> : resource.error ? <div className="group-task-empty" role="status"><p>暂时无法读取群待办。</p><button className="text-button" onClick={resource.retry}>重新加载</button></div> : resource.loading ? <p className="group-task-empty" role="status">正在同步群待办…</p> : valid && tasks.length === 0 ? <p className="group-task-empty">暂时没有未完成的待办。</p> : null}
      {tasks.map((task) => <article key={task.id} className="group-task-item">
        <button className={`group-task-check ${task.status}`} aria-label={`标记完成：${task.title}`} title={task.capabilities.progress ? '标记完成' : task.capabilities.writeReason || '当前只能查看'} disabled={!state.online || !task.capabilities.progress} onClick={() => setCompleting(task)}>{task.status === 'done' && <Check size={12} />}</button>
        <button className="group-task-open" onClick={() => onOpenTask(task.id)}><strong>{task.title}</strong><span className="group-task-meta"><span className="group-task-avatar" aria-hidden="true">{task.assignee?.nickname.slice(0, 1) || '·'}</span><span>{task.assignee?.nickname || '待认领'}</span><time className={task.overdue ? 'overdue' : ''} dateTime={task.dueOn || undefined} title={task.dueTimezone}>{task.dueOn ? `${Number(task.dueOn.slice(5, 7))} 月 ${Number(task.dueOn.slice(8))} 日${task.overdue ? ' · 逾期' : ''}` : '无截止日期'}</time></span></button>
      </article>)}
    </div>
    <footer><button className="secondary-button" onClick={onCreate} disabled={!valid || !data.settings.canCreate || !state.online}><Plus size={15} />创建群待办</button><p>{valid && !data.settings.canCreate ? data.settings.writeReason || '当前没有创建群待办的权限。' : '仅当前群成员可见，新成员可见当前任务摘要。'}</p></footer>
    {completing && <TaskActionDialog client={client} task={completing} action={{ kind: 'status', status: 'done' }} onClose={() => setCompleting(null)} />}
  </section>;
}
