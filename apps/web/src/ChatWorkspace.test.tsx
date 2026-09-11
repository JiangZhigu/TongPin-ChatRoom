// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatState, Contact, Conversation, Draft, FriendRequest, Message, QueuedMessage } from './lib/chat-types';
import type { UserView } from './auth-types';
import { ChatWorkspace } from './ChatWorkspace';
import { AccountSettings } from './AccountSettings';
import { ContactsPage } from './ContactsPage';
import { Composer } from './components/Composer';
import { OfflineRecoveryPage } from './OfflineRecoveryPage';
import { APIError } from './lib/api';
import type { OfflineLocalSnapshot } from './lib/outbox';

const offline = vi.hoisted(() => ({
  read: vi.fn<(revision?: string, cursor?: string) => Promise<OfflineLocalSnapshot | null>>(),
  remove: vi.fn<(revision: string, kind: 'outbox' | 'draft', key: string) => Promise<void>>(),
  listeners: new Set<(kind: 'identity' | 'content' | 'check') => void>(),
}));
vi.mock('./lib/outbox', () => ({
  readOfflineSnapshot: offline.read, removeOfflineItem: offline.remove,
  subscribeOfflineChanges: (listener: (kind: 'identity' | 'content' | 'check') => void) => { offline.listeners.add(listener); return () => { offline.listeners.delete(listener); }; },
}));

const chat = vi.hoisted(() => ({
  state: null as ChatState | null, listeners: new Set<() => void>(),
  start: vi.fn<() => Promise<void>>(), stop: vi.fn<() => void>(), updateUser: vi.fn(),
  select: vi.fn<(id: string | null) => Promise<void>>(), older: vi.fn<() => Promise<void>>(),
  queue: vi.fn<(id: string, text: string) => Promise<void>>(), retry: vi.fn<(id: string) => Promise<void>>(), cancel: vi.fn<(id: string) => Promise<void>>(),
  getDraft: vi.fn<(id: string) => Promise<Draft | null>>(), saveDraft: vi.fn<(id: string, text: string, position?: unknown) => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(), read: vi.fn<(id: string, seq: string) => Promise<void>>(),
  summary: vi.fn<() => Promise<{ pending: number; drafts: number }>>(), logout: vi.fn<(choice: 'keep' | 'delete') => Promise<void>>(),
  more: vi.fn<() => Promise<void>>(), histories: {} as Record<string, Message[]>,
}));
vi.mock('./lib/chat-client', () => ({ ChatClient: class {
  getSnapshot = () => chat.state!;
  subscribe = (listener: () => void) => { chat.listeners.add(listener); return () => { chat.listeners.delete(listener); }; };
  start = chat.start; stop = chat.stop; updateUser = chat.updateUser; selectConversation = chat.select; loadOlder = chat.older;
  queue = chat.queue; retry = chat.retry; cancel = chat.cancel; getDraft = chat.getDraft; saveDraft = chat.saveDraft;
  refresh = chat.refresh; read = chat.read; getLocalSummary = chat.summary; logout = chat.logout;
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
  chat.listeners.clear(); chat.state = freshState(); chat.histories = {};
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
    expect(chat.queue).toHaveBeenCalledWith('dm-a', '发送时的正文');
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
  it('uses the same client ID for retry and clearly limits cancellation to this device', async () => {
    chat.state!.outbox = [queued('待发消息正文', 'failed')]; showWorkspace(); fireEvent.click(screen.getByRole('button', { name: /^待发/ }));
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

const offlineData = (): OfflineLocalSnapshot => ({ identity: { key: 'active-user', user, revision: 'revision-a', savedAt: 1 }, outbox: [queued('离线保存的正文')], drafts: [{ key: 'draft-a', userId: user.id, conversationId: 'dm-a', text: '离线保存的草稿', updatedAt: 1 }], nextDraftCursor: null });
describe('M3-M4 unverified offline recovery UI', () => {
  it('does not expose kept content without an active local identity or start the authenticated client', async () => {
    render(<OfflineRecoveryPage onBack={vi.fn()} onReconnect={vi.fn()} />);
    expect(await screen.findByText('没有可展示的本机内容')).toBeInTheDocument();
    expect(screen.queryByText(user.nickname)).not.toBeInTheDocument(); expect(chat.start).not.toHaveBeenCalled();
    expect(screen.getByText('账号状态尚未验证，重新连接后确认身份再补发。')).toBeInTheDocument();
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
    expect(await screen.findByText('本机条目已删除；服务器已经收到的消息不受影响。')).toBeInTheDocument();
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
