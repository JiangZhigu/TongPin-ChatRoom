// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatState, Contact, Conversation, Draft, FriendRequest, LocalAttachment, Message, QueuedMessage } from './lib/chat-types';
import type { UserView } from './auth-types';
import { ChatWorkspace } from './ChatWorkspace';
import { AccountSettings } from './AccountSettings';
import { ContactsPage } from './ContactsPage';
import { Composer } from './components/Composer';
import { OfflineRecoveryPage } from './OfflineRecoveryPage';
import { APIError } from './lib/api';
import type { OfflineLocalSnapshot } from './lib/outbox';
import type { Task, TaskMeta, TaskState, TaskDraft } from './lib/tasks-types';
import { NotificationsPage } from './NotificationsPage';
import { NavigationRail } from './components/NavigationRail';
const taskUI = vi.hoisted(() => ({ state: null as TaskState | null, listeners: new Set<() => void>(), start: vi.fn(), stop: vi.fn(), meta: vi.fn(), get: vi.fn(), list: vi.fn(), card: vi.fn(), create: vi.fn(), groupSettings: vi.fn(), activities: vi.fn(), comments: vi.fn(), users: [] as string[] }));
vi.mock('./lib/tasks-client', () => ({ taskCommandKey: () => crypto.randomUUID(), TaskClient: class {
  userId: string; constructor(id: string) { this.userId = id; taskUI.users.push(id); }
  subscribe = (fn: () => void) => { taskUI.listeners.add(fn); return () => { taskUI.listeners.delete(fn); }; }; getSnapshot = () => taskUI.state!;
  start = taskUI.start; stop = taskUI.stop; meta = taskUI.meta; get = taskUI.get; list = taskUI.list; card = taskUI.card; create = taskUI.create; groupSettings = taskUI.groupSettings; activities = taskUI.activities; comments = taskUI.comments;
} }));

const offline = vi.hoisted(() => ({
  read: vi.fn<(revision?: string, cursor?: string) => Promise<OfflineLocalSnapshot | null>>(),
  remove: vi.fn<(revision: string, kind: 'outbox' | 'draft' | 'taskDraft', key: string) => Promise<void>>(),
  listeners: new Set<(kind: 'identity' | 'content' | 'check') => void>(),
}));
vi.mock('./lib/outbox', () => ({
  readOfflineSnapshot: offline.read, removeOfflineItem: offline.remove,
  subscribeOfflineChanges: (listener: (kind: 'identity' | 'content' | 'check') => void) => { offline.listeners.add(listener); return () => { offline.listeners.delete(listener); }; },
}));

const chat = vi.hoisted(() => ({
  state: null as ChatState | null, listeners: new Set<() => void>(), taskEvents: new Set<(event: { type: string; entityRef: string; conversationId: string | null }) => void>(),
  start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => void>(), updateUser: vi.fn(),
  select: vi.fn<(id: string | null) => Promise<void>>(), older: vi.fn<() => Promise<void>>(),
  queue: vi.fn<(id: string, text: string, options?: { files: LocalAttachment[]; replyToMessageId?: string | null; mentionedUserIds?: string[]; mentionAll?: boolean }) => Promise<void>>(), retry: vi.fn<(id: string) => Promise<void>>(), cancel: vi.fn<(id: string) => Promise<void>>(),
  getDraft: vi.fn<(id: string) => Promise<Draft | null>>(), saveDraft: vi.fn<(id: string, text: string, position?: unknown) => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(), read: vi.fn<(id: string, seq: string) => Promise<void>>(),
  summary: vi.fn<() => Promise<{ pending: number; drafts: number; taskDrafts?: number }>>(), logout: vi.fn<(choice: 'keep' | 'delete') => Promise<void>>(),
  jump: vi.fn<(id: string) => Promise<void>>(), newer: vi.fn<() => Promise<void>>(), typing: vi.fn(), beginUpdate: vi.fn(), bookmark: vi.fn(), apply: vi.fn(), finishDeletion: vi.fn(), prepareDeletion: vi.fn(), resumeDeletion: vi.fn(),
  more: vi.fn<() => Promise<void>>(), histories: {} as Record<string, Message[]>,
}));
vi.mock('./lib/chat-client', () => ({ ChatClient: class {
  getSnapshot = () => chat.state!;
  subscribeTaskEvents = (listener: (event: { type: string; entityRef: string; conversationId: string | null }) => void) => { chat.taskEvents.add(listener); return () => { chat.taskEvents.delete(listener); }; };
  subscribe = (listener: () => void) => { chat.listeners.add(listener); return () => { chat.listeners.delete(listener); }; };
  start = chat.start; stop = chat.stop; updateUser = chat.updateUser; selectConversation = chat.select; loadOlder = chat.older;
  queue = chat.queue; retry = chat.retry; cancel = chat.cancel; getDraft = chat.getDraft; saveDraft = chat.saveDraft;
  refresh = chat.refresh; read = chat.read; getLocalSummary = chat.summary; logout = chat.logout;
  jumpToMessage = chat.jump; loadNewer = chat.newer; typing = chat.typing; applyMessage = chat.apply; beginMessageUpdate = chat.beginUpdate; applyBookmark = chat.bookmark; finishAccountDeletion = chat.finishDeletion; prepareAccountDeletion = chat.prepareDeletion; resumeAccountAfterDeletionFailure = chat.resumeDeletion;
  loadMoreConversations = chat.more; loadMoreContacts = chat.more; loadMoreRequests = chat.more; loadMoreNotifications = chat.more;
} }));

const user: UserView = { id: 'ui-user', username: 'ui_user', nickname: '本人', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const peer: Contact = { id: 'ui-peer', username: 'ui_peer', nickname: '测试好友', relationship: 'friend', requestId: null, online: false, blocked: false, notifyOnline: false };
const conversation = (id = 'dm-a', title = '测试好友'): Conversation => ({ id, title, kind: 'direct', description: '', peer, role: 'member', periodId: null, memberCount: 2, lastSeq: '0', readSeq: '0', peerReadSeq: null, unreadCount: 0, lastMessage: null, canSend: true, sendDisabledReason: null, sendErrorCode: null, accessKey: 'test-access', updatedAt: 1, preferences: { muted: false, pinned: false, archived: false } });
const message = (id = 'message-1', seq = '1', text = '一条真实形状的测试消息'): Message => ({ id, conversationId: 'dm-a', seq, senderId: peer.id, sender: peer, clientMessageId: null, kind: 'user', text, status: 'sent', createdAt: 1, replyToMessageId: null, reply: null, mentionedUserIds: [], attachments: [], reactions: [] });
const queued = (text = '已保存的待发内容', state: QueuedMessage['state'] = 'queued'): QueuedMessage => ({ key: 'ui-user:client-id', userId: user.id, conversationId: 'dm-a', conversationTitle: '测试好友', payload: { clientMessageId: 'same-client-id', text, attachmentIds: [], replyToMessageId: null, mentionedUserIds: [], accessKey: 'test-access' }, createdAt: Date.now(), expiresAt: Date.now() + 86400000, state, attempts: 0, retryAt: 0, error: state === 'failed' ? '权限已经变化' : null, errorCode: state === 'failed' ? 'STALE_ACCESS' : null, files: [] });
const freshState = (): ChatState => ({ phase: 'online', conversations: [conversation()], contacts: [peer], requests: [], notifications: [], notificationCount: 0, selectedId: null, messages: [], historyBefore: null, historyLoading: false, outbox: [], error: null, nextConversations: null, nextContacts: null, nextRequests: null, nextNotifications: null, onlineNotice: null });
function publish(patch: Partial<ChatState>) { chat.state = { ...chat.state!, ...patch }; for (const listener of chat.listeners) listener(); }
const response = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function showWorkspace(onSignedOut = vi.fn()) { return render(<ChatWorkspace user={user} onUserChange={vi.fn()} onSignedOut={onSignedOut} />); }
async function openConversation(title = '测试好友') { fireEvent.click(within(screen.getByLabelText('会话列表')).getByRole('button', { name: new RegExp(title) })); await waitFor(() => expect(screen.getByLabelText('消息内容')).toBeEnabled()); }
function dimensions(element: HTMLElement, initialHeight = 1000, initialTop = 200) {
  let height = initialHeight; let top = initialTop;
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 300 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => top, set: (value) => { top = Math.max(0, Math.min(value, height - 300)); } });
  return { setHeight: (value: number) => { height = value; }, top: () => top };
}
beforeEach(() => {
  for (const value of Object.values(chat)) if (vi.isMockFunction(value)) value.mockReset();
  chat.listeners.clear(); chat.taskEvents.clear(); chat.state = freshState(); chat.histories = {};
  for (const value of Object.values(taskUI)) if (vi.isMockFunction(value)) value.mockReset(); taskUI.listeners.clear(); taskUI.users = [];
  taskUI.state = { revision: 0, listRevision: 0, entities: {}, invalid: {}, online: false, enabled: true, enhanced: true, error: null };
  offline.read.mockReset().mockResolvedValue(null); offline.remove.mockReset().mockResolvedValue(); offline.listeners.clear();
  chat.start.mockResolvedValue(); chat.queue.mockResolvedValue(); chat.retry.mockResolvedValue(); chat.cancel.mockResolvedValue(); chat.older.mockResolvedValue();
  chat.getDraft.mockResolvedValue(null); chat.saveDraft.mockResolvedValue(); chat.refresh.mockResolvedValue(); chat.read.mockResolvedValue(); chat.logout.mockResolvedValue(); chat.more.mockResolvedValue(); chat.summary.mockResolvedValue({ pending: 0, drafts: 0 });
  chat.select.mockImplementation(async (id) => { publish({ selectedId: id, messages: id ? chat.histories[id] || [] : [], historyLoading: false }); });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  vi.stubGlobal('fetch', vi.fn(() => response({ items: [], nextCursor: null })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('M6-UI attachment draft lifecycle', () => {
  const local = (name = '保留.txt'): LocalAttachment => ({ id: name, name, mime: 'text/plain', blob: new File(['真实附件正文'], name, { type: 'text/plain' }) });
  it('saves selected bytes before reporting persistence and allows an attachment-only queue commit', async () => {
    const saving = deferred<void>(); chat.saveDraft.mockImplementation(() => saving.promise);
    showWorkspace(); await openConversation(); const file = new File(['选入的真实字节'], '说明.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [file] } });
    await waitFor(() => expect(chat.saveDraft).toHaveBeenCalledWith('dm-a', '', expect.objectContaining({ files: [expect.objectContaining({ blob: file, name: '说明.txt' })] })));
    expect(screen.getByText('正在保存附件草稿…')).toBeInTheDocument(); expect(screen.queryByText('草稿已保存到本机')).not.toBeInTheDocument();
    await act(async () => saving.resolve()); await screen.findByText('草稿已保存到本机');
    const queue = deferred<void>(); chat.queue.mockImplementation(() => queue.promise); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat.queue).toHaveBeenCalledWith('dm-a', '', { files: [expect.objectContaining({ blob: file })], replyToMessageId: null, mentionedUserIds: [], mentionAll: false })); expect(screen.getByText('说明.txt')).toBeInTheDocument();
    await act(async () => queue.resolve()); await waitFor(() => expect(screen.queryByText('说明.txt')).not.toBeInTheDocument()); expect(chat.saveDraft).toHaveBeenLastCalledWith('dm-a', '', expect.objectContaining({ files: [] }));
  });
  it('retains attachment bytes when local quota prevents draft or queue commit', async () => {
    chat.saveDraft.mockRejectedValue(new Error('本机附件已达到 50 MiB 上限')); chat.queue.mockRejectedValue(new Error('本机附件已达到 50 MiB 上限'));
    showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [new File(['保留'], '未保存.txt', { type: 'text/plain' })] } });
    await screen.findByText('附件尚未保存到本机，请保留此页面并重试'); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalled());
    expect(screen.getByText('未保存.txt')).toBeInTheDocument(); expect(screen.getByLabelText('消息内容')).toBeEnabled();
  });
  it('does not clear newly selected attachments when an older message finishes entering the queue', async () => {
    showWorkspace(); await openConversation(); const first = new File(['一'], '第一件.txt', { type: 'text/plain' }); const second = new File(['二'], '第二件.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [first] } }); await screen.findByText('草稿已保存到本机');
    const queue = deferred<void>(); chat.queue.mockImplementation(() => queue.promise); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [second] } }); await act(async () => queue.resolve());
    expect(screen.getByText('第二件.txt')).toBeInTheDocument(); expect(screen.queryByText('第一件.txt')).not.toBeInTheDocument(); expect(chat.queue.mock.calls[0][2]?.files).toHaveLength(1); expect(chat.saveDraft.mock.calls.at(-1)?.[2]).toMatchObject({ files: [expect.objectContaining({ name: '第二件.txt' })] });
  });
  it('restores conversation attachments, removes only the selected item and saves before navigating', async () => {
    chat.state!.conversations.push(conversation('dm-b', '另一好友')); const files = [local('A.txt'), local('B.txt')];
    chat.getDraft.mockImplementation(async (id) => id === 'dm-a' ? { key: 'draft-a', userId: user.id, conversationId: id, text: '', files, updatedAt: 1 } : null);
    showWorkspace(); await openConversation(); expect(screen.getByText('A.txt')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '移除附件 A.txt' }));
    await waitFor(() => expect(chat.saveDraft).toHaveBeenCalledWith('dm-a', '', expect.objectContaining({ files: [files[1]] })));
    await openConversation('另一好友'); expect(screen.queryByText('B.txt')).not.toBeInTheDocument(); expect(chat.saveDraft).toHaveBeenLastCalledWith('dm-a', '', expect.objectContaining({ files: [files[1]] }));
  });
  it('copies failed queue attachments into a separate draft without reusing their upload binding', async () => {
    const pending = { ...queued('', 'failed'), files: [{ ...local(), attachmentId: 'old-upload', phase: 'failed' as const, error: '失权' }] }; chat.state!.outbox = [pending];
    showWorkspace(); fireEvent.click(screen.getByRole('button', { name: /本机待发 1/ })); await screen.findByRole('heading', { name: '本机待发' }); fireEvent.click(screen.getByRole('button', { name: '复制到编辑器' }));
    await waitFor(() => expect(chat.saveDraft).toHaveBeenCalledWith('dm-a', '', expect.objectContaining({ files: [expect.objectContaining({ name: pending.files[0].name, attachmentId: undefined, phase: undefined })] })));
    expect(screen.getByText(/原失败项仍在本机待发中/)).toBeInTheDocument();
    const saved = chat.saveDraft.mock.calls.at(-1)?.[2] as { files: LocalAttachment[] }; expect(saved.files[0].id).not.toBe(pending.files[0].id); expect(chat.queue).not.toHaveBeenCalled(); expect(chat.cancel).not.toHaveBeenCalled();
  });
  it('preserves attachment drafts against a late scroll timer during revoked conversation cleanup', async () => {
    const files = [local()]; chat.getDraft.mockResolvedValue({ key: 'draft-a', userId: user.id, conversationId: 'dm-a', text: '', files, updatedAt: 1 }); showWorkspace(); await openConversation();
    const commit = deferred<void>(); chat.saveDraft.mockImplementation(() => commit.promise); await act(async () => publish({ selectedId: null, conversations: [], messages: [] }));
    await waitFor(() => expect(chat.saveDraft).toHaveBeenCalled()); fireEvent.scroll(screen.getByLabelText('消息记录')); await act(async () => commit.resolve()); await screen.findByRole('heading', { name: '欢迎来到同频' });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 420))); expect(chat.saveDraft.mock.calls.every((call) => (call[2] as { files: LocalAttachment[] }).files === files)).toBe(true);
  });
});

describe('M6-FIX-UI committed attachment drafts', () => {
  const file = (id: string): LocalAttachment => ({ id, name: `${id}.txt`, mime: 'text/plain', blob: new File([id], `${id}.txt`, { type: 'text/plain' }) });
  function persistence() {
    const drafts = new Map<string, { text: string; files: LocalAttachment[] }>([['dm-a', { text: '原正文', files: [file('A')] }], ['dm-b', { text: '另一个会话', files: [file('C')] }]]);
    chat.getDraft.mockImplementation(async (id) => ({ key: id, userId: user.id, conversationId: id, updatedAt: 1, ...drafts.get(id)! }));
    const write = (id: string, text: string, position?: unknown) => { drafts.set(id, { text, files: [...((position as { files?: LocalAttachment[] })?.files || [])] }); };
    chat.saveDraft.mockImplementation(async (id, text, position) => write(id, text, position));
    const commit = (id: string, submitted: LocalAttachment[]) => { const draft = drafts.get(id)!; drafts.set(id, { ...draft, files: draft.files.filter((value) => !submitted.some((item) => item.id === value.id)) }); };
    return { drafts, write, commit };
  }
  it('persists only newly added B after A commits and the next queue contains only B', async () => {
    const { drafts, commit } = persistence(); const queue = deferred<void>(); chat.queue.mockImplementation(async (id, _text, options) => { await queue.promise; commit(id, options!.files); });
    showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [new File(['B'], 'B.txt', { type: 'text/plain' })] } });
    await act(async () => queue.resolve()); await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    expect(drafts.get('dm-a')?.files.map((value) => value.name)).toEqual(['B.txt']); expect(drafts.get('dm-a')?.text).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalledTimes(2)); expect(chat.queue.mock.calls[1][2]?.files.map((value) => value.name)).toEqual(['B.txt']);
  });
  it('keeps new text but clears A even when its text autosave was captured before queue completion', async () => {
    const { drafts, commit } = persistence(); const queue = deferred<void>(); chat.queue.mockImplementation(async (id, _text, options) => { await queue.promise; commit(id, options!.files); });
    showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '发送期间的新文本' } }); await act(async () => new Promise((resolve) => setTimeout(resolve, 400))); await act(async () => queue.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()); expect(drafts.get('dm-a')).toMatchObject({ text: '发送期间的新文本', files: [] });
    fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalledTimes(2)); expect(chat.queue.mock.calls[1]).toEqual(['dm-a', '发送期间的新文本', { files: [], replyToMessageId: null, mentionedUserIds: [], mentionAll: false }]);
  });
  it.each([false, true])('M6-FIX2 preserves the newest full draft before debounce fires, removed B=%s', async (removeB) => {
    const { drafts, commit, write } = persistence(); const queue = deferred<void>(); const snapshots: { text: string; names: string[] }[] = [];
    chat.saveDraft.mockImplementation(async (id, text, position) => { write(id, text, position); if (id === 'dm-a') snapshots.push({ text, names: drafts.get(id)!.files.map((value) => value.name) }); });
    chat.queue.mockImplementation(async (id, _text, options) => { await queue.promise; commit(id, options!.files); });
    const view = showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalled());
    // Adding B captures the old text version in an immediate save. Do not
    // advance the 350 ms debounce after editing or removing that attachment.
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [new File(['B'], 'B.txt', { type: 'text/plain' })] } });
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '无需等待防抖的新正文' } });
    if (removeB) fireEvent.click(screen.getByRole('button', { name: '移除附件 B.txt' }));
    await act(async () => queue.resolve()); await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    const names = removeB ? [] : ['B.txt']; expect(drafts.get('dm-a')?.text).toBe('无需等待防抖的新正文'); expect(drafts.get('dm-a')?.files.map((value) => value.name)).toEqual(names);
    // No older write may briefly regress the state after reconciliation either.
    expect(snapshots.every((saved) => saved.text === '无需等待防抖的新正文' && JSON.stringify(saved.names) === JSON.stringify(names))).toBe(true);
    view.unmount(); showWorkspace(); await openConversation(); expect(screen.getByLabelText('消息内容')).toHaveValue('无需等待防抖的新正文');
    fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalledTimes(2)); expect(chat.queue.mock.calls[1][1]).toBe('无需等待防抖的新正文'); expect(chat.queue.mock.calls[1][2]?.files.map((value) => value.name)).toEqual(names);
  });
  it('serializes a delayed earlier save, queue commit and during-queue saves without restoring transferred A', async () => {
    const { drafts, write, commit } = persistence(); const earlier = deferred<void>(); const queue = deferred<void>(); const later = deferred<void>(); let writes = 0;
    chat.saveDraft.mockImplementation(async (id, text, position) => { writes++; await (writes === 1 ? earlier.promise : later.promise); write(id, text, position); });
    chat.queue.mockImplementation(async (id, _text, options) => { await queue.promise; commit(id, options!.files); });
    showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '此次提交正文' } }); await waitFor(() => expect(writes).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: '发送' })); await act(async () => Promise.resolve()); expect(chat.queue).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [new File(['B'], 'B.txt', { type: 'text/plain' })] } }); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '后续正文' } });
    await act(async () => earlier.resolve()); await waitFor(() => expect(chat.queue).toHaveBeenCalled()); await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    await act(async () => queue.resolve()); await act(async () => later.resolve()); await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    expect(drafts.get('dm-a')?.text).toBe('后续正文'); expect(drafts.get('dm-a')?.files.map((value) => value.name)).toEqual(['B.txt']);
    fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalledTimes(2)); expect(chat.queue.mock.calls[1][2]?.files.map((value) => value.name)).toEqual(['B.txt']);
  });
  it('keeps A and new edits after a failed queue and allows deferred draft saves to complete', async () => {
    const { drafts } = persistence(); const queue = deferred<void>(); chat.queue.mockImplementation(() => queue.promise);
    showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [new File(['B'], 'B.txt', { type: 'text/plain' })] } }); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '失败时的新文本' } }); await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    await act(async () => queue.reject(new Error('本机入队失败'))); await screen.findByText('本机入队失败'); await waitFor(() => expect(drafts.get('dm-a')?.text).toBe('失败时的新文本'));
    expect(drafts.get('dm-a')?.files.map((value) => value.name)).toEqual(['A.txt', 'B.txt']); expect(screen.getByText('A.txt')).toBeInTheDocument();
  });
  it('finishes the source draft transfer before switching and never changes the destination draft', async () => {
    const { drafts, commit } = persistence(); chat.state!.conversations.push(conversation('dm-b', '另一好友')); const queue = deferred<void>(); chat.queue.mockImplementation(async (id, _text, options) => { await queue.promise; commit(id, options!.files); });
    showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalled()); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '离开前新文本' } });
    fireEvent.click(within(screen.getByLabelText('会话列表')).getByRole('button', { name: /另一好友/ })); await act(async () => queue.resolve()); await waitFor(() => expect(screen.getByLabelText('消息内容')).toHaveValue('另一个会话'));
    expect(drafts.get('dm-a')).toMatchObject({ text: '离开前新文本', files: [] }); expect(drafts.get('dm-b')).toMatchObject({ text: '另一个会话', files: [expect.objectContaining({ id: 'C' })] }); expect(screen.getByText('C.txt')).toBeInTheDocument();
    await openConversation(); expect(screen.getByLabelText('消息内容')).toHaveValue('离开前新文本'); expect(screen.queryByText('A.txt')).not.toBeInTheDocument();
  });
});

describe('M6-UI offline attachment recovery and limits', () => {
  it('rejects a seventh file through shared validation while preserving the six selected files', async () => {
    showWorkspace(); await openConversation(); const files = Array.from({ length: 6 }, (_, index) => new File(['字节'], `${index}.txt`, { type: 'text/plain' }));
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files } }); await screen.findByText('草稿已保存到本机');
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [new File(['七'], '第七.txt', { type: 'text/plain' })] } });
    await screen.findByText('每条消息最多添加6个附件。'); expect(screen.queryByText('第七.txt')).not.toBeInTheDocument(); expect(screen.getAllByRole('button', { name: /移除附件/ })).toHaveLength(6);
  });
  it('shows attachment-only offline drafts and checks the held identity immediately before downloading bytes', async () => {
    const blob = new File(['离线正文'], '离线.txt', { type: 'text/plain' }); const data = offlineData(); data.drafts = [{ ...data.drafts[0], text: '', files: [{ id: 'offline-file', name: '离线.txt', mime: 'text/plain', blob }] }]; offline.read.mockResolvedValue(data);
    const create = vi.fn(() => 'blob:offline-copy'); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />); await screen.findByText('离线.txt'); fireEvent.click(screen.getByRole('button', { name: '下载本机副本 离线.txt' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(blob)); expect(offline.read).toHaveBeenLastCalledWith('revision-a'); expect(chat.start).not.toHaveBeenCalled(); expect(chat.queue).not.toHaveBeenCalled();
  });
  it('closes attachment recovery without downloading when identity changes during the last access check', async () => {
    const data = offlineData(); data.drafts[0].files = [{ id: 'offline-file', name: '保密.txt', mime: 'text/plain', blob: new File(['本机字节'], '保密.txt', { type: 'text/plain' }) }]; offline.read.mockResolvedValueOnce(data).mockRejectedValue(new APIError(409, { code: 'LOCAL_IDENTITY_CHANGED', message: '身份变化' }));
    const create = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />); await screen.findByText('保密.txt'); fireEvent.click(screen.getByRole('button', { name: '下载本机副本 保密.txt' }));
    await screen.findByText('本机身份已改变，旧内容已关闭。请重新连接并验证账号后继续。'); expect(screen.queryByText('保密.txt')).not.toBeInTheDocument(); expect(create).not.toHaveBeenCalled();
  });
});

describe('M5-UI revoked draft persistence race', () => {
  it('preserves the actual IndexedDB draft when scrolling schedules a save during asynchronous revoked selection cleanup', async () => {
    const storage = await vi.importActual<typeof import('./lib/outbox')>('./lib/outbox');
    await storage.rememberIdentity(user, await storage.readOfflineIdentity());
    await storage.saveLocalDraft(user.id, 'dm-a', '');
    chat.getDraft.mockImplementation((id) => storage.readDraft(user.id, id));
    chat.saveDraft.mockImplementation((id, text, position) => storage.saveLocalDraft(user.id, id, text, position as { scrollTop?: number; anchorId?: string }));
    const group = { ...conversation(), kind: 'group' as const, peer: null, title: '解散草稿测试群' }; chat.state!.conversations = [group];
    vi.stubGlobal('fetch', vi.fn(() => response({ conversation: group, version: 1, settings: { announcement: '', announcementPinned: false, reviewRequired: true, inviteRole: 'managers', everyoneMuted: false, slowSeconds: 0 }, capabilities: { canEdit: false, canInvite: false, canReview: false, canAssignRoles: false, canTransfer: false, canDissolve: false, canLeave: true }, transfer: null })));
    showWorkspace(); await openConversation(group.title);
    const text = '解散后保留的草稿：真实存储时序测试'; fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: text } });
    // Establish the same persisted precondition as the real browser report.
    await waitFor(async () => expect((await storage.readDraft(user.id, 'dm-a'))?.text).toBe(text));
    fireEvent.click(screen.getByRole('button', { name: '群详情与管理' })); await screen.findByText('你当前没有编辑群资料的权限。');
    const gate = deferred<void>(); let saving = false; const committed: Promise<void>[] = [];
    chat.saveDraft.mockImplementation((id, value, position) => { const write = (async () => { saving = true; await gate.promise; await storage.saveLocalDraft(user.id, id, value, position as { scrollTop?: number; anchorId?: string }); })(); committed.push(write); return write; });
    await act(async () => publish({ conversations: [], selectedId: null, messages: [], historyLoading: false })); await waitFor(() => expect(saving).toBe(true));
    // Clearing messages/closing details can produce this scroll after the
    // navigation save already cleared its first debounce timer.
    fireEvent.scroll(screen.getByLabelText('消息记录'));
    await act(async () => gate.resolve()); await screen.findByRole('heading', { name: '欢迎来到同频' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)); await Promise.all(committed); });
    expect((await storage.readDraft(user.id, 'dm-a'))?.text).toBe(text);
    expect(await storage.localSummary(user.id)).toMatchObject({ drafts: 1 });
  });
  it('does not restore a submitted draft when an older scroll timer fires after queue commit', async () => {
    const storage = await vi.importActual<typeof import('./lib/outbox')>('./lib/outbox');
    await storage.rememberIdentity(user, await storage.readOfflineIdentity()); await storage.saveLocalDraft(user.id, 'dm-a', '');
    chat.getDraft.mockImplementation((id) => storage.readDraft(user.id, id)); const committed: Promise<void>[] = [];
    chat.saveDraft.mockImplementation((id, text, position) => { const write = storage.saveLocalDraft(user.id, id, text, position as { scrollTop?: number; anchorId?: string }); committed.push(write); return write; });
    showWorkspace(); await openConversation(); const text = '已发送后不要复活为草稿'; fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: text } });
    await waitFor(async () => expect((await storage.readDraft(user.id, 'dm-a'))?.text).toBe(text));
    const queueCommit = deferred<void>(); chat.queue.mockImplementation(() => queueCommit.promise); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.scroll(screen.getByLabelText('消息记录')); await act(async () => queueCommit.resolve()); await waitFor(() => expect(screen.getByLabelText('消息内容')).toHaveValue(''));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)); await Promise.all(committed); });
    expect((await storage.readDraft(user.id, 'dm-a'))?.text).toBe(''); expect(await storage.localSummary(user.id)).toMatchObject({ drafts: 0 });
  });
});

describe('M5-UI revoked conversation reconciliation', () => {
  it('saves the current draft, closes details, and returns to the list after confirmed access revocation', async () => {
    chat.state!.conversations = [{ ...conversation(), kind: 'group', peer: null, title: '被移出的群' }];
    vi.stubGlobal('fetch', vi.fn(() => response({ conversation: chat.state!.conversations[0], version: 1, settings: { announcement: '', announcementPinned: false, reviewRequired: true, inviteRole: 'managers', everyoneMuted: false, slowSeconds: 0 }, capabilities: { canEdit: false, canInvite: false, canReview: false, canAssignRoles: false, canTransfer: false, canDissolve: false, canLeave: true }, transfer: null })));
    showWorkspace(); await openConversation('被移出的群'); const editor = screen.getByLabelText('消息内容'); fireEvent.change(editor, { target: { value: '移出时尚未发送的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '群详情与管理' })); await screen.findByText('你当前没有编辑群资料的权限。');
    const commit = deferred<void>(); chat.saveDraft.mockImplementation(() => commit.promise);
    await act(async () => publish({ conversations: [], selectedId: null, messages: [], historyLoading: false }));
    await waitFor(() => expect(chat.saveDraft).toHaveBeenCalledWith('dm-a', '移出时尚未发送的草稿', expect.anything())); expect(screen.queryByRole('dialog', { name: '群详情与管理' })).not.toBeInTheDocument(); expect(editor).toHaveValue('移出时尚未发送的草稿'); expect(screen.getByRole('heading', { name: '会话访问已失效' })).toBeInTheDocument();
    await act(async () => commit.resolve()); await screen.findByRole('heading', { name: '欢迎来到同频' }); expect(screen.getByText('“被移出的群”的访问权限已失效，已返回会话列表。本机草稿已保留。')).toBeInTheDocument(); expect(screen.queryByLabelText('消息内容')).not.toBeInTheDocument(); expect(chat.queue).not.toHaveBeenCalled();
  });
  it('retains the draft with an explicit retry when saving after revocation fails', async () => {
    showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '必须保留的草稿' } }); chat.saveDraft.mockRejectedValue(new Error('本机存储写入失败'));
    await act(async () => publish({ conversations: [], selectedId: null, messages: [], historyLoading: false }));
    const retry = await screen.findByRole('button', { name: '重试保存草稿并返回' }); expect(retry).toBeEnabled(); expect(screen.getByLabelText('消息内容')).toHaveValue('必须保留的草稿'); expect(screen.getByText('本机存储写入失败')).toBeInTheDocument();
    chat.saveDraft.mockResolvedValue(); fireEvent.click(retry); await screen.findByRole('heading', { name: '欢迎来到同频' }); expect(chat.saveDraft).toHaveBeenLastCalledWith('dm-a', '必须保留的草稿', expect.anything());
  });
  it('does not close a confirmed chat temporarily absent from a refreshing list while core still selects it', async () => {
    showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '正常刷新时的草稿' } });
    await act(async () => publish({ conversations: [], selectedId: 'dm-a', historyLoading: true }));
    expect(screen.getByLabelText('消息内容')).toHaveValue('正常刷新时的草稿'); expect(chat.select).not.toHaveBeenCalledWith(null); expect(screen.queryByText(/访问权限已失效/)).not.toBeInTheDocument();
    await act(async () => publish({ conversations: [conversation()], historyLoading: false })); expect(screen.getByLabelText('消息内容')).toBeEnabled();
  });
  it('does not interpret an uncompleted first selection missing from the list as revoked', async () => {
    const loading = deferred<void>(); chat.select.mockImplementation(async (id) => { await loading.promise; publish({ conversations: [conversation()], selectedId: id, historyLoading: false }); });
    showWorkspace(); fireEvent.click(within(screen.getByLabelText('会话列表')).getByRole('button', { name: /测试好友/ })); await waitFor(() => expect(chat.select).toHaveBeenCalledWith('dm-a'));
    await act(async () => publish({ conversations: [], selectedId: null, historyLoading: true })); expect(chat.select).not.toHaveBeenCalledWith(null); expect(screen.queryByText(/访问权限已失效/)).not.toBeInTheDocument();
    await act(async () => loading.resolve()); await waitFor(() => expect(screen.getByLabelText('消息内容')).toBeEnabled()); expect(chat.select).not.toHaveBeenCalledWith(null);
  });
});

describe('M5-UI workspace integration', () => {
  it('offers both group entries and does not queue or clear an existing draft while opening creation', async () => {
    showWorkspace(); await openConversation(); const editor = screen.getByLabelText('消息内容'); fireEvent.change(editor, { target: { value: '打开群功能前的草稿' } });
    const list = within(screen.getByLabelText('会话列表')); expect(list.getByRole('button', { name: '加入群聊' })).toBeEnabled(); fireEvent.click(list.getByRole('button', { name: '创建群聊' }));
    expect(screen.getByRole('dialog', { name: '创建群聊' })).toBeInTheDocument(); expect(editor).toHaveValue('打开群功能前的草稿'); expect(chat.queue).not.toHaveBeenCalled(); fireEvent(screen.getByRole('dialog', { name: '创建群聊' }), new Event('cancel', { cancelable: true })); expect(editor).toHaveValue('打开群功能前的草稿');
  });
  it('routes group settings to actual management without marking group messages as globally read', async () => {
    chat.state!.conversations = [{ ...conversation(), kind: 'group', peer: null, title: '真实群入口', role: 'member', memberCount: 3 }];
    chat.histories['dm-a'] = [{ ...message(), senderId: user.id, sender: user }];
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/v1/groups/dm-a' ? response({ conversation: chat.state!.conversations[0], version: 1, settings: { announcement: '', announcementPinned: false, reviewRequired: true, inviteRole: 'managers', everyoneMuted: false, slowSeconds: 0 }, capabilities: { canEdit: false, canInvite: false, canReview: false, canAssignRoles: false, canTransfer: false, canDissolve: false, canLeave: true }, transfer: null }) : response({ items: [], nextCursor: null })));
    showWorkspace(); await openConversation('真实群入口'); expect(screen.getByText('已发送')).toBeInTheDocument(); expect(screen.queryByText('已读')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '群详情与管理' }));
    const panel = await screen.findByRole('dialog', { name: '群详情与管理' }); await within(panel).findByText('你当前没有编辑群资料的权限。'); expect(within(panel).getByRole('checkbox', { name: '置顶会话' })).toBeEnabled(); expect(chat.read).not.toHaveBeenCalled();
  });
});

describe('M3-M4 chat transaction and draft UI', () => {
  it('waits for the queue transaction and preserves edits made while saving', async () => {
    const commit = deferred<void>();
    chat.queue.mockImplementation(async (_id, text) => { await commit.promise; publish({ outbox: [queued(text)] }); });
    showWorkspace(); await openConversation(); const input = screen.getByLabelText('消息内容');
    fireEvent.change(input, { target: { value: '发送时的正文' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(input).toHaveValue('发送时的正文'); expect(screen.queryByText('已存本机 · 等待投递')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '后来继续编辑的草稿' } });
    await act(async () => commit.resolve());
    expect(input).toHaveValue('后来继续编辑的草稿'); expect(screen.getByText('已存本机 · 等待投递')).toBeInTheDocument();
    expect(chat.queue).toHaveBeenCalledWith('dm-a', '发送时的正文', { files: [], replyToMessageId: null, mentionedUserIds: [], mentionAll: false });
    expect(chat.saveDraft.mock.calls.some(([, text]) => text === '')).toBe(false);
  });
  it('clears only an unchanged submitted draft after successful local storage', async () => {
    showWorkspace(); await openConversation(); const input = screen.getByLabelText('消息内容');
    fireEvent.change(input, { target: { value: '完整提交的正文' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(chat.saveDraft.mock.calls.some(([id, text]) => id === 'dm-a' && text === '')).toBe(true);
  });
  it('keeps the draft and reports an actual queue storage failure', async () => {
    chat.queue.mockRejectedValue(new Error('本机存储空间不足'));
    showWorkspace(); await openConversation(); const input = screen.getByLabelText('消息内容');
    fireEvent.change(input, { target: { value: '不要丢失这段草稿' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('本机存储空间不足')).toBeInTheDocument(); expect(input).toHaveValue('不要丢失这段草稿');
    expect(screen.queryByText('已存本机 · 等待投递')).not.toBeInTheDocument();
  });
  it('ignores an older conversation draft response after selecting another conversation', async () => {
    chat.state!.conversations.push(conversation('dm-b', '另一位好友')); const older = deferred<Draft | null>();
    chat.getDraft.mockImplementation(async (id) => id === 'dm-a' ? older.promise : { key: 'b', userId: user.id, conversationId: id, text: '第二个会话的草稿', updatedAt: 1 });
    showWorkspace(); fireEvent.click(within(screen.getByLabelText('会话列表')).getByRole('button', { name: /测试好友/ }));
    await waitFor(() => expect(chat.getDraft).toHaveBeenCalledWith('dm-a'));
    await openConversation('另一位好友');
    await act(async () => older.resolve({ key: 'a', userId: user.id, conversationId: 'dm-a', text: '迟到的旧草稿', updatedAt: 1 }));
    expect(screen.getByLabelText('消息内容')).toHaveValue('第二个会话的草稿');
    expect(screen.getByRole('heading', { name: '另一位好友' })).toBeInTheDocument();
  });
  it('does not leave the current conversation when its draft cannot be saved', async () => {
    chat.state!.conversations.push(conversation('dm-b', '另一位好友'));
    showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '尚未保存的草稿' } });
    chat.saveDraft.mockRejectedValue(new Error('草稿保存失败'));
    fireEvent.click(within(screen.getByLabelText('会话列表')).getByRole('button', { name: /另一位好友/ }));
    expect(await screen.findByText('草稿保存失败')).toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toHaveValue('尚未保存的草稿'); expect(chat.select).not.toHaveBeenCalledWith('dm-b');
  });
});

describe('M3-M4 message and reading UI', () => {
  it('renders HTML as text and uses exact peer sequence for sent versus read', async () => {
    chat.histories['dm-a'] = [{ ...message('large-seq', '9007199254740994', '<img src=x onerror=alert(1)>'), senderId: user.id, sender: user }];
    chat.state!.conversations[0].peerReadSeq = '9007199254740993';
    const view = showWorkspace(); await openConversation();
    expect(screen.getByText('已发送')).toBeInTheDocument(); expect(screen.queryByText('已读')).not.toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument(); expect(view.container.querySelector('.message-bubble img')).toBeNull();
    act(() => publish({ conversations: [{ ...conversation(), peerReadSeq: '9007199254740994' }] }));
    expect(screen.getByText('已读')).toBeInTheDocument();
  });
  it('reads only visible focused bottom messages and preserves scroll while new messages arrive above the bottom', async () => {
    chat.histories['dm-a'] = [message()]; showWorkspace(); await openConversation();
    const viewport = screen.getByLabelText('消息记录'); const geometry = dimensions(viewport);
    const visibility = vi.spyOn(document, 'visibilityState', 'get'); visibility.mockReturnValue('hidden');
    vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent.scroll(viewport); expect(chat.read).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible'); vi.mocked(document.hasFocus).mockReturnValue(false); fireEvent.scroll(viewport); expect(chat.read).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent.scroll(viewport); expect(chat.read).not.toHaveBeenCalled();
    geometry.setHeight(1120); act(() => publish({ messages: [message(), message('message-2', '2', '后来到达的新消息')] }));
    expect(geometry.top()).toBe(200); expect(screen.getByRole('button', { name: '1 条新消息' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 条新消息' }));
    await waitFor(() => expect(chat.read).toHaveBeenCalledWith('dm-a', '2'));
    expect(geometry.top()).toBe(820); expect(screen.queryByRole('button', { name: '1 条新消息' })).not.toBeInTheDocument();
  });
  it('preserves the viewport offset when older history is prepended', async () => {
    chat.histories['dm-a'] = [message('message-5', '5')]; chat.state!.historyBefore = 'history-cursor';
    showWorkspace(); await openConversation(); const viewport = screen.getByLabelText('消息记录'); const geometry = dimensions(viewport, 1000, 240); fireEvent.scroll(viewport);
    chat.older.mockImplementation(async () => { publish({ historyLoading: true }); await Promise.resolve(); geometry.setHeight(1400); publish({ messages: [message('message-4', '4', '更早的消息'), message('message-5', '5')], historyLoading: false }); });
    fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
    await screen.findByText('更早的消息'); expect(geometry.top()).toBe(640); expect(chat.read).not.toHaveBeenCalled();
  });
  it('counts Unicode codepoints and never sends during IME composition', () => {
    const send = vi.fn(); const changed = vi.fn();
    const view = render(<Composer value={'😀'.repeat(4000)} onChange={changed} onSend={send} />);
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    const input = screen.getByLabelText('消息内容'); fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled();
    view.rerender(<Composer value={'😀'.repeat(4001)} onChange={changed} onSend={send} />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('4,000');
  });
});

describe('M3-M4 queue and logout UI', () => {
  it('explains a failed-head wait in chat, leaves the composer usable, and opens recovery', async () => {
    const failed = { ...queued('失败的旧消息', 'failed'), createdAt: 1 };
    const next = { ...queued('等待中的新消息'), key: 'next-key', createdAt: 2, payload: { ...queued().payload, clientMessageId: 'next-id' } };
    chat.state!.outbox = [next, failed]; showWorkspace(); await openConversation();
    expect(screen.getByText('等待前一条失败消息处理')).toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toBeEnabled();
    const entry = screen.getByRole('button', { name: '处理本机待发' });
    fireEvent.click(entry); await screen.findByRole('heading', { name: '本机待发' });
    await act(async () => publish({ outbox: [next] }));
    expect(screen.queryByText('等待前一条失败消息处理')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^消息/ }));
    expect(screen.queryByRole('button', { name: '处理本机待发' })).not.toBeInTheDocument();
    expect(screen.getByText('已存本机 · 等待投递')).toBeInTheDocument();
  });
  it('uses the same client ID for retry and clearly limits cancellation to this device', async () => {
    chat.state!.outbox = [{ ...queued('待发消息正文', 'failed'), errorCode: 'NETWORK_ERROR' }]; showWorkspace(); fireEvent.click(screen.getByRole('button', { name: /^待发/ }));
    fireEvent.click(await screen.findByRole('button', { name: '重试' })); await waitFor(() => expect(chat.retry).toHaveBeenCalledWith('same-client-id'));
    fireEvent.click(screen.getByRole('button', { name: '停止本机重试' })); await waitFor(() => expect(chat.cancel).toHaveBeenCalledWith('same-client-id'));
    expect(await screen.findByText('已停止这条消息的本机重试；服务器上已收到的消息不受影响。')).toBeInTheDocument();
  });
  it.each(['keep', 'delete'] as const)('asks how to handle local contents and waits for %s logout success', async (choice) => {
    chat.summary.mockResolvedValue({ pending: 2, drafts: 1 }); const signedOut = vi.fn(); const logout = deferred<void>(); chat.logout.mockReturnValue(logout.promise);
    showWorkspace(signedOut); fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '退出前，处理本机内容' })).toBeInTheDocument();
    if (choice === 'keep') { fireEvent.click(screen.getByRole('button', { name: '取消退出' })); await waitFor(() => expect(screen.getByRole('button', { name: '退出登录' })).toBeEnabled()); expect(signedOut).not.toHaveBeenCalled(); expect(chat.logout).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '退出登录' })); await screen.findByRole('heading', { name: '退出前，处理本机内容' }); }
    fireEvent.click(screen.getByRole('button', { name: choice === 'keep' ? '保留，待下次登录继续' : '删除本机内容并退出' }));
    expect(chat.logout).toHaveBeenCalledWith(choice); expect(signedOut).not.toHaveBeenCalled();
    await act(async () => logout.resolve()); expect(signedOut).toHaveBeenCalledTimes(1);
  });
});

const request: FriendRequest = { id: 'request-a', sender: peer, target: user, direction: 'incoming', note: '你好，一起聊聊。', status: 'pending', createdAt: 1 };
function contactsProps() { return { contacts: [peer], requests: [request], nextContacts: null, nextRequests: null, onRefresh: vi.fn(async () => undefined), onOpenConversation: vi.fn(async () => undefined), onLoadMoreContacts: vi.fn(async () => undefined), onLoadMoreRequests: vi.fn(async () => undefined) }; }
describe('M3-M4 contacts UI', () => {
  it('searches users and submits a real friend request with its note', async () => {
    const candidate: Contact = { ...peer, relationship: 'none' }; const props = contactsProps();
    const fetchMock = vi.fn((url: string, _options?: RequestInit) => response(url.includes('/users/search') ? { items: [candidate], nextCursor: null } : {})); vi.stubGlobal('fetch', fetchMock);
    render(<ContactsPage {...props} initialTab="search" />);
    expect(screen.getByLabelText('搜索用户名')).toHaveAttribute('placeholder', '输入至少3位用户名');
    expect(screen.queryByText(/用户名或昵称/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索用户名'), { target: { value: 'ui_peer' } }); fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加' }));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/users/search?q=ui_peer')).toBe(true);
    fireEvent.change(screen.getByLabelText('申请说明（选填）'), { target: { value: '一起交流吧' } }); fireEvent.click(screen.getByRole('button', { name: '发送申请' }));
    await screen.findByText('好友申请已提交，可在“好友申请”中查看结果。');
    const posted = fetchMock.mock.calls.find(([url]) => url === '/api/v1/friend-requests');
    expect(JSON.parse(posted![1]!.body as string)).toEqual({ targetUserId: peer.id, note: '一起交流吧' }); expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
  it.each(['accept', 'reject', 'cancel'] as const)('performs the %s request action and refreshes server state', async (action) => {
    const props = contactsProps(); props.requests = [{ ...request, direction: action === 'cancel' ? 'outgoing' : 'incoming' }];
    const fetchMock = vi.fn((_url: string, _options?: RequestInit) => response({})); vi.stubGlobal('fetch', fetchMock);
    render(<ContactsPage {...props} initialTab="requests" />);
    if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: '发出的申请' }));
    fireEvent.click(screen.getByRole('button', { name: { accept: '接受', reject: '拒绝', cancel: '取消申请' }[action] }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/friend-requests/request-a/${action}`, expect.objectContaining({ method: 'POST', body: '{}' }));
  });
  it.each(['delete', 'block'] as const)('confirms the consequence before the %s relationship mutation', async (action) => {
    const props = contactsProps(); const fetchMock = vi.fn((_url: string, _options?: RequestInit) => response({})); vi.stubGlobal('fetch', fetchMock);
    render(<ContactsPage {...props} />); fireEvent.click(screen.getByRole('button', { name: '查看测试好友的好友设置' }));
    fireEvent.click(screen.getByRole('button', { name: action === 'delete' ? '删除好友' : '屏蔽此人' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(action === 'delete' ? '旧聊天记录会保留' : '阻止新增私聊消息');
    fireEvent.click(screen.getByRole('button', { name: '确认' })); await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/${action === 'delete' ? 'friends' : 'blocks'}/${peer.id}`, expect.objectContaining({ method: action === 'delete' ? 'DELETE' : 'PUT' }));
  });
  it('does not silently enable an online notification preference after server rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403, json: async () => ({ error: { code: 'CONTACT_UNAVAILABLE', message: '当前关系不允许设置提醒' } }) })));
    render(<ContactsPage {...contactsProps()} />); fireEvent.click(screen.getByRole('button', { name: '查看测试好友的好友设置' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /好友上线提醒/ }));
    await waitFor(() => expect(screen.getAllByText('当前关系不允许设置提醒').length).toBeGreaterThan(0));
    expect(screen.getByRole('checkbox', { name: /好友上线提醒/ })).not.toBeChecked();
  });
});

const offlineData = (): OfflineLocalSnapshot => ({ identity: { key: 'active-user', user, revision: 'revision-a', savedAt: 1 }, outbox: [queued('离线保存的正文')], drafts: [{ key: 'draft-a', userId: user.id, conversationId: 'dm-a', text: '离线保存的草稿', updatedAt: 1 }], taskDrafts: [], nextDraftCursor: null });
describe('M3-M4 unverified offline recovery UI', () => {
  it('does not expose kept content without an active local identity or start the authenticated client', async () => {
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />);
    expect(await screen.findByText('没有可展示的本机内容')).toBeInTheDocument();
    expect(screen.queryByText(user.nickname)).not.toBeInTheDocument(); expect(chat.start).not.toHaveBeenCalled();
    expect(screen.getByText('账号状态尚未验证。聊天待发可在验证身份后继续投递；任务草稿须本人联网复核并确认提交。')).toBeInTheDocument();
  });
  it('clears the old identity immediately and never restores it from a late read', async () => {
    const late = deferred<OfflineLocalSnapshot | null>();
    offline.read.mockResolvedValueOnce(offlineData()).mockReturnValue(late.promise);
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />);
    await screen.findByText('离线保存的正文');
    act(() => { for (const listener of offline.listeners) listener('check'); });
    expect(offline.read).toHaveBeenLastCalledWith('revision-a', undefined);
    act(() => { for (const listener of offline.listeners) listener('identity'); });
    expect(screen.queryByText('离线保存的正文')).not.toBeInTheDocument(); expect(screen.queryByText('离线保存的草稿')).not.toBeInTheDocument();
    await act(async () => late.resolve(offlineData()));
    expect(screen.getByText('本机身份已改变，旧内容已关闭。请重新连接并验证账号后继续。')).toBeInTheDocument();
    expect(screen.queryByText('离线保存的正文')).not.toBeInTheDocument(); expect(chat.start).not.toHaveBeenCalled();
  });
  it('closes on a revision mismatch detected by a background identity check', async () => {
    offline.read.mockResolvedValueOnce(offlineData()).mockRejectedValue(new APIError(409, { code: 'LOCAL_IDENTITY_CHANGED', message: '本机身份已改变' }));
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />); await screen.findByText('离线保存的正文');
    act(() => { for (const listener of offline.listeners) listener('check'); });
    await screen.findByText('本机身份已改变，旧内容已关闭。请重新连接并验证账号后继续。');
    expect(screen.queryByText('离线保存的正文')).not.toBeInTheDocument();
  });
  it('paginates and deletes only with the held identity revision', async () => {
    const first = { ...offlineData(), nextDraftCursor: 'draft-page-2' };
    const second = { ...offlineData(), drafts: [{ ...offlineData().drafts[0], key: 'draft-b', text: '第二页草稿' }] };
    offline.read.mockImplementation(async (_revision, cursor) => cursor ? second : first);
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />); await screen.findByText('离线保存的正文');
    fireEvent.click(screen.getByRole('button', { name: '加载更多草稿' })); await screen.findByText('第二页草稿');
    expect(offline.read).toHaveBeenCalledWith('revision-a', 'draft-page-2'); expect(screen.getByText('离线保存的草稿')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '删除本机草稿' })[0]);
    expect(offline.remove).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '确认删除本机条目' }));
    await waitFor(() => expect(offline.remove).toHaveBeenCalledWith('revision-a', 'draft', 'draft-a'));
    expect(await screen.findByText('本机条目已删除；服务器已经收到的消息与任务不受影响。')).toBeInTheDocument();
    expect(chat.queue).not.toHaveBeenCalled(); expect(chat.start).not.toHaveBeenCalled();
  });
});

describe('M3-M4 logout focus', () => {
  it('restores the enabled logout trigger after Escape cancels the local-content dialog', async () => {
    chat.summary.mockResolvedValue({ pending: 1, drafts: 0 });
    const signedOut = vi.fn(); showWorkspace(signedOut);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const trigger = await screen.findByRole('button', { name: '退出登录' });
    trigger.focus(); fireEvent.click(trigger);
    const heading = await screen.findByRole('heading', { name: '退出前，处理本机内容' });
    const dialog = heading.closest('dialog')!;
    expect(trigger).toBeDisabled();
    // jsdom has no native dialog focus handling; mimic focus inside the real modal.
    within(dialog).getByRole('button', { name: '取消退出' }).focus();
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => { expect(trigger).toBeEnabled(); expect(trigger).toHaveFocus(); });
    expect(dialog.open).toBe(false); expect(signedOut).not.toHaveBeenCalled(); expect(chat.logout).not.toHaveBeenCalled();
    const settingsDialog = screen.getByRole('dialog', { name: '设置' }); expect(settingsDialog).toHaveAttribute('open'); expect(settingsDialog).toContainElement(trigger);
    expect(screen.getByText('偏好保存到账号，用于聊天中的在线状态、阅读回执和消息提醒。')).toBeInTheDocument();
  });
  it.each(['new modal', 'another control', 'changed identity', 'unmounted'] as const)('does not steal focus after cancellation with %s', async (scenario) => {
    const cancelled = deferred<void>(); const signedOut = vi.fn();
    const props = { user, onUserChange: vi.fn(), onSignedOut: signedOut, onLogout: () => cancelled.promise };
    const view = render(<AccountSettings {...props} />);
    const trigger = screen.getByRole('button', { name: '退出登录' });
    trigger.focus(); fireEvent.click(trigger); expect(trigger).toBeDisabled(); trigger.blur();
    const focus = vi.spyOn(trigger, 'focus');
    let other: HTMLElement | null = null;
    if (scenario === 'new modal') { const dialog = document.createElement('dialog'); dialog.open = true; other = document.createElement('button'); other.textContent = '新对话框'; dialog.append(other); document.body.append(dialog); other.focus(); }
    if (scenario === 'another control') { other = document.createElement('button'); other.textContent = '外部导航'; document.body.append(other); other.focus(); }
    if (scenario === 'changed identity') view.rerender(<AccountSettings {...props} user={{ ...user, id: 'replacement-user' }} />);
    if (scenario === 'unmounted') view.unmount();
    await act(async () => cancelled.reject(Object.assign(new Error('cancelled'), { name: 'LogoutCancelled' })));
    expect(focus).not.toHaveBeenCalled(); expect(signedOut).not.toHaveBeenCalled();
    if (other) expect(other).toHaveFocus();
    if (scenario === 'new modal') other?.closest('dialog')?.remove();
    if (scenario === 'another control') other?.remove();
  });
});

describe('M7-UI workspace rich drafts and location', () => {
  it('restores ID-only reply and mention metadata, clears submitted IDs and preserves new reply during queue commit', async () => {
    const initial = { ...message('reply-a', '1', '原消息 A'), capabilities: { canInteract: true, canRecall: false, canModerate: false } }; const newer = { ...message('reply-b', '2', '原消息 B'), capabilities: { canInteract: true, canRecall: false, canModerate: false } };
    chat.histories['dm-a'] = [initial, newer]; const saved: Draft = { key: 'draft', userId: user.id, conversationId: 'dm-a', text: '提交正文', updatedAt: 1, files: [], replyToMessageId: 'reply-a', mentionedUserIds: ['already-mentioned'], mentionAll: true }; chat.getDraft.mockResolvedValue(saved);
    const writes: Draft[] = []; chat.saveDraft.mockImplementation(async (id, text, extra) => { writes.push({ ...saved, ...extra as Partial<Draft>, conversationId: id, text }); }); const commit = deferred<void>(); chat.queue.mockImplementationOnce(() => commit.promise);
    showWorkspace(); await openConversation(); expect(screen.getByText('引用：测试好友：原消息 A')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalledOnce());
    fireEvent.click(within(screen.getByText('原消息 B').closest('li')!).getByRole('button', { name: '引用回复' })); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '后续正文' } });
    await act(async () => commit.resolve()); await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()); expect(screen.getByText('引用：测试好友：原消息 B')).toBeInTheDocument(); expect(screen.queryByLabelText('移除全体提及')).not.toBeInTheDocument(); expect(screen.queryByLabelText('移除提及 already-mentioned')).not.toBeInTheDocument();
    expect(chat.queue.mock.calls[0][2]).toEqual({ files: [], replyToMessageId: 'reply-a', mentionedUserIds: ['already-mentioned'], mentionAll: true }); expect(writes.at(-1)).toMatchObject({ text: '后续正文', replyToMessageId: 'reply-b', mentionedUserIds: [], mentionAll: false }); expect(JSON.stringify(writes.at(-1))).not.toContain('原消息 A');
  });
  it('keeps rich draft on failed queue and sends its exact IDs on a retry', async () => {
    const saved: Draft = { key: 'draft', userId: user.id, conversationId: 'dm-a', text: '失败保留', updatedAt: 1, replyToMessageId: 'reply-a', mentionedUserIds: ['u2'], mentionAll: false }; chat.getDraft.mockResolvedValue(saved); chat.histories['dm-a'] = [message('reply-a')]; chat.queue.mockRejectedValueOnce(new Error('保存失败'));
    showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await screen.findByText('保存失败'); expect(screen.getByLabelText('消息内容')).toHaveValue('失败保留'); expect(screen.getByLabelText('移除引用')).toBeInTheDocument(); expect(screen.getByLabelText('移除提及 u2')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '发送' })); await waitFor(() => expect(chat.queue).toHaveBeenCalledTimes(2)); expect(chat.queue.mock.calls[1][2]).toMatchObject({ replyToMessageId: 'reply-a', mentionedUserIds: ['u2'] });
  });
  it('opens bookmarks from navigation and loads target context without a second latest-history selection', async () => {
    chat.jump.mockImplementation(async () => publish({ selectedId: 'dm-a', messages: [message('located', '50', '定位正文')], locatedMessageId: 'located', historyAfter: '50' })); showWorkspace(); fireEvent.click(screen.getByRole('button', { name: '收藏' })); await screen.findByRole('heading', { name: '我的收藏' }); await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/v1/bookmarks?'))).toBe(true));
    await act(async () => window.dispatchEvent(new CustomEvent('tongpin:open-message', { detail: { userId: 'other', messageId: 'wrong' } }))); expect(chat.jump).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new CustomEvent('tongpin:open-message', { detail: { userId: user.id, messageId: 'located' } }))); await screen.findByText('已定位到目标消息'); expect(chat.jump).toHaveBeenCalledWith('located'); expect(chat.select).not.toHaveBeenCalled(); expect(screen.getByText('定位正文').closest('li')).toHaveClass('is-located'); expect(chat.read).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '加载较新的消息' })); await waitFor(() => expect(chat.newer).toHaveBeenCalledOnce());
  });
  it('does not mark a bounded context as fully read even when its viewport is at bottom', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true); chat.histories['dm-a'] = [message('context', '40')]; showWorkspace(); await openConversation(); chat.read.mockClear(); await act(async () => publish({ historyAfter: '40' })); const viewport = screen.getByLabelText('消息记录'); dimensions(viewport, 300, 0); fireEvent.scroll(viewport); fireEvent.focus(window); expect(chat.read).not.toHaveBeenCalled();
  });
});


describe('M7-UI context history pagination', () => {
  it('does not count already-existing later pages as live messages and preserves the located viewport and draft', async () => {
    const initial = Array.from({ length: 29 }, (_, index) => message(`context-${index + 1}`, String(index + 1), `历史 ${index + 1}`));
    const later = Array.from({ length: 36 }, (_, index) => message(`context-${index + 30}`, String(index + 30), `历史 ${index + 30}`));
    chat.jump.mockImplementation(async () => publish({ selectedId: 'dm-a', conversations: [{ ...conversation(), lastSeq: '65' }], messages: initial, locatedMessageId: 'context-4', historyAfter: '29' }));
    chat.getDraft.mockResolvedValue({ key: 'draft', userId: user.id, conversationId: 'dm-a', text: '保留的草稿', updatedAt: 1 });
    showWorkspace(); await act(async () => window.dispatchEvent(new CustomEvent('tongpin:open-message', { detail: { userId: user.id, messageId: 'context-4' } }))); await screen.findByText('已定位到目标消息');
    const viewport = screen.getByLabelText('消息记录'); const geometry = dimensions(viewport, 1000, 180); fireEvent.scroll(viewport);
    const page = deferred<void>(); chat.newer.mockImplementation(async () => { publish({ historyLoading: true }); await page.promise; geometry.setHeight(1900); publish({ messages: [...initial, ...later], historyAfter: null, historyLoading: false }); });
    fireEvent.click(screen.getByRole('button', { name: '加载较新的消息' })); await act(async () => page.resolve()); await screen.findByText('历史 65');
    expect(screen.queryByRole('button', { name: /条新消息/ })).not.toBeInTheDocument(); expect(geometry.top()).toBe(180); expect(screen.getByLabelText('消息内容')).toHaveValue('保留的草稿'); expect(chat.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回最新消息' })); await waitFor(() => expect(chat.select).toHaveBeenCalledWith('dm-a')); expect(screen.getByLabelText('消息内容')).toHaveValue('保留的草稿');
  });
  it('still counts a genuine live message during pagination and keeps both controls in separate flow rows', async () => {
    const initial = [message('context-1', '1', '定位历史')]; const existing = message('context-2', '2', '较新历史'); const live = message('live-3', '3', '真正实时消息');
    chat.jump.mockImplementation(async () => publish({ selectedId: 'dm-a', conversations: [{ ...conversation(), lastSeq: '2' }], messages: initial, locatedMessageId: 'context-1', historyAfter: '1' }));
    showWorkspace(); await act(async () => window.dispatchEvent(new CustomEvent('tongpin:open-message', { detail: { userId: user.id, messageId: 'context-1' } }))); await screen.findByText('已定位到目标消息');
    const viewport = screen.getByLabelText('消息记录'); const geometry = dimensions(viewport, 1000, 180); fireEvent.scroll(viewport); const page = deferred<void>();
    chat.newer.mockImplementation(async () => { publish({ historyLoading: true }); await page.promise; geometry.setHeight(1500); publish({ messages: [initial[0], existing, live], historyAfter: null, historyLoading: false }); });
    fireEvent.click(screen.getByRole('button', { name: '加载较新的消息' })); act(() => publish({ conversations: [{ ...conversation(), lastSeq: '3', lastMessage: live }] })); await act(async () => page.resolve());
    const newButton = await screen.findByRole('button', { name: '1 条新消息' }); const latest = screen.getByRole('button', { name: '返回最新消息' }); expect(newButton.closest('.timeline-actions')).toBe(latest.closest('.timeline-actions')); expect(newButton.closest('.history-context-bar')).toBeNull(); expect(latest.closest('.history-context-bar')).not.toBeNull(); expect(geometry.top()).toBe(180);
    geometry.setHeight(1600); act(() => publish({ messages: [initial[0], existing, live, message('live-4', '4', '接着实时到达')] })); expect(screen.getByRole('button', { name: '2 条新消息' })).toBeInTheDocument();
  });
});


describe('M7-UI explicit latest position', () => {
  async function located() {
    chat.jump.mockImplementation(async () => publish({ selectedId: 'dm-a', conversations: [{ ...conversation(), lastSeq: '65' }, conversation('dm-b', '另一位好友')], messages: [message('located-4', '4')], historyAfter: '4', locatedMessageId: 'located-4' }));
    showWorkspace(); await act(async () => window.dispatchEvent(new CustomEvent('tongpin:open-message', { detail: { userId: user.id, messageId: 'located-4' } }))); await screen.findByText('已定位到目标消息'); const viewport = screen.getByLabelText('消息记录'); const geometry = dimensions(viewport, 9316, 428); fireEvent.scroll(viewport); return { viewport, geometry };
  }
  it('scrolls to the real bottom only after latest history and rich/file draft restoration, then marks latest read', async () => {
    const files: LocalAttachment[] = [{ id: 'f1', name: '保留.txt', mime: 'text/plain', blob: new File(['保留'], '保留.txt', { type: 'text/plain' }) }]; const draft: Draft = { key: 'draft', userId: user.id, conversationId: 'dm-a', text: '保留正文', files, replyToMessageId: 'located-4', mentionedUserIds: ['u2'], mentionAll: false, scrollTop: 428, updatedAt: 1 };
    chat.getDraft.mockResolvedValue(draft); const { geometry } = await located(); vi.mocked(document.hasFocus).mockReturnValue(true); const history = deferred<void>(), restored = deferred<Draft | null>();
    chat.select.mockImplementation(async () => { publish({ historyLoading: true }); await history.promise; publish({ messages: [message('latest-65', '65', '实际最新消息')], historyAfter: null, historyLoading: false }); }); chat.getDraft.mockImplementationOnce(() => restored.promise);
    fireEvent.click(screen.getByRole('button', { name: '返回最新消息' })); await waitFor(() => expect(chat.select).toHaveBeenCalledWith('dm-a')); await act(async () => history.resolve()); expect(geometry.top()).toBe(428); expect(chat.read).not.toHaveBeenCalled(); await act(async () => restored.resolve(draft));
    await waitFor(() => expect(geometry.top()).toBe(9016)); await waitFor(() => expect(chat.read).toHaveBeenCalledWith('dm-a', '65')); expect(screen.getByLabelText('消息内容')).toHaveValue('保留正文'); expect(screen.getByText('保留.txt')).toBeInTheDocument(); expect(screen.getByLabelText('移除引用')).toBeInTheDocument(); expect(screen.getByLabelText('移除提及 u2')).toBeInTheDocument(); expect(chat.older).not.toHaveBeenCalled();
  });
  it('does not treat an offline cached window as newly fetched latest history', async () => {
    const { geometry } = await located(); vi.mocked(document.hasFocus).mockReturnValue(true); act(() => publish({ phase: 'offline' })); fireEvent.click(screen.getByRole('button', { name: '返回最新消息' })); await screen.findByText('请等待连接恢复后再返回最新消息，当前阅读位置和草稿已保留。'); expect(chat.select).not.toHaveBeenCalled(); expect(geometry.top()).toBe(428); expect(chat.read).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '返回最新消息' })).toBeInTheDocument();
  });
  it('does not jump or report read when fetching latest history fails', async () => {
    const { geometry } = await located(); vi.mocked(document.hasFocus).mockReturnValue(true); chat.select.mockRejectedValueOnce(new Error('最新历史加载失败')); fireEvent.click(screen.getByRole('button', { name: '返回最新消息' })); await screen.findByText('最新历史加载失败'); expect(geometry.top()).toBe(428); fireEvent.focus(window); expect(chat.read).not.toHaveBeenCalled();
  });
  it('does not carry a pending latest jump into a later ordinary conversation selection', async () => {
    const { viewport, geometry } = await located(); const old = deferred<void>(); chat.select.mockImplementation(async (id) => { if (id === 'dm-a') await old.promise; else publish({ selectedId: id, messages: [message('b-1', '1', '另一会话')], historyAfter: null }); });
    fireEvent.click(screen.getByRole('button', { name: '返回最新消息' })); await waitFor(() => expect(chat.select).toHaveBeenCalledWith('dm-a')); chat.getDraft.mockResolvedValue({ key: 'b-draft', userId: user.id, conversationId: 'dm-b', text: '另一份草稿', scrollTop: 240, updatedAt: 1 }); fireEvent.click(within(screen.getByLabelText('会话列表')).getByRole('button', { name: /另一位好友/ })); await waitFor(() => expect(screen.getByLabelText('消息内容')).toHaveValue('另一份草稿')); expect(geometry.top()).toBe(240); await act(async () => old.resolve()); expect(geometry.top()).toBe(240); expect(screen.getByLabelText('消息内容')).toHaveValue('另一份草稿'); expect(chat.read).not.toHaveBeenCalled(); expect(viewport).toBe(screen.getByLabelText('消息记录'));
  });
});


describe('M7-FIX-UI workspace mutation wiring', () => {
  it('passes captured core tokens through message and bookmark callbacks without assembling stale bookmark bodies', async () => {
    const token = Object.freeze({ generation: 2, contentRevision: 8 }); chat.beginUpdate.mockReturnValue(token); const original = { ...message(), capabilities: { canInteract: true, canRecall: false, canModerate: false } }; chat.histories['dm-a'] = [original]; const pending = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const fetchMock = vi.mocked(fetch); fetchMock.mockImplementation((url) => String(url).endsWith('/bookmark') ? pending.promise as Promise<Response> : response({ admin: null }) as Promise<Response>); showWorkspace(); await openConversation(); fireEvent.click(within(screen.getByLabelText('消息记录')).getByRole('button', { name: '收藏' })); const tombstone = { ...original, status: 'recalled' as const, text: '', reactions: [] }; act(() => publish({ messages: [tombstone] })); await act(async () => pending.resolve({ ok: true, status: 200, json: async () => ({ data: { bookmarked: true } }) })); expect(chat.beginUpdate).toHaveBeenCalledOnce(); const bookmarkRequest = fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith('/bookmark')); expect(bookmarkRequest).toBeGreaterThanOrEqual(0); expect(chat.beginUpdate.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[bookmarkRequest]); expect(chat.bookmark).toHaveBeenCalledExactlyOnceWith(original.id, true, token); expect(chat.apply).not.toHaveBeenCalled(); expect(screen.getByText('这条消息已撤回')).toBeInTheDocument();
    act(() => publish({ messages: [original] })); fetchMock.mockImplementationOnce(() => response({ message: original }) as Promise<Response>); fireEvent.click(screen.getByRole('button', { name: '👍' })); await waitFor(() => expect(chat.apply).toHaveBeenCalledExactlyOnceWith(original, token)); expect(chat.beginUpdate).toHaveBeenCalledTimes(2);
  });
});

const integrationMeta: TaskMeta = { actorId: user.id, enabled: true, enhanced: true, canCreatePersonal: true, writeReason: null, preferences: { assignments: true, comments: true, completed: true, due: true, timezone: 'Asia/Shanghai' }, labels: [], limits: { personal: 500, group: 500, checkItems: 30, draftDays: 7, draftCount: 50 } };
const integrationTask: Task = { id: 'task-one', viewerId: user.id, scope: 'personal', groupId: null, groupName: null, ownerId: user.id, creator: user, assignee: user, title: '任务真实标题', description: '任务独立正文', status: 'todo', priority: 'normal', dueOn: null, dueTimezone: 'Asia/Shanghai', overdue: false, completedAt: null, createdAt: 1, updatedAt: 1, deletedAt: null, version: 1, etag: '"task-v1"', checkItems: [], source: null, capabilities: { edit: true, progress: true, assign: true, claim: false, release: false, checkStructure: true, checkToggle: true, remove: true, restore: false, comment: true, share: true, copyToGroup: true, writeReason: null }, followed: false, bookmarked: false, listId: null, tagIds: [], reminder: { rule: 'none', time: '09:00' } };
function enableTasks() {
  taskUI.state = { ...taskUI.state!, online: true, entities: { [integrationTask.id]: integrationTask } };
  taskUI.meta.mockResolvedValue(integrationMeta); taskUI.get.mockResolvedValue(integrationTask); taskUI.create.mockResolvedValue(integrationTask);
  taskUI.list.mockResolvedValue({ actorId: user.id, items: [integrationTask], nextCursor: null, total: 1 }); taskUI.activities.mockResolvedValue({ items: [], nextCursor: null }); taskUI.comments.mockResolvedValue({ items: [], nextCursor: null });
  taskUI.groupSettings.mockResolvedValue({ groupId: 'g1', canManage: false, canCreate: true, writeReason: null, createPolicy: 'members', count: 0, quota: 500, etag: 'group-v1' });
}

describe('V3 task shell integration', () => {
  it('starts one task client for the account and stops it on unmount', async () => {
    enableTasks(); const view = showWorkspace(); await waitFor(() => expect(taskUI.meta).toHaveBeenCalled()); expect(taskUI.users).toEqual([user.id]); expect(taskUI.start).toHaveBeenCalledTimes(1); view.unmount(); expect(taskUI.stop).toHaveBeenCalledTimes(1); expect(taskUI.listeners.size).toBe(0);
  });
  it('preserves chat draft and pauses read immediately while opening a task and while a non-dialog overlay state remains', async () => {
    enableTasks(); showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '未发送的聊天输入' } }); const viewport = screen.getByLabelText('消息记录'); dimensions(viewport, 1000, 700); const saving = deferred<void>(); chat.saveDraft.mockReturnValue(saving.promise);
    fireEvent.click(screen.getByRole('button', { name: '新建待办' })); vi.mocked(document.hasFocus).mockReturnValue(true); act(() => publish({ messages: [message()] })); fireEvent.focus(window); expect(chat.read).not.toHaveBeenCalled(); await act(async () => saving.resolve()); const dialog = await screen.findByRole('dialog', { name: '新建待办' });
    dialog.removeAttribute('open'); fireEvent.focus(window); fireEvent.scroll(viewport); expect(chat.read).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole('button', { name: '关闭', hidden: true })); expect(screen.getByLabelText('消息内容')).toHaveValue('未发送的聊天输入'); expect(screen.getByLabelText('消息记录')).toBe(viewport); fireEvent.focus(window); await waitFor(() => expect(chat.read).toHaveBeenCalledWith('dm-a', '1')); expect(chat.typing).toHaveBeenCalledWith(false);
  });
  it('does not open a task form when saving the outgoing chat draft fails', async () => {
    enableTasks(); showWorkspace(); await openConversation(); fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '必须保留' } }); chat.saveDraft.mockRejectedValue(new Error('聊天草稿未能保存')); fireEvent.click(screen.getByRole('button', { name: '新建待办' })); await screen.findByText('聊天草稿未能保存'); expect(screen.queryByRole('dialog', { name: '新建待办' })).not.toBeInTheDocument(); expect(screen.getByLabelText('消息内容')).toHaveValue('必须保留');
  });
  it('opens a source form as personal by default and only offers its own group as shared scope', async () => {
    enableTasks(); chat.state!.conversations = [{ ...conversation('g1', '来源群'), kind: 'group', peer: null }, { ...conversation('g2', '另一群'), kind: 'group', peer: null }]; chat.histories.g1 = [{ ...message(), conversationId: 'g1', text: '确认来源文字' }]; showWorkspace(); await openConversation('来源群'); fireEvent.click(screen.getByRole('button', { name: '转为待办' })); await screen.findByRole('dialog', { name: '从消息创建待办' }); expect(screen.getByLabelText('可见范围')).toHaveValue('personal'); fireEvent.change(screen.getByLabelText('可见范围'), { target: { value: 'group' } }); expect(screen.getByLabelText('所属群')).toHaveValue('g1'); expect(within(screen.getByLabelText('所属群')).queryByRole('option', { name: '另一群' })).not.toBeInTheDocument(); expect(taskUI.create).not.toHaveBeenCalled();
  });
  it('renders current card data rather than stale DTO text and switches to neutral content when disabled', async () => {
    enableTasks(); taskUI.card.mockResolvedValue({ kind: 'unavailable' }); chat.histories['dm-a'] = [{ ...message('card1', '1', 'OLD-LEAK-TITLE'), taskCard: { kind: 'live', task: { ...integrationTask, title: 'OLD-LEAK-CARD' } } }]; showWorkspace(); await openConversation(); await screen.findByText('待办暂不可用'); expect(screen.queryByText('OLD-LEAK-TITLE')).not.toBeInTheDocument(); expect(screen.queryByText('OLD-LEAK-CARD')).not.toBeInTheDocument(); act(() => { taskUI.state = { ...taskUI.state!, enabled: false }; taskUI.listeners.forEach((fn) => fn()); }); expect(screen.getByText('当前未启用待办功能。')).toBeInTheDocument();
  });
  it('opens the independent snapshot save form only from a verified card result', async () => {
    enableTasks(); const snapshot = { title: '已确认静态副本', priority: 'normal', dueOn: null, dueTimezone: 'Asia/Shanghai' }; taskUI.card.mockResolvedValue({ kind: 'snapshot', snapshot }); chat.histories['dm-a'] = [{ ...message('snapshot1'), taskCard: { kind: 'unavailable' } }]; showWorkspace(); await openConversation(); fireEvent.click(await screen.findByRole('button', { name: '存为我的待办' })); await screen.findByRole('dialog', { name: '将静态副本存为我的待办' }); expect(screen.getByLabelText(/待办标题/)).toHaveValue('已确认静态副本'); expect(screen.getByLabelText('可见范围')).toBeDisabled(); expect(taskUI.create).not.toHaveBeenCalled();
  });
  it('keeps all low-frequency entries and pending failures reachable from the mobile more menu', () => {
    const go = vi.fn(); render(<NavigationRail active="tasks" onNavigate={go} badges={{ queue: 2, contacts: 1 }} failedCount={1} />); fireEvent.click(screen.getByRole('button', { name: '更多' })); const more = screen.getByRole('region', { name: '更多功能' }); expect(more).toHaveTextContent('有 1 条消息投递失败'); for (const label of ['联系人', '待发', '文件', '设置']) expect(within(more).getByRole('button', { name: new RegExp(label) })).toBeEnabled(); fireEvent.click(within(more).getByRole('button', { name: /待发/ })); expect(go).toHaveBeenCalledWith('queue');
  });
  it('loads later conversation pages from the task workspace and displays newly loaded groups', async () => {
    enableTasks(); chat.state!.nextConversations = 'group-page2'; chat.more.mockImplementation(async () => { publish({ conversations: [...chat.state!.conversations, { ...conversation('later-group', '后续页群组'), kind: 'group' }], nextConversations: null }); }); showWorkspace(); fireEvent.click(screen.getByRole('button', { name: '待办' })); await screen.findByText('任务真实标题'); fireEvent.click(screen.getByRole('button', { name: '加载更多会话与群' })); await screen.findByRole('button', { name: '后续页群组' }); expect(chat.more).toHaveBeenCalledTimes(1);
  });
  it('includes task-only drafts in logout confirmation, stops only after confirmation, and resumes after failure', async () => {
    enableTasks(); chat.summary.mockResolvedValue({ pending: 0, drafts: 0, taskDrafts: 2 }); chat.logout.mockRejectedValue(new Error('退出未成功')); showWorkspace(); fireEvent.click(screen.getByRole('button', { name: '设置' })); fireEvent.click(await screen.findByRole('button', { name: '退出登录' })); const prompt = await screen.findByRole('dialog', { name: '退出前，处理本机内容' }); expect(prompt).toHaveTextContent('2 份任务草稿'); expect(taskUI.stop).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '删除本机内容并退出' })); await screen.findByText('退出未成功'); expect(taskUI.stop).toHaveBeenCalledTimes(1); expect(taskUI.stop.mock.invocationCallOrder[0]).toBeLessThan(chat.logout.mock.invocationCallOrder[0]); expect(taskUI.start).toHaveBeenCalledTimes(2);
  });
  it('task notifications require available target and recheck the task before opening detail', async () => {
    enableTasks(); chat.state!.notifications = [{ id: 'n-task', type: 'task.assigned', entityRef: 'task-one', taskId: 'task-one', available: true, text: '分配给你的待办', readAt: 1, createdAt: 1 }]; showWorkspace(); fireEvent.click(screen.getByRole('button', { name: '通知' })); fireEvent.click(await screen.findByRole('button', { name: '核对并查看待办' })); await screen.findByRole('dialog', { name: '待办详情' }); expect(taskUI.get).toHaveBeenCalledWith('task-one');
  });
  it('unavailable task notification hides its old text and cannot navigate to a task or friend requests', () => {
    const open = vi.fn(); const requests = vi.fn(); render(<NotificationsPage actorContext={user.id} items={[{ id: 'n1', type: 'task.assigned', taskId: 'private-old', entityRef: 'private-old', available: false, text: 'OLD-PRIVATE-NOTIFICATION', readAt: 1, createdAt: 1 }]} hasMore={false} onLoadMore={vi.fn()} onRefresh={vi.fn()} onOpenRequests={requests} onOpenTask={open} />); expect(screen.queryByText('OLD-PRIVATE-NOTIFICATION')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: '核对并查看待办' })).toBeDisabled(); expect(open).not.toHaveBeenCalled(); expect(requests).not.toHaveBeenCalled();
  });
  it('offline recovery filters task drafts by identity and deletes through the exact revision-scoped task-draft API', async () => {
    const draft: TaskDraft = { id: 'draft-task', userId: user.id, taskId: null, kind: 'create', baseEtag: null, payload: { title: '本机任务输入', description: '不能自动提交' }, createdAt: 1, updatedAt: 2, expiresAt: 3 }; const data: OfflineLocalSnapshot = { identity: { key: 'active-user', user, revision: 'task-rev', savedAt: 1 }, outbox: [], drafts: [], taskDrafts: [draft, { ...draft, id: 'other', userId: 'other-user', payload: { title: '不可展示的他人草稿' } }], nextDraftCursor: null }; offline.read.mockResolvedValue(data); render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />); await screen.findByText('本机任务输入'); expect(screen.queryByText('不可展示的他人草稿')).not.toBeInTheDocument(); expect(screen.getByText('已过期，仅可保留或复制输入', { exact: false })).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '删除本机任务草稿' })); expect(offline.remove).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '确认删除本机条目' })); await waitFor(() => expect(offline.remove).toHaveBeenCalledWith('task-rev', 'taskDraft', 'draft-task')); expect(taskUI.start).not.toHaveBeenCalled();
  });
  it('offline identity change closes task draft content before later operations', async () => {
    const draft = { id: 'd1', userId: user.id, taskId: null, kind: 'create', baseEtag: null, payload: { title: '旧身份任务输入' }, createdAt: 1, updatedAt: 1, expiresAt: 2 } as TaskDraft; offline.read.mockResolvedValue({ identity: { key: 'active-user', user, revision: 'task-old', savedAt: 1 }, outbox: [], drafts: [], taskDrafts: [draft], nextDraftCursor: null }); render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />); await screen.findByText('旧身份任务输入'); act(() => offline.listeners.forEach((fn) => fn('identity'))); expect(screen.queryByText('旧身份任务输入')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '删除本机任务草稿' })).not.toBeInTheDocument(); expect(offline.remove).not.toHaveBeenCalled();
  });
});
describe('V3 deletion and IME integration', () => {
  it('passes all three local counts into deletion and resumes task state if reauthentication fails', async () => {
    enableTasks(); chat.summary.mockResolvedValue({ pending: 1, drafts: 2, taskDrafts: 3 }); vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/v1/account/deletion-preview' ? response({ coolingDays: 7, ownedGroups: [], lastAdministrator: false, sharedMessagesRetained: true }) : url === '/api/v1/auth/reauth' ? Promise.resolve({ ok: false, status: 403, json: async () => ({ error: { code: 'REAUTH_FAILED', message: '再次验证失败' } }) }) : response({ items: [], nextCursor: null })));
    showWorkspace(); fireEvent.click(screen.getByRole('button', { name: '设置' })); fireEvent.click(await screen.findByRole('tab', { name: '注销账号' })); fireEvent.click(await screen.findByRole('button', { name: '查看注销影响' })); const dialog = await screen.findByRole('dialog', { name: '注销账号' }); await within(dialog).findByText('当前账号本机有 1 条待发消息、2 份聊天草稿、3 份任务草稿。'); expect(taskUI.stop).not.toHaveBeenCalled(); fireEvent.change(within(dialog).getByLabelText('当前密码'), { target: { value: 'private-test-password' } }); fireEvent.change(within(dialog).getByLabelText(`输入登录名 ${user.username} 确认注销`), { target: { value: user.username } }); fireEvent.change(within(dialog).getByLabelText('本机内容处理'), { target: { value: 'delete' } }); fireEvent.click(within(dialog).getByRole('button', { name: '验证身份并注销账号' })); await within(dialog).findByText('再次验证失败'); expect(taskUI.stop).toHaveBeenCalledTimes(1); expect(chat.prepareDeletion).toHaveBeenCalledTimes(1); expect(chat.resumeDeletion).toHaveBeenCalledTimes(1); expect(taskUI.start).toHaveBeenCalledTimes(2); expect(chat.finishDeletion).not.toHaveBeenCalled();
  });
  it('keeps IME enter and task buttons separate from the chat send action', () => {
    const send = vi.fn(); const create = vi.fn(); render(<Composer value="正在输入" onChange={vi.fn()} onSend={send} onCreateTask={create} />); const input = screen.getByLabelText('消息内容'); fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true }); expect(send).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '新建待办' })).toBeDisabled(); fireEvent.compositionEnd(input); fireEvent.click(screen.getByRole('button', { name: '新建待办' })); expect(create).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled(); fireEvent.keyDown(input, { key: 'Enter' }); expect(send).toHaveBeenCalledTimes(1);
  });
});
describe('V3 source preview authority repair', () => {
  const location = (text: string, status: Message['status'] = 'sent') => ({ conversation: conversation(), targetId: 'source-message', items: [{ ...message('source-message', '1', text), status }], hasBefore: false, hasAfter: false });
  const emit = (type: string) => act(() => chat.taskEvents.forEach((receive) => receive({ type, entityRef: 'source-message', conversationId: 'dm-a' })));
  async function opening() { enableTasks(); chat.histories['dm-a'] = [message('source-message', '1', 'CAPTURED-OLD-SOURCE')]; showWorkspace(); await openConversation(); fireEvent.click(screen.getByRole('button', { name: '转为待办' })); return screen.findByRole('dialog', { name: '从消息创建待办' }); }
  it('never displays captured source text while initial authoritative context is pending', async () => {
    const pending = deferred<Awaited<ReturnType<typeof response>>>(); vi.mocked(fetch).mockImplementation(() => pending.promise as Promise<Response>); const dialog = await opening(); expect(within(dialog).queryByText('CAPTURED-OLD-SOURCE')).not.toBeInTheDocument(); await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/messages/source-message/context', expect.anything()));
    await act(async () => pending.resolve(await response(location('FRESH-SOURCE')))); await within(dialog).findByText('FRESH-SOURCE'); expect(chat.jump).not.toHaveBeenCalled(); expect(chat.select).toHaveBeenCalledTimes(1);
  });
  it('invalidates source confirmation on message changes, rejects late contexts and preserves user input', async () => {
    vi.mocked(fetch).mockImplementation(() => response(location('ORIGINAL-SERVER-SOURCE')) as Promise<Response>); const dialog = await opening(); await within(dialog).findByText('ORIGINAL-SERVER-SOURCE'); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '本人持续编辑' } }); fireEvent.click(screen.getByRole('checkbox', { name: /我已核对消息来源/ }));
    const earlier = deferred<Awaited<ReturnType<typeof response>>>(); const newer = deferred<Awaited<ReturnType<typeof response>>>(); vi.mocked(fetch).mockImplementationOnce(() => earlier.promise as Promise<Response>).mockImplementationOnce(() => newer.promise as Promise<Response>); emit('message.updated'); expect(within(dialog).queryByText('ORIGINAL-SERVER-SOURCE')).not.toBeInTheDocument(); expect(screen.getByRole('checkbox', { name: /我已核对消息来源/ })).not.toBeChecked(); expect(screen.getByRole('button', { name: '确认创建待办' })).toBeDisabled(); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); emit('message.updated'); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await act(async () => newer.resolve(await response(location('NEWEST-SOURCE')))); await within(dialog).findByText('NEWEST-SOURCE'); await act(async () => earlier.resolve(await response(location('LATE-STALE-SOURCE')))); expect(within(dialog).queryByText('LATE-STALE-SOURCE')).not.toBeInTheDocument(); expect(screen.getByLabelText(/待办标题/)).toHaveValue('本人持续编辑'); expect(screen.getByRole('checkbox', { name: /我已核对消息来源/ })).not.toBeChecked(); expect(taskUI.create).not.toHaveBeenCalled();
  });
  it('hides recalled or revoked source content without discarding the user form', async () => {
    vi.mocked(fetch).mockImplementation(() => response(location('READABLE-SOURCE')) as Promise<Response>); const dialog = await opening(); await within(dialog).findByText('READABLE-SOURCE'); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '保留本机填写标题' } }); vi.mocked(fetch).mockImplementation(() => response(location('', 'recalled')) as Promise<Response>); emit('message.updated'); await within(dialog).findByText('来源消息当前不可用，请重新核对。'); expect(within(dialog).queryByText('READABLE-SOURCE')).not.toBeInTheDocument(); expect(screen.getByLabelText(/待办标题/)).toHaveValue('保留本机填写标题');
    emit('access.revoked'); expect(screen.getByRole('button', { name: '确认创建待办' })).toBeDisabled(); expect(screen.getByLabelText(/待办标题/)).toHaveValue('保留本机填写标题'); expect(taskUI.create).not.toHaveBeenCalled(); expect(chat.jump).not.toHaveBeenCalled();
  });
  it('rejects a pending source read after access is revoked and retains local input', async () => {
    vi.mocked(fetch).mockImplementation(() => response(location('BEFORE-REVOKE-SOURCE')) as Promise<Response>); const dialog = await opening(); await within(dialog).findByText('BEFORE-REVOKE-SOURCE'); fireEvent.change(screen.getByLabelText(/待办标题/), { target: { value: '不会丢失的本人输入' } });
    const pending = deferred<Awaited<ReturnType<typeof response>>>(); vi.mocked(fetch).mockImplementationOnce(() => pending.promise as Promise<Response>); emit('message.updated'); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); emit('access.revoked'); await act(async () => pending.resolve(await response(location('LATE-REVOKED-SOURCE')))); expect(within(dialog).queryByText('LATE-REVOKED-SOURCE')).not.toBeInTheDocument(); expect(screen.getByLabelText(/待办标题/)).toHaveValue('不会丢失的本人输入'); expect(screen.getByRole('checkbox', { name: /我已核对消息来源/ })).toBeDisabled(); expect(taskUI.create).not.toHaveBeenCalled();
  });
});


describe('profile and settings overlays preserve the current conversation', () => {
  it('opens profile from the avatar and nickname without replacing the conversation or draft', async () => {
    chat.histories['dm-a'] = [message()];
    showWorkspace(); await openConversation();
    const editor = screen.getByLabelText('消息内容');
    fireEvent.change(editor, { target: { value: '资料打开前尚未发送的消息' } });
    const trigger = screen.getByRole('button', { name: '个人资料' });
    expect(trigger).toHaveTextContent(user.nickname);
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '个人资料' });
    expect(within(dialog).getByLabelText(/^昵称/)).toHaveValue(user.nickname);
    expect(within(dialog).getByRole('button', { name: '保存资料' })).toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toBe(editor);
    expect(editor).toHaveValue('资料打开前尚未发送的消息');
    expect(screen.getByText('一条真实形状的测试消息')).toBeInTheDocument();
    expect(chat.select).not.toHaveBeenCalledWith(null);
    expect(chat.queue).not.toHaveBeenCalled();
  });

  it('closes profile with the close control and restores focus to its entry without losing the draft', async () => {
    showWorkspace(); await openConversation();
    const editor = screen.getByLabelText('消息内容');
    fireEvent.change(editor, { target: { value: '关闭资料后继续输入' } });
    const trigger = screen.getByRole('button', { name: '个人资料' });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '个人资料' });
    const close = within(dialog).getByRole('button', { name: '关闭对话框' });
    close.focus(); fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '个人资料' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(screen.getByLabelText('消息内容')).toBe(editor);
    expect(editor).toHaveValue('关闭资料后继续输入');
  });

  it('offers account settings in a dialog without duplicating the profile editor', async () => {
    showWorkspace(); await openConversation();
    const editor = screen.getByLabelText('消息内容');
    fireEvent.change(editor, { target: { value: '打开设置不离开聊天' } });
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    expect(within(dialog).getByRole('button', { name: '退出登录' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^昵称/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '保存资料' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '个人资料' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toBe(editor);
    expect(editor).toHaveValue('打开设置不离开聊天');
    expect(chat.select).not.toHaveBeenCalledWith(null);
    expect(chat.queue).not.toHaveBeenCalled();
  });

  it('dismisses settings with Escape and returns focus to the settings entry', async () => {
    showWorkspace(); await openConversation();
    const editor = screen.getByLabelText('消息内容');
    fireEvent.change(editor, { target: { value: '取消设置也保留输入' } });
    const trigger = screen.getByRole('button', { name: '设置' });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    within(dialog).getByRole('button', { name: '关闭对话框' }).focus();
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(screen.getByLabelText('消息内容')).toBe(editor);
    expect(editor).toHaveValue('取消设置也保留输入');
    expect(chat.logout).not.toHaveBeenCalled();
  });
});

describe('bookmarks navigation protects conversation drafts', () => {
  it('waits for the current draft to commit before opening bookmarks and preserves it on return', async () => {
    showWorkspace(); await openConversation();
    const text = '进入收藏前尚未发送的草稿';
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: text } });
    const saving = deferred<void>(); chat.saveDraft.mockImplementation(() => saving.promise);
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    await waitFor(() => expect(chat.saveDraft).toHaveBeenCalledWith('dm-a', text, expect.anything()));
    expect(screen.queryByRole('heading', { name: '我的收藏' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toHaveValue(text);
    chat.getDraft.mockResolvedValue({ key: 'saved-before-bookmarks', userId: user.id, conversationId: 'dm-a', text, updatedAt: 1 });
    await act(async () => saving.resolve());
    await screen.findByRole('heading', { name: '我的收藏' });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/v1/bookmarks?'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '返回聊天' }));
    await waitFor(() => expect(screen.getByLabelText('消息内容')).toHaveValue(text));
    expect(chat.queue).not.toHaveBeenCalled();
  });

  it('keeps the conversation and draft visible if saving fails before bookmarks navigation', async () => {
    showWorkspace(); await openConversation();
    fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: '不能丢失的收藏导航草稿' } });
    chat.saveDraft.mockRejectedValue(new Error('收藏跳转前草稿保存失败'));
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    await screen.findByText('草稿保存失败，暂未切换页面。收藏跳转前草稿保存失败');
    expect(screen.queryByRole('heading', { name: '我的收藏' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toHaveValue('不能丢失的收藏导航草稿');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/v1/bookmarks?'))).toBe(false);
    expect(chat.queue).not.toHaveBeenCalled();
  });
});