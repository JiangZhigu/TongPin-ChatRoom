// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api, APIError } from '../lib/api';
import { TaskClient } from '../lib/tasks-client';
import type { ChatClient } from '../lib/chat-client';
import type { Conversation } from '../lib/chat-types';
import type { Task, TaskDraft, TaskMeta, TaskState } from '../lib/tasks-types';
import { TaskForm } from './TaskForm';
import { TaskActionDialog } from './TaskActionDialog';
import { TaskCardView } from './TaskCardView';
import { TaskShareDialog } from './TaskShareDialog';
import { TaskDrafts } from './TaskDrafts';
import { TaskWorkspace } from './TaskWorkspace';
import { TaskActivityPanel } from './TaskActivityPanel';
import { TaskDetail } from './TaskDetail';
import { TaskPreferencesForm } from './TaskSettings';
import { AssignmentPicker } from './TaskFieldsEditor';
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn() }));
const request = vi.mocked(api);
const person = { id: 'u1', username: 'alice', nickname: '小林', avatarUrl: null };
const meta: TaskMeta = { actorId: 'u1', enabled: true, enhanced: true, canCreatePersonal: true, writeReason: null, preferences: { assignments: true, comments: true, completed: true, due: true, timezone: 'Asia/Shanghai' }, labels: [], limits: { personal: 500, group: 500, checkItems: 30, draftDays: 7, draftCount: 50 } };
const task: Task = { id: 't1', scope: 'personal', groupId: null, groupName: null, ownerId: 'u1', creator: person, assignee: person, title: '采购清单', description: '本人内容', priority: 'normal', status: 'todo', dueOn: null, dueTimezone: 'Asia/Shanghai', overdue: false, completedAt: null, createdAt: 1, updatedAt: 2, deletedAt: null, version: 1, etag: '"v1"', checkItems: [], source: null, capabilities: { edit: true, progress: true, assign: true, claim: false, release: false, checkStructure: true, checkToggle: true, remove: true, restore: false, comment: true, share: true, copyToGroup: true, writeReason: null }, followed: false, bookmarked: false, listId: null, tagIds: [], reminder: { rule: 'none', time: '09:00' }, viewerId: 'u1' };
const group = { id: 'g1', kind: 'group', title: '设计组', canSend: true } as Conversation;
function fixture(value: Task = task, online = true) {
  let state: TaskState = { revision: 0, listRevision: 0, entities: { [value.id]: value }, invalid: {}, online, enabled: true, enhanced: true, error: null }; const listeners = new Set<() => void>();
  const mock = { userId: 'u1', subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => state, meta: vi.fn().mockResolvedValue(meta), list: vi.fn().mockResolvedValue({ items: [value], total: 1, actorId: 'u1', nextCursor: null }), get: vi.fn().mockResolvedValue(value), create: vi.fn().mockResolvedValue(value), patch: vi.fn().mockResolvedValue(value), share: vi.fn().mockResolvedValue({ messageId: 'm1', conversationId: 'g1', duplicate: false }), copyToGroup: vi.fn().mockResolvedValue({ ...value, id: 't-copy' }), saveDraft: vi.fn(), deleteDraft: vi.fn().mockResolvedValue(undefined), drafts: vi.fn().mockResolvedValue([]), reviewDraft: vi.fn(), card: vi.fn().mockResolvedValue({ kind: 'live', task: value }), groupSettings: vi.fn().mockResolvedValue({ groupId: 'g1', createPolicy: 'members', canManage: true, canCreate: true, etag: 'g-v1', count: 0, quota: 500, writeReason: null }), activities: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), comments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), addComment: vi.fn().mockResolvedValue(value), preferences: vi.fn().mockResolvedValue(meta.preferences) };
  return { mock, client: mock as unknown as TaskClient, set: (patch: Partial<TaskState>) => { state = { ...state, ...patch, revision: state.revision + 1 }; listeners.forEach((fn) => fn()); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; }
beforeEach(() => { request.mockReset(); request.mockResolvedValue({ items: [], nextCursor: null }); Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('task detail event invalidation recovery', () => {
  async function liveFixture() {
    const value = { ...task, scope: 'group' as const, groupId: 'g1', groupName: '设计组' };
    let current = value; let pendingGet: Promise<Task> | undefined;
    let event!: (value: { type: string; entityRef?: string; conversationId?: string }) => void;
    const chat = { getSnapshot: () => ({ phase: 'online' }), subscribe: () => () => {}, subscribeTaskEvents: (receive: typeof event) => { event = receive; return () => {}; } } as unknown as ChatClient;
    request.mockImplementation(async (path, options) => {
      if (path === '/api/v1/tasks/t1' && (!options?.method || options.method === 'GET')) return pendingGet || current;
      if (path.includes('/activities?') || path.includes('/comments?')) return { items: [], nextCursor: null };
      if (path.includes('/members')) return { items: [], nextCursor: null };
      if (options?.method) return { task: current };
      throw new Error(`Unexpected task request: ${path}`);
    });
    const client = new TaskClient('u1', chat); client.start(); await client.get('t1');
    const view = render(<TaskDetail client={client} taskId="t1" userId="u1" conversations={[group]} contacts={[]} meta={meta} onOpenSource={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: '编辑待办' });
    await act(async () => {});
    return { client, view, value, emit: (type: string) => act(() => event({ type, entityRef: 't1', conversationId: 'g1' })),
      pause: () => { const pending = deferred<Task>(); pendingGet = pending.promise; return pending; },
      restore: async (pending: ReturnType<typeof deferred<Task>>, next = { ...value, version: 2, etag: '"v2"' }) => { current = next; pendingGet = undefined; await act(async () => pending.resolve(next)); await waitFor(() => expect(client.getSnapshot().invalid.t1).toBeUndefined()); },
      close: () => { view.unmount(); client.stop(); } };
  }
  it('keeps unsaved editor fields and original base etag across a real task event and GET refresh', async () => {
    const f = await liveFixture(); fireEvent.click(screen.getByRole('button', { name: '编辑待办' }));
    fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '本机未提交标题' } });
    const pending = f.pause(); f.emit('task.comment.created');
    expect(screen.queryByText('本人内容')).not.toBeInTheDocument(); expect(screen.queryByLabelText(/待办标题/)).not.toBeInTheDocument();
    await f.restore(pending); expect(screen.getByLabelText(/待办标题/)).toHaveValue('本机未提交标题');
    fireEvent.click(screen.getByRole('button', { name: '保存待办修改' })); await screen.findByText('待办修改已保存');
    expect(request).toHaveBeenCalledWith('/api/v1/tasks/t1', expect.objectContaining({ method: 'PATCH', ifMatch: '"v1"', body: { title: '本机未提交标题' } })); f.close();
  });
  it('keeps the comment tab and unsent comment through event refresh with stale discussion hidden', async () => {
    const f = await liveFixture(); fireEvent.click(screen.getByRole('button', { name: '任务评论' })); fireEvent.change(screen.getByLabelText('添加任务评论'), { target: { value: '尚未提交评论' } });
    const pending = f.pause(); f.emit('task.updated'); expect(screen.queryByLabelText('添加任务评论')).not.toBeInTheDocument();
    await f.restore(pending); expect(screen.getByRole('button', { name: '任务评论' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByLabelText('添加任务评论')).toHaveValue('尚未提交评论'); f.close();
  });
  it('keeps an in-flight check command acknowledgment through event before HTTP completion', async () => {
    const f = await liveFixture(); const response = deferred<{ task: Task }>(); const original = request.getMockImplementation()!;
    request.mockImplementation((path, options) => path === '/api/v1/tasks/t1/check-items' ? response.promise as ReturnType<typeof api> : original(path, options));
    fireEvent.click(screen.getByRole('button', { name: '添加检查项' })); fireEvent.change(screen.getByLabelText('检查项文本'), { target: { value: '只提交一次' } }); fireEvent.click(screen.getByRole('button', { name: '确认提交操作' }));
    const pending = f.pause(); f.emit('task.updated'); expect(screen.queryByLabelText('检查项文本')).not.toBeInTheDocument();
    const next = { ...f.value, version: 2, etag: '"v2"', checkItems: [{ id: 'check1', text: '只提交一次', done: false, position: 0 }] };
    await f.restore(pending, next); await act(async () => response.resolve({ task: next }));
    await screen.findByText('服务器已确认此项操作。'); expect(request.mock.calls.filter(([path]) => path === '/api/v1/tasks/t1/check-items')).toHaveLength(1); f.close();
  });
  it('keeps the comments tab and shows saved acknowledgment when its own event precedes HTTP completion', async () => {
    const f = await liveFixture(); const response = deferred<{ task: Task }>(); const original = request.getMockImplementation()!;
    request.mockImplementation((path, options) => path === '/api/v1/tasks/t1/comments' ? response.promise as ReturnType<typeof api> : original(path, options));
    fireEvent.click(screen.getByRole('button', { name: '任务评论' })); fireEvent.change(screen.getByLabelText('添加任务评论'), { target: { value: '保存后仍在评论页' } }); fireEvent.click(screen.getByRole('button', { name: '提交评论' }));
    const pending = f.pause(); f.emit('task.comment.created'); await f.restore(pending);
    await act(async () => response.resolve({ task: { ...f.value, version: 2, etag: '"v2"' } }));
    await screen.findByText('评论已由服务器保存。'); expect(screen.getByRole('button', { name: '任务评论' })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByLabelText('添加任务评论')).toHaveValue(''); expect(request.mock.calls.filter(([path]) => path === '/api/v1/tasks/t1/comments')).toHaveLength(1); f.close();
  });
  it('clears edit input on confirmed group access revocation and never reveals it after revalidation', async () => {
    const f = await liveFixture(); fireEvent.click(screen.getByRole('button', { name: '编辑待办' })); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '失权前本机输入' } });
    const pending = f.pause(); f.emit('access.revoked'); expect(screen.queryByText('本人内容')).not.toBeInTheDocument(); expect(screen.queryByDisplayValue('失权前本机输入')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '保存待办修改' })).not.toBeInTheDocument();
    await f.restore(pending); expect(screen.queryByDisplayValue('失权前本机输入')).not.toBeInTheDocument(); f.close();
  });
});

describe('task form commands and explicit recovery', () => {
  it('keeps the command key and exact payload on unknown create retry without auto sharing', async () => {
    const f = fixture(); f.mock.create.mockRejectedValueOnce(new APIError(0, { message: '响应未确认' })); render(<TaskForm client={f.client} userId="u1" conversations={[]} meta={meta} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '写周报' } }); fireEvent.click(screen.getByRole('button', { name: '确认创建待办' })); await screen.findByRole('button', { name: '用同一编号核对并重试' }); expect(screen.getByLabelText(/待办标题/)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '用同一编号核对并重试' })); await screen.findByText('待办已创建'); expect(f.mock.create).toHaveBeenCalledTimes(2); expect(f.mock.create.mock.calls[1]).toEqual(f.mock.create.mock.calls[0]); expect(f.mock.share).not.toHaveBeenCalled();
  });
  it('preserves edited fields on 412 and only retries against latest etag after explicit adoption and submit', async () => {
    const f = fixture(); f.mock.patch.mockRejectedValueOnce(new APIError(412, { message: '版本冲突' })); const latest = { ...task, title: '同事更新', version: 2, etag: '"v2"' }; f.mock.get.mockResolvedValue(latest);
    render(<TaskForm client={f.client} userId="u1" conversations={[]} meta={meta} task={task} onSaved={vi.fn()} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '我的修改' } }); fireEvent.click(screen.getByRole('button', { name: '保存待办修改' })); await screen.findByRole('region', { name: '版本冲突核对' }); expect(screen.getByLabelText(/待办标题/)).toHaveValue('我的修改'); expect(f.mock.patch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '保留我的输入，采用最新版本继续核对' })); expect(f.mock.patch).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: '保存待办修改' })); await screen.findByText('待办修改已保存'); expect(f.mock.patch.mock.calls[1][0].etag).toBe('"v2"'); expect(f.mock.patch.mock.calls[1][1]).toEqual({ title: '我的修改' }); expect(f.mock.patch.mock.calls[1][2]).not.toBe(f.mock.patch.mock.calls[0][2]);
  });
  it('offers only draft saving offline and reports a storage failure without submitting', async () => {
    const f = fixture(task, false); f.mock.saveDraft.mockRejectedValue(new Error('本机存储已满')); render(<TaskForm client={f.client} userId="u1" conversations={[]} meta={meta} onSaved={vi.fn()} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '离线输入' } }); expect(screen.getByRole('button', { name: '确认创建待办' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '保存本机草稿' })); await screen.findByRole('alert'); expect(screen.getByLabelText(/待办标题/)).toHaveValue('离线输入'); expect(f.mock.create).not.toHaveBeenCalled(); expect(f.mock.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create', payload: expect.objectContaining({ title: '离线输入' }) }));
  });
  it('suppresses a late local-draft callback after account component unmount', async () => {
    const f = fixture(task, false); const pending = deferred<TaskDraft>(); f.mock.saveDraft.mockReturnValue(pending.promise); const saved = vi.fn(); const view = render(<TaskForm client={f.client} userId="u1" conversations={[]} meta={meta} onSaved={vi.fn()} onDraftSaved={saved} onClose={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '保存本机草稿' })); view.unmount(); await act(async () => pending.resolve({ id: 'd1' } as TaskDraft)); expect(saved).not.toHaveBeenCalled();
  });
  it('requires source confirmation and does not copy source body implicitly', async () => {
    const f = fixture(); render(<TaskForm client={f.client} userId="u1" conversations={[]} meta={meta} source={{ messageId: 'source1', conversationId: 'dm1', text: '来源敏感文本', available: true, revision: 1 }} onSaved={vi.fn()} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '从消息整理' } }); fireEvent.click(screen.getByRole('button', { name: '确认创建待办' })); expect(f.mock.create).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('checkbox', { name: /我已核对消息来源/ })); fireEvent.click(screen.getByRole('button', { name: '确认创建待办' })); await screen.findByText('待办已创建'); expect(f.mock.create.mock.calls[0][0]).toEqual(expect.objectContaining({ scope: 'personal', sourceMessageId: 'source1', description: '' }));
  });
  it('respects server creation denial for a group instead of deriving permission from local role', async () => {
    const f = fixture(); f.mock.groupSettings.mockResolvedValue({ groupId: 'g1', createPolicy: 'members', canManage: true, canCreate: false, etag: 'g1', count: 0, quota: 500, writeReason: '群内已禁言' }); render(<TaskForm client={f.client} userId="u1" conversations={[group]} initialGroupId="g1" meta={meta} onSaved={vi.fn()} onClose={vi.fn()} />); await screen.findByText('群内已禁言'); expect(screen.getByRole('button', { name: '确认创建待办' })).toBeDisabled(); expect(f.mock.create).not.toHaveBeenCalled();
  });
});

describe('task capabilities, cards and shared list state', () => {
  it('requires incomplete checklist confirmation and never toggles checks while completing', async () => {
    const value = { ...task, checkItems: [{ id: 'c1', text: '核对', done: false, position: 0 }] }; const f = fixture(value); render(<TaskActionDialog client={f.client} task={value} action={{ kind: 'status', status: 'done' }} onClose={vi.fn()} />); expect(screen.getByRole('button', { name: '确认提交操作' })).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox', { name: /保留未勾选检查项/ })); fireEvent.click(screen.getByRole('button', { name: '确认提交操作' })); await screen.findByText('服务器已确认此项操作。'); expect(f.mock.patch.mock.calls[0][1]).toEqual({ status: 'done', confirmIncomplete: true }); expect(value.checkItems[0].done).toBe(false);
  });
  it('immediately hides a live card body and task target on permission invalidation', async () => {
    const f = fixture(); render(<TaskCardView client={f.client} messageId="m1" onOpenTask={vi.fn()} onSaveSnapshot={vi.fn()} />); await screen.findByText('采购清单'); act(() => f.set({ invalid: { t1: true } })); expect(screen.queryByText('采购清单')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '查看任务' })).not.toBeInTheDocument();
  });
  it('snapshot exposes only creating an independent personal task, never original task access', async () => {
    const f = fixture(); const snapshot = { title: '公开静态文字', priority: 'high', dueOn: null, dueTimezone: 'Asia/Shanghai' }; f.mock.card.mockResolvedValue({ kind: 'snapshot', snapshot }); const save = vi.fn(); const open = vi.fn(); render(<TaskCardView client={f.client} messageId="m-snapshot" onOpenTask={open} onSaveSnapshot={save} />); fireEvent.click(await screen.findByRole('button', { name: '存为我的待办' })); expect(save).toHaveBeenCalledWith({ messageId: 'm-snapshot', value: snapshot }); expect(open).not.toHaveBeenCalled(); expect(screen.queryByText(/任务编号/)).not.toBeInTheDocument();
  });
  it('uses actor-scoped group member pages, including later pages for assignment', async () => {
    request.mockResolvedValueOnce({ items: [{ user: { ...person, id: 'u2', nickname: '成员二', username: 'two' } }], nextCursor: 'members2' }).mockResolvedValueOnce({ items: [{ user: { ...person, id: 'u3', nickname: '成员三', username: 'three' } }], nextCursor: null }); render(<AssignmentPicker groupId="g1" userId="u1" value="u1" onChange={vi.fn()} allowOthers />); await screen.findByRole('option', { name: '成员二 (@two)' }); fireEvent.click(screen.getByRole('button', { name: '加载更多当前群成员' })); await screen.findByRole('option', { name: '成员三 (@three)' }); expect(request).toHaveBeenLastCalledWith('/api/v1/groups/g1/members?after=members2', expect.objectContaining({ actorContext: 'u1', signal: expect.any(AbortSignal) }));
  });
  it('uses cursor filters and hides stale canonical entities in the workspace', async () => {
    const f = fixture(); f.mock.list.mockResolvedValue({ items: [task], total: 31, actorId: 'u1', nextCursor: 'page2' }); render(<TaskWorkspace client={f.client} userId="u1" conversations={[]} contacts={[]} onOpenSource={vi.fn()} />); await screen.findByText('采购清单'); fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '采购' } }); fireEvent.click(screen.getByRole('button', { name: '应用待办筛选' })); await waitFor(() => expect(f.mock.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '采购', limit: 30 }))); await screen.findByRole('button', { name: '下一页待办' }); fireEvent.click(screen.getByRole('button', { name: '下一页待办' })); await waitFor(() => expect(f.mock.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '采购', after: 'page2' }))); act(() => f.set({ invalid: { t1: true } })); expect(screen.queryByText('采购清单')).not.toBeInTheDocument();
  });
});

describe('sharing and draft review', () => {
  it('retries only a static card with the same key after an uncertain share, without recreating the task', async () => {
    const f = fixture(); f.mock.share.mockRejectedValueOnce(new APIError(0, { message: '卡片结果未确认' })); render(<TaskShareDialog client={f.client} task={task} conversations={[group]} contacts={[]} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText('发送到会话'), { target: { value: 'g1' } }); fireEvent.click(screen.getByRole('checkbox', { name: /我已核对以上内容/ })); fireEvent.click(screen.getByRole('button', { name: '确认发送卡片' })); fireEvent.click(await screen.findByRole('button', { name: '以同一编号核对卡片发送' })); await screen.findByText('卡片消息已发送'); expect(f.mock.share.mock.calls[1]).toEqual(f.mock.share.mock.calls[0]); expect(f.mock.share.mock.calls[0][1]).toEqual({ destinationConversationId: 'g1', mode: 'snapshot', includeDescription: false }); expect(f.mock.create).not.toHaveBeenCalled();
  });
  it('filters account drafts and requires explicit confirmation before opening the submission form', async () => {
    const f = fixture(); const draft = { id: 'd1', userId: 'u1', kind: 'create', taskId: null, baseEtag: null, payload: { title: '自己的草稿' }, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 100000 } as TaskDraft; f.mock.drafts.mockResolvedValue([draft, { ...draft, id: 'd2', userId: 'u2', payload: { title: '他人草稿' } }]); f.mock.reviewDraft.mockResolvedValue({ draft, latest: null, expired: false }); const review = vi.fn(); render(<TaskDrafts client={f.client} onReview={review} />); await screen.findByText('自己的草稿'); expect(screen.queryByText('他人草稿')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '联网核对身份、权限与版本' })); await screen.findByRole('region', { name: '草稿复核结果' }); expect(review).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '打开表单核对提交' })).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox', { name: /我确认打开表单/ })); fireEvent.click(screen.getByRole('button', { name: '打开表单核对提交' })); expect(review).toHaveBeenCalledWith(draft, null); expect(f.mock.create).not.toHaveBeenCalled();
  });
  it('expired draft needs a separate new local draft and cannot open direct submission', async () => {
    const f = fixture(); const draft = { id: 'expired', userId: 'u1', kind: 'create', taskId: null, baseEtag: null, payload: { title: '过期输入' }, createdAt: 1, updatedAt: 1, expiresAt: 2 } as TaskDraft; f.mock.drafts.mockResolvedValue([draft]); f.mock.reviewDraft.mockResolvedValue({ draft, latest: null, expired: true }); f.mock.saveDraft.mockResolvedValue({ ...draft, id: 'new' }); const review = vi.fn(); render(<TaskDrafts client={f.client} onReview={review} />); fireEvent.click(await screen.findByRole('button', { name: '联网核对身份、权限与版本' })); await screen.findByRole('button', { name: '以此输入创建新草稿' }); expect(screen.queryByRole('button', { name: '打开表单核对提交' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('checkbox', { name: /确认仅创建新的本机草稿/ })); fireEvent.click(screen.getByRole('button', { name: '以此输入创建新草稿' })); await waitFor(() => expect(f.mock.saveDraft).toHaveBeenCalledTimes(1)); expect(f.mock.saveDraft.mock.calls[0][0]).not.toHaveProperty('id'); expect(review).not.toHaveBeenCalled(); expect(f.mock.create).not.toHaveBeenCalled();
  });
});
describe('enhanced task interactions', () => {
  it('refreshes discussion for a new personal etag even if the public version stays unchanged', async () => {
    const f = fixture(); const props = { client: f.client, enhanced: true, onRemoveComment: vi.fn(), onReportComment: vi.fn() }; const view = render(<TaskActivityPanel {...props} task={task} />); await screen.findByText('当前可读范围内没有活动记录。'); expect(f.mock.activities).toHaveBeenCalledTimes(1); view.rerender(<TaskActivityPanel {...props} task={{ ...task, etag: '"v1-personal2"' }} />); await waitFor(() => expect(f.mock.activities).toHaveBeenCalledTimes(2));
  });
  it('keeps a typed comment and key after an uncertain result and submits only once per user retry', async () => {
    const f = fixture(); f.mock.addComment.mockRejectedValueOnce(new APIError(0, { message: '评论响应未确认' })); render(<TaskActivityPanel client={f.client} task={task} enhanced onRemoveComment={vi.fn()} onReportComment={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '任务评论' })); fireEvent.change(screen.getByLabelText('添加任务评论'), { target: { value: '请确认细节' } }); fireEvent.click(screen.getByRole('button', { name: '提交评论' })); await screen.findByRole('button', { name: '核对并重试同一评论' }); expect(screen.getByLabelText('添加任务评论')).toHaveValue('请确认细节'); fireEvent.click(screen.getByRole('button', { name: '核对并重试同一评论' })); await screen.findByText('评论已由服务器保存。'); expect(f.mock.addComment.mock.calls[1]).toEqual(f.mock.addComment.mock.calls[0]); expect(screen.getByLabelText('添加任务评论')).toHaveValue('');
  });
  it('saves selected notification preferences with an exact stable command on uncertain retry', async () => {
    const f = fixture(); f.mock.preferences.mockRejectedValueOnce(new APIError(0, { message: '偏好结果未确认' })); render(<TaskPreferencesForm client={f.client} preferences={meta.preferences} onSaved={vi.fn()} />); fireEvent.click(screen.getByRole('checkbox', { name: '评论通知' })); fireEvent.click(screen.getByRole('button', { name: '保存待办偏好' })); fireEvent.click(await screen.findByRole('button', { name: '核对并重试同一偏好设置' })); await screen.findByText('待办通知偏好已保存。'); expect(f.mock.preferences.mock.calls[1]).toEqual(f.mock.preferences.mock.calls[0]); expect(f.mock.preferences.mock.calls[0][0]).toEqual({ ...meta.preferences, comments: false });
  });
  it('creates an acknowledged separate group entity without patching or sharing the personal original', async () => {
    const f = fixture(); render(<TaskForm client={f.client} userId="u1" task={task} mode="copy" initialGroupId="g1" conversations={[group]} meta={meta} onSaved={vi.fn()} onClose={vi.fn()} />); await waitFor(() => expect(f.mock.groupSettings).toHaveBeenCalled()); fireEvent.click(screen.getByRole('checkbox', { name: /确认创建新群实体/ })); await waitFor(() => expect(screen.getByRole('button', { name: '确认创建群副本' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: '确认创建群副本' })); await screen.findByText('新的群待办已创建'); expect(f.mock.copyToGroup.mock.calls[0][1]).toEqual(expect.objectContaining({ title: task.title, groupId: 'g1', acknowledgeShared: true })); expect(f.mock.patch).not.toHaveBeenCalled(); expect(f.mock.share).not.toHaveBeenCalled();
  });
});

describe('V3 review authority repair', () => {
  const editDraft = { id: 'review-edit', userId: 'u1', kind: 'edit', taskId: 't1', baseEtag: '"v1"', payload: { title: '本人草稿标题', description: '本人草稿描述' }, createdAt: 1, updatedAt: 2, expiresAt: Date.now() + 600000 } as TaskDraft;
  it('hides reviewed server fields immediately on revocation while preserving the local draft', async () => {
    const value = { ...task, title: 'SERVER-REVIEW-TITLE', description: 'SERVER-REVIEW-BODY', scope: 'group' as const, groupId: 'g1' }; const f = fixture(value); f.mock.drafts.mockResolvedValue([editDraft]); f.mock.reviewDraft.mockResolvedValue({ draft: editDraft, latest: value, expired: false }); const open = vi.fn(); render(<TaskDrafts client={f.client} onReview={open} />);
    fireEvent.click(await screen.findByRole('button', { name: '联网核对身份、权限与版本' })); await screen.findByRole('region', { name: '草稿与最新版本核对' }); expect(screen.getByText('最新值：SERVER-REVIEW-BODY')).toBeInTheDocument();
    act(() => f.set({ entities: {}, invalid: { t1: true }, listRevision: 1 })); expect(screen.queryByText('最新值：SERVER-REVIEW-BODY')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '保留我的输入，采用最新版本继续核对' })).not.toBeInTheDocument(); expect(screen.getByText('本人草稿标题')).toBeInTheDocument(); expect(f.mock.deleteDraft).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('requires a fresh explicit draft review after invalidation and canonical GET recovery', async () => {
    const f = fixture(); f.mock.drafts.mockResolvedValue([editDraft]); f.mock.reviewDraft.mockResolvedValue({ draft: editDraft, latest: task, expired: false }); const open = vi.fn(); render(<TaskDrafts client={f.client} onReview={open} />);
    fireEvent.click(await screen.findByRole('button', { name: '联网核对身份、权限与版本' })); await screen.findByRole('region', { name: '草稿与最新版本核对' }); act(() => f.set({ invalid: { t1: true }, listRevision: 1 })); const latest = { ...task, title: '更新后的服务器标题', etag: '"v2"', version: 2 }; act(() => f.set({ entities: { t1: latest }, invalid: {} })); expect(screen.queryByRole('button', { name: '保留我的输入，采用最新版本继续核对' })).not.toBeInTheDocument();
    f.mock.reviewDraft.mockResolvedValue({ draft: editDraft, latest, expired: false }); fireEvent.click(screen.getByRole('button', { name: '联网核对身份、权限与版本' })); await screen.findByText('最新值：更新后的服务器标题'); fireEvent.click(screen.getByRole('button', { name: '保留我的输入，采用最新版本继续核对' })); expect(open).toHaveBeenCalledExactlyOnceWith(editDraft, latest); expect(f.mock.deleteDraft).not.toHaveBeenCalled();
  });
});

describe('task preference dialog', () => {
  it('opens preferences over the current list, preserves unsent filters and returns focus on close', async () => {
    const f = fixture();
    render(<TaskWorkspace client={f.client} userId="u1" conversations={[group]} contacts={[]} onOpenSource={vi.fn()} initialMeta={meta} />);
    await screen.findByText(task.title);
    const keyword = screen.getByLabelText('关键词'); fireEvent.change(keyword, { target: { value: '尚未提交的筛选' } });
    const trigger = screen.getByRole('button', { name: '偏好与分类' }); trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '我的待办偏好' });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.getByText(task.title)).toBeInTheDocument();
    expect(screen.getByLabelText('关键词')).toBe(keyword);
    expect(keyword).toHaveValue('尚未提交的筛选');
    fireEvent.click(within(dialog).getByRole('tab', { name: '清单与标签' }));
    expect(within(dialog).getByRole('button', { name: '创建个人清单' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '我的待办偏好' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus(); expect(keyword).toHaveValue('尚未提交的筛选');
    expect(screen.getByText(task.title)).toBeInTheDocument();
  });

  it('keeps the preference dialog open while saving and submits all four notification choices', async () => {
    const f = fixture(); const saving = deferred<typeof meta.preferences>(); f.mock.preferences.mockReturnValueOnce(saving.promise);
    render(<TaskWorkspace client={f.client} userId="u1" conversations={[group]} contacts={[]} onOpenSource={vi.fn()} initialMeta={meta} />);
    await screen.findByText(task.title); fireEvent.click(screen.getByRole('button', { name: '偏好与分类' }));
    const dialog = await screen.findByRole('dialog', { name: '我的待办偏好' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '评论通知' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存待办偏好' }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: '关闭对话框' })).not.toBeInTheDocument());
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).toHaveAttribute('open');
    expect(f.mock.preferences).toHaveBeenCalledWith({ ...meta.preferences, comments: false }, expect.any(String));
    await act(async () => saving.resolve({ ...meta.preferences, comments: false }));
    await within(dialog).findByText('待办通知偏好已保存。');
    expect(within(dialog).getByRole('button', { name: '关闭对话框' })).toBeEnabled();
  });
});