import { useCallback } from 'react';
import type { TaskClient } from '../lib/tasks-client';
import type { TaskSnapshot } from '../lib/tasks-types';
import { priorityLabels, statusLabels, useTaskResource, useTaskState } from './TaskShared';

export type TaskCardViewProps = { client: TaskClient; messageId: string; onOpenTask: (id: string) => void; onSaveSnapshot: (snapshot: { messageId: string; value: TaskSnapshot }) => void };
export function TaskCardView({ client, messageId, onOpenTask, onSaveSnapshot }: TaskCardViewProps) {
  const state = useTaskState(client); const resource = useTaskResource(useCallback(() => client.card(messageId), [client, messageId, state.listRevision]), state.online && state.enabled);
  if (!state.enabled) return <div className="task-message-card unavailable"><strong>待办卡片</strong><p>当前未启用待办功能。</p></div>;
  if (!state.online || !resource.data || resource.data.kind === 'unavailable') return <div className="task-message-card unavailable"><strong>待办暂不可用</strong><p>{resource.loading ? '正在核对当前访问权限…' : !state.online ? '请联网后重新核对。' : '已删除或无访问权限。'}</p>{resource.error && <button className="text-button" onClick={resource.retry}>重新核对卡片</button>}</div>;
  const card = resource.data;
  if (card.kind === 'snapshot') return <article className="task-message-card snapshot"><span className="task-scope">个人待办 · 静态副本</span><h3>{card.snapshot.title}</h3><p>优先级 {priorityLabels[card.snapshot.priority]} · {card.snapshot.dueOn || '无截止日期'}{card.snapshot.dueOn && ` · ${card.snapshot.dueTimezone}`}</p>{card.snapshot.description && <p className="task-description">{card.snapshot.description}</p>}<p className="task-hint">副本不随原任务更新，也不开放原任务。</p><button className="secondary-button" onClick={() => onSaveSnapshot({ messageId, value: card.snapshot })}>存为我的待办</button></article>;
  const task = state.entities[card.task.id];
  if (!task || state.invalid[card.task.id] || task.viewerId !== client.userId || task.deletedAt) return <div className="task-message-card unavailable"><strong>待办暂不可用</strong><p>已删除或无访问权限。</p></div>;
  return <article className="task-message-card live"><span className="task-scope">群待办 · 实时引用</span><h3>{task.title}</h3><p>{statusLabels[task.status]} · {task.assignee?.nickname || '待认领'}</p><p>{task.dueOn || '无截止日期'}{task.dueOn && ` · ${task.dueTimezone}`} · 检查项 {task.checkItems.filter((item) => item.done).length}/{task.checkItems.length}</p><small>任务编号：{task.id}</small><button className="secondary-button" onClick={() => onOpenTask(task.id)}>查看任务</button></article>;
}
