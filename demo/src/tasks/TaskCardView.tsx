import { useCallback } from 'react';
import { ClipboardList } from 'lucide-react';
import { Avatar } from '../AttachmentViews';
import '../styles-task-card.css';
import type { TaskClient } from '../lib/tasks-client';
import type { TaskSnapshot } from '../lib/tasks-types';
import { priorityLabels, statusLabels, useTaskResource, useTaskState } from './TaskShared';

export type TaskCardViewProps = { client: TaskClient; messageId: string; onOpenTask: (id: string) => void; onSaveSnapshot: (snapshot: { messageId: string; value: TaskSnapshot }) => void };
export function TaskCardView({ client, messageId, onOpenTask, onSaveSnapshot }: TaskCardViewProps) {
  const state = useTaskState(client); const resource = useTaskResource(useCallback(() => client.card(messageId), [client, messageId, state.listRevision]), state.online && state.enabled);
  if (!state.enabled) return <div className="task-message-card unavailable"><strong>待办卡片</strong><p>当前未启用待办功能。</p></div>;
  if (!state.online || !resource.data || resource.data.kind === 'unavailable') return <div className="task-message-card unavailable"><strong>待办暂不可用</strong><p>{resource.loading ? '正在核对当前访问权限…' : !state.online ? '请联网后重新核对。' : '已删除或无访问权限。'}</p>{resource.error && <button className="text-button" onClick={resource.retry}>重新核对卡片</button>}</div>;
  const card = resource.data;
  if (card.kind === 'snapshot') return <article className="task-message-card snapshot v3-task-card"><header className="task-card-banner"><span><ClipboardList size={14} />个人待办 · 静态副本</span><span>分享时副本</span></header><div className="task-card-content"><h3>{card.snapshot.title}</h3><div className="task-card-facts"><span>{priorityLabels[card.snapshot.priority]}优先级</span><time title={card.snapshot.dueTimezone}>{card.snapshot.dueOn || '无截止日期'}</time></div>{card.snapshot.description && <p className="task-description">{card.snapshot.description}</p>}</div><footer className="task-card-footer"><span>副本不随原任务更新，也不开放原任务。</span><button className="secondary-button" onClick={() => onSaveSnapshot({ messageId, value: card.snapshot })}>存为我的待办</button></footer></article>;
  const task = state.entities[card.task.id];
  if (!task || state.invalid[card.task.id] || task.viewerId !== client.userId || task.deletedAt) return <div className="task-message-card unavailable"><strong>待办暂不可用</strong><p>已删除或无访问权限。</p></div>;
  const completed = task.checkItems.filter((item) => item.done).length;
  const progress = task.checkItems.length ? completed / task.checkItems.length * 100 : 0;
  return <article className="task-message-card live v3-task-card" title={`任务编号：${task.id}`}><header className="task-card-banner"><span><ClipboardList size={14} />群待办 · 实时引用</span><span>实时同步</span></header><div className="task-card-content"><h3>{task.title}</h3><div className="task-card-facts"><span className="task-card-assignee"><Avatar url={task.assignee?.avatarUrl} label={task.assignee?.nickname || '待认领'} />{task.assignee?.nickname || '待认领'}</span><time className={task.overdue ? 'overdue' : ''} title={task.dueTimezone}>{task.dueOn || '无截止日期'}</time><span className={`task-card-status ${task.status}`}>{statusLabels[task.status]}</span></div><div className="task-card-progress" role="progressbar" aria-label="检查项完成进度" aria-valuemin={0} aria-valuemax={task.checkItems.length || 1} aria-valuenow={completed} aria-valuetext={`${completed} / ${task.checkItems.length} 项已完成`}><span style={{ width: `${progress}%` }} /></div><div className="task-card-progress-label"><span>检查项 {completed} / {task.checkItems.length}</span><span>{priorityLabels[task.priority]}优先级</span></div></div><footer className="task-card-footer"><span>修改进展后，卡片会同步更新</span><button className="secondary-button" onClick={() => onOpenTask(task.id)}>查看任务</button></footer></article>;
}
