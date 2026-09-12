import { api, APIError, onAuthExpired } from './api';
import type { ChatClient } from './chat-client';
import type { Page } from './chat-types';
import type { CheckItem, GroupTaskSettings, Reminder, Task, TaskActivity, TaskCard, TaskCommandResult, TaskComment, TaskCopy, TaskCreate, TaskDraft, TaskLabel, TaskMeta, TaskPage, TaskPatch, TaskPreferences, TaskQuery, TaskReport, TaskShare, TaskShareResult, TaskState } from './tasks-types';
import { readTaskDrafts, removeTaskDraft, saveTaskDraft } from './task-drafts';

const empty = (): TaskState => ({ revision: 0, listRevision: 0, entities: {}, invalid: {}, online: false, enabled: true, enhanced: true, error: null });
export const taskCommandKey = (): string => crypto.randomUUID();
export class TaskClient {
  readonly userId: string;
  private chat: ChatClient;
  private state = empty();
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private generation = 0;
  private contentEpoch = 0;
  private requestSerial = 0;
  private appliedSerial: Record<string, number> = {};
  private running = false;
  private removers: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(userId: string, chat: ChatClient) { this.userId = userId; this.chat = chat; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<TaskState>) {
    const next = { ...this.state, ...patch, revision: this.state.revision + 1 };
    // Keep every cached entity's invalidation until revalidated. Unknown/deleted
    // references have a separate bounded tail; they never justify an old DTO fallback.
    const invalid = Object.entries(next.invalid);
    next.invalid = Object.fromEntries([...invalid.filter(([id]) => !!next.entities[id]), ...invalid.filter(([id]) => !next.entities[id]).slice(-500)]);
    this.appliedSerial = Object.fromEntries(Object.entries(this.appliedSerial).filter(([id]) => !!next.entities[id]));
    this.state = next; for (const listener of this.listeners) listener();
  }
  start() {
    if (this.running) return;
    this.running = true; this.generation++; this.controller = new AbortController();
    const connection = () => {
      const phase = this.chat.getSnapshot().phase; const online = phase === 'online' || phase === 'degraded';
      if (phase === 'expired') { this.stop(); return; }
      if (online !== this.state.online) { this.set({ online }); if (online) this.invalidate(); }
    };
    this.removers = [onAuthExpired(() => this.stop()), this.chat.subscribe(connection), this.chat.subscribeTaskEvents((event) => {
      if (event.type === 'access.revoked' && event.conversationId) {
        const entities = { ...this.state.entities }; const invalid = { ...this.state.invalid };
        for (const [id, task] of Object.entries(entities)) if (task.groupId === event.conversationId) { delete entities[id]; invalid[id] = true; }
        this.contentEpoch++; this.set({ entities, invalid, listRevision: this.state.listRevision + 1 });
      } else this.invalidate(['task.created', 'task.updated', 'task.deleted', 'task.restored', 'task.assignment.changed', 'task.comment.created'].includes(event.type) ? event.entityRef : undefined);
    })];
    connection();
  }
  stop() {
    this.running = false; this.generation++; this.contentEpoch++; this.controller.abort();
    this.removers.forEach((remove) => remove()); this.removers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer); this.refreshTimer = null;
    this.appliedSerial = {}; this.set(empty());
  }
  private async request<T>(path: string, options: { method?: string; body?: unknown; ifMatch?: string; idempotencyKey?: string } = {}): Promise<T> {
    const epoch = this.generation;
    if (!this.running) throw new APIError(409, { code: 'IDENTITY_CHANGED', message: '账号状态已改变，请重新打开待办。' });
    const result = await api<T>('/api/v1/tasks' + path, { ...options, actorContext: this.userId, signal: this.controller.signal });
    if (!this.running || epoch !== this.generation) throw new APIError(409, { code: 'IDENTITY_CHANGED', message: '账号状态已改变，已丢弃旧结果。' });
    return result;
  }
  private commit(task: Task, serial = ++this.requestSerial) {
    if (task.viewerId !== this.userId) throw new APIError(409, { code: 'IDENTITY_CHANGED', message: '待办所属账号已改变。' });
    const previous = this.state.entities[task.id];
    if (previous && (previous.version > task.version || previous.version === task.version && (this.appliedSerial[task.id] || 0) > serial)) return previous;
    this.appliedSerial[task.id] = serial;
    const entities = { ...this.state.entities, [task.id]: task }; const invalid = { ...this.state.invalid }; delete invalid[task.id];
    if (Object.keys(entities).length > 500) { const first = Object.keys(entities).find((id) => id !== task.id); if (first) delete entities[first]; }
    this.set({ entities, invalid, error: null }); return task;
  }
  private invalidate(id?: string) {
    this.contentEpoch++; const ids = id ? [id] : Object.keys(this.state.entities);
    this.set({ invalid: { ...this.state.invalid, ...Object.fromEntries(ids.map((key) => [key, true])) }, listRevision: this.state.listRevision + 1 });
    if (!this.state.online || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void (async () => { for (const key of Object.keys(this.state.invalid).filter((key) => this.state.entities[key]).slice(0, 100)) { if (!this.running) break; try { await this.get(key); } catch { /* get removes unavailable bodies and retains visible errors */ } } })();
    }, 120);
  }
  async meta(): Promise<TaskMeta> { const meta = await this.request<TaskMeta>('/meta'); if (meta.actorId !== this.userId) throw new APIError(409, { code: 'IDENTITY_CHANGED' }); this.set({ enabled: meta.enabled, enhanced: meta.enhanced }); return meta; }
  async list(query: TaskQuery = {}): Promise<TaskPage> {
    const queryString = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)]));
    const epoch = this.contentEpoch; const serial = ++this.requestSerial; const page = await this.request<TaskPage>('?' + queryString);
    if (epoch !== this.contentEpoch) throw new APIError(409, { code: 'TASK_VIEW_CHANGED', message: '待办已更新，请重新加载列表。' });
    return { ...page, items: page.items.map((task) => this.commit(task, serial)) };
  }
  async get(id: string): Promise<Task> {
    const epoch = this.contentEpoch; const serial = ++this.requestSerial;
    try { const task = await this.request<Task>('/' + encodeURIComponent(id)); if (epoch !== this.contentEpoch) throw new APIError(409, { code: 'TASK_VIEW_CHANGED', message: '待办正在更新，请重新加载。' }); return this.commit(task, serial); }
    catch (error) {
      if (error instanceof APIError && [403, 404].includes(error.status)) { const entities = { ...this.state.entities }; delete entities[id]; this.set({ entities, invalid: { ...this.state.invalid, [id]: true } }); }
      throw error;
    }
  }
  private async command(path: string, body: unknown, etag?: string, key = taskCommandKey(), method = 'POST'): Promise<Task> {
    const epoch = this.contentEpoch;
    const result = await this.request<TaskCommandResult>(path, { method, body, ifMatch: etag, idempotencyKey: key });
    if (epoch !== this.contentEpoch) { const task = await this.get(result.task.id); this.set({ listRevision: this.state.listRevision + 1 }); return task; }
    this.contentEpoch++; const task = this.commit(result.task); this.set({ listRevision: this.state.listRevision + 1 }); return task;
  }
  create(body: TaskCreate, key: string) { return this.command('', body, undefined, key); }
  patch(task: Task, body: TaskPatch, key?: string) { return this.command('/' + task.id, body, task.etag, key, 'PATCH'); }
  remove(task: Task, key?: string) { return this.command('/' + task.id, {}, task.etag, key, 'DELETE'); }
  restore(task: Task, key?: string) { return this.command('/' + task.id + '/restore', {}, task.etag, key); }
  claim(task: Task, key?: string) { return this.command('/' + task.id + '/claim', {}, task.etag, key); }
  release(task: Task, key?: string) { return this.command('/' + task.id + '/release', {}, task.etag, key); }
  addCheck(task: Task, text: string, key?: string) { return this.command('/' + task.id + '/check-items', { text }, task.etag, key); }
  editCheck(task: Task, item: CheckItem, value: { text?: string; done?: boolean }, key?: string) { return this.command('/' + task.id + '/check-items/' + item.id, value, task.etag, key, 'PATCH'); }
  removeCheck(task: Task, item: CheckItem, key?: string) { return this.command('/' + task.id + '/check-items/' + item.id, {}, task.etag, key, 'DELETE'); }
  activities(id: string, after = '') { return this.request<Page<TaskActivity>>('/' + id + '/activities?after=' + encodeURIComponent(after)); }
  comments(id: string, after = '') { return this.request<Page<TaskComment>>('/' + id + '/comments?after=' + encodeURIComponent(after)); }
  addComment(task: Task, text: string, key: string) { return this.command('/' + task.id + '/comments', { text }, task.etag, key); }
  removeComment(task: Task, commentId: string, key?: string) { return this.command('/' + task.id + '/comments/' + commentId, {}, task.etag, key, 'DELETE'); }
  reminder(task: Task, reminder: Reminder, key?: string) { return this.command('/' + task.id + '/my-reminder', reminder, task.etag, key, 'PUT'); }
  mark(task: Task, patch: { followed?: boolean; bookmarked?: boolean }, key?: string) { return this.command('/' + task.id + '/my-marks', patch, task.etag, key, 'PATCH'); }
  async share(task: Task, body: TaskShare, key: string) { return this.request<TaskShareResult>('/' + task.id + '/shares', { method: 'POST', body, ifMatch: task.etag, idempotencyKey: key }); }
  async copyToGroup(task: Task, body: TaskCopy, key: string) { return this.command('/' + task.id + '/group-copies', body, task.etag, key); }
  async card(messageId: string) {
    const epoch = this.contentEpoch; const serial = ++this.requestSerial; const card = await this.request<TaskCard>('/cards/' + messageId);
    if (epoch !== this.contentEpoch) throw new APIError(409, { code: 'TASK_VIEW_CHANGED', message: '卡片权限正在更新，请重新读取。' });
    if (card.kind === 'live') card.task = this.commit(card.task, serial); return card;
  }
  report(task: Task, body: { category: 'spam' | 'harassment' | 'illegal' | 'other'; description: string; commentId?: string }, key: string) { return this.request<TaskReport>('/' + task.id + '/reports', { method: 'POST', body, ifMatch: task.etag, idempotencyKey: key }); }
  preferences(body: TaskPreferences, key = taskCommandKey()) { return this.request<TaskPreferences>('/preferences', { method: 'PATCH', body, idempotencyKey: key }); }
  saveLabel(body: { kind: 'list' | 'tag'; name: string }, id?: string, key = taskCommandKey()) { return this.request<TaskLabel>('/labels' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body, idempotencyKey: key }); }
  removeLabel(id: string, key = taskCommandKey()) { return this.request<{ deleted: boolean }>('/labels/' + id, { method: 'DELETE', body: {}, idempotencyKey: key }); }
  groupSettings(groupId: string) { return this.request<GroupTaskSettings>('/groups/' + groupId + '/settings'); }
  changeGroupSettings(settings: GroupTaskSettings, createPolicy: 'members' | 'managers', key = taskCommandKey()) { return this.request<GroupTaskSettings>('/groups/' + settings.groupId + '/settings', { method: 'PATCH', body: { createPolicy }, ifMatch: settings.etag, idempotencyKey: key }); }
  drafts() { return readTaskDrafts(this.userId); }
  saveDraft(value: Pick<TaskDraft, 'taskId' | 'kind' | 'payload' | 'baseEtag'> & { id?: string }) { const epoch = this.generation; return saveTaskDraft(this.userId, value, () => this.running && this.generation === epoch); }
  deleteDraft(id: string) { return removeTaskDraft(this.userId, id); }
  async reviewDraft(draft: TaskDraft): Promise<{ draft: TaskDraft; latest: Task | null; expired: boolean }> {
    if (draft.userId !== this.userId) throw new APIError(409, { code: 'IDENTITY_CHANGED' });
    await this.meta(); const latest = draft.taskId ? await this.get(draft.taskId) : null;
    return { draft, latest, expired: draft.expiresAt <= Date.now() };
  }
}
