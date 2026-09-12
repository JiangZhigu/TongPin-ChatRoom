import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, APIError } from '../lib/api';
import { taskCommandKey, type TaskClient } from '../lib/tasks-client';
import type { Page } from '../lib/chat-types';
import type { GroupMember } from '../lib/group-types';
import type { Task, TaskPriority, TaskStatus } from '../lib/tasks-types';

export const statusLabels: Record<TaskStatus, string> = { todo: '未开始', doing: '进行中', done: '已完成' };
export const priorityLabels: Record<TaskPriority, string> = { low: '低', normal: '普通', high: '高' };
export const taskError = (cause: unknown) => cause instanceof APIError ? [cause.message, ...Object.values(cause.fieldErrors || {})].join(' ') : cause instanceof Error ? cause.message : '请求未能完成，请重试。';
export const timeText = (value: number | null) => value === null ? '无' : new Date(value).toLocaleString('zh-CN');
export function useTaskState(client: TaskClient) { return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot); }
export function useLiveTask(client: TaskClient, id: string) {
  const state = useTaskState(client); const task = state.entities[id];
  return { state, task: task && !state.invalid[id] && task.viewerId === client.userId ? task : undefined, invalid: !!state.invalid[id] };
}
export function useTaskResource<T>(load: () => Promise<T>, enabled = true): { data?: T; error?: string; loading: boolean; retry: () => void } {
  const [attempt, setAttempt] = useState(0); const [state, setState] = useState<{ source: typeof load; enabled: boolean; data?: T; error?: string; loading: boolean }>({ source: load, enabled, loading: enabled });
  useEffect(() => { let current = true; setState({ source: load, enabled, loading: enabled }); if (enabled) void load().then((data) => { if (current) setState({ source: load, enabled, data, loading: false }); }).catch((cause) => { if (current) setState({ source: load, enabled, error: taskError(cause), loading: false }); }); return () => { current = false; }; }, [load, enabled, attempt]);
  return { ...(state.source === load && state.enabled === enabled ? state : { loading: enabled }), retry: useCallback(() => setAttempt((value) => value + 1), []) };
}
export function TaskLoadState({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  return <>{loading && <p role="status" className="task-hint">正在核对待办数据…</p>}{error && <div className="task-error" role="alert"><p>{error}</p><button className="secondary-button" onClick={retry}>重新加载</button></div>}</>;
}

/** Keys belong to the exact visible form payload, including its base version. */
export function useTaskCommand(client: TaskClient) {
  const active = useRef(true); const generation = useRef(0); const lock = useRef(false); const receipt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false); const [conflict, setConflict] = useState<Task | null>(null);
  useEffect(() => { generation.current++; active.current = true; lock.current = false; receipt.current = null; return () => { generation.current++; active.current = false; }; }, [client]);
  function clear() { setError(''); setConflict(null); setUnknown(false); receipt.current = null; }
  async function run<T>(fingerprint: string, execute: (key: string) => Promise<T>, taskId?: string): Promise<{ ok: true; value: T } | { ok: false }> {
    if (lock.current) return { ok: false }; const epoch = generation.current; const current = () => active.current && epoch === generation.current; lock.current = true; setBusy(true); setError('');
    if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, key: taskCommandKey() };
    try { const value = await execute(receipt.current.key); if (!current()) return { ok: false }; setUnknown(false); setConflict(null); return { ok: true, value }; }
    catch (cause) {
      if (!current()) return { ok: false };
      setError(taskError(cause)); setUnknown(!(cause instanceof APIError) || cause.status === 0 || cause.status >= 500);
      if (cause instanceof APIError && cause.status === 412 && taskId) {
        try { const latest = await client.get(taskId); if (current()) setConflict(latest); }
        catch (refreshError) { if (current()) setError(`${taskError(cause)} 最新版本读取失败：${taskError(refreshError)}`); }
      } else if (cause instanceof APIError && [403, 404].includes(cause.status) && taskId) {
        try { await client.get(taskId); } catch { /* The shared client removes unavailable bodies. */ }
      }
      return { ok: false };
    } finally { if (current()) { lock.current = false; setBusy(false); } }
  }
  return { busy, error, unknown, conflict, run, clear };
}
export function CommandFeedback({ error, unknown }: { error: string; unknown: boolean }) {
  return <>{error && <p role="alert" className="task-error">{error}</p>}{unknown && <p className="warning-note">提交结果尚未确认。输入已固定；重试使用同一命令编号核对结果，请勿另外创建相同操作。</p>}</>;
}
export function TaskConflict({ latest, draft, onAccept, review = false, disabled = false }: { latest: Task; draft: Record<string, unknown>; onAccept: () => void; review?: boolean; disabled?: boolean }) {
  const names: Record<string, string> = { title: '标题', description: '描述', status: '状态', priority: '优先级', assigneeId: '负责人', dueOn: '截止日期', dueTimezone: '任务时区', listId: '个人清单', tagIds: '个人标签', text: '待提交文本' };
  const current = { ...latest, assigneeId: latest.assignee?.id || null } as Record<string, unknown>;
  const text = (value: unknown) => Array.isArray(value) ? value.join('、') || '无' : value == null || value === '' ? '无' : typeof value === 'string' ? statusLabels[value as TaskStatus] || priorityLabels[value as TaskPriority] || value : String(value);
  return <section className="task-conflict" aria-label={review ? '草稿与最新版本核对' : '版本冲突核对'}><h3>{review ? '核对本机修改与当前版本' : '服务器已有更新，请核对'}</h3><p>你的输入仍保留。最新版本 {latest.version}；不会自动覆盖。</p><dl>{Object.entries(draft).filter(([key]) => key in names).map(([key, value]) => <div key={key}><dt>{names[key]}</dt><dd><span>我的输入：{text(value)}</span><span>最新值：{text(current[key])}</span></dd></div>)}</dl><button className="secondary-button" type="button" disabled={disabled} onClick={onAccept}>保留我的输入，采用最新版本继续核对</button><p className="task-hint">采用版本后仍须再次点击提交。</p></section>;
}
export function TaskUnavailable({ onClose, onRetry, children }: { onClose?: () => void; onRetry?: () => void; children?: ReactNode }) {
  return <section className="task-unavailable" role="status"><h2>待办暂不可用</h2><p>正在更新、已删除或当前没有访问权限，旧内容已隐藏。</p>{children}<div className="task-actions">{onRetry && <button className="secondary-button" onClick={onRetry}>重新核对</button>}{onClose && <button className="secondary-button" onClick={onClose}>返回</button>}</div></section>;
}
export function TaskBadge({ task }: { task: Task }) { return <span className={`task-scope ${task.scope}`}>{task.scope === 'personal' ? '仅自己可见' : `群共享 · ${task.groupName || '当前群'}`}</span>; }

export function useGroupMembers(groupId: string | null, userId: string, enabled = true) {
  const [members, setMembers] = useState<GroupMember[]>([]); const [next, setNext] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController | null>(null); const generation = useRef(0); const lock = useRef(false);
  const read = useCallback(async (after = '') => {
    if (!groupId || !enabled || lock.current) return; lock.current = true; const epoch = generation.current; const controller = new AbortController(); request.current = controller; setLoading(true); setError('');
    try { const result = await api<Page<GroupMember>>(`/api/v1/groups/${encodeURIComponent(groupId)}/members${after ? `?after=${encodeURIComponent(after)}` : ''}`, { actorContext: userId, signal: controller.signal }); if (controller.signal.aborted || epoch !== generation.current) return; setMembers((current) => after ? [...new Map([...current, ...result.items].map((item) => [item.user.id, item])).values()] : result.items); setNext(result.nextCursor); }
    catch (cause) { if (!controller.signal.aborted && epoch === generation.current) setError(taskError(cause)); }
    finally { if (epoch === generation.current) { lock.current = false; if (!controller.signal.aborted) setLoading(false); } }
  }, [groupId, userId, enabled]);
  useEffect(() => { generation.current++; lock.current = false; request.current?.abort(); setMembers([]); setNext(null); setError(''); setLoading(false); void read(); return () => { generation.current++; request.current?.abort(); lock.current = false; }; }, [read, attempt]);
  return { members, next, loading, error, more: () => void read(next || ''), retry: () => setAttempt((value) => value + 1) };
}

export type TaskConversationPaging = { hasMoreConversations?: boolean; onLoadMoreConversations?: () => Promise<void> };
export function MoreTaskConversations({ hasMoreConversations, onLoadMoreConversations }: TaskConversationPaging) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (!hasMoreConversations || !onLoadMoreConversations) return null;
  return <div>{error && <p role="alert" className="task-error">{error}</p>}<button type="button" className="text-button" disabled={busy} onClick={() => { setBusy(true); setError(''); void onLoadMoreConversations().catch((cause) => setError(taskError(cause))).finally(() => setBusy(false)); }}>{busy ? '正在加载会话与群…' : '加载更多会话与群'}</button></div>;
}