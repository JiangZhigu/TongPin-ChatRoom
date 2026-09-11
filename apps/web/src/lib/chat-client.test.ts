// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, mergeMessages, validateMessageText } from './chat-client';
import { setCsrfToken, type User } from './api';
import { openLocalDatabase, readQueue, readOfflineIdentity, rememberIdentity } from './outbox';
import type { Conversation, LocalAttachment, Message, SyncEvent } from './chat-types';
import type { UploadRecord } from './files-types';
import { closeBrowserNotifications, showBrowserNotification } from './browser-notifications';

const socketEvents = vi.hoisted(() => new Map<string, () => void>());
vi.mock('./browser-notifications', () => ({ closeBrowserNotifications: vi.fn(), showBrowserNotification: vi.fn(() => true) }));
vi.mock('socket.io-client', () => ({ io: () => {
  const events = socketEvents;
  return { connected: false, on: (key: string, action: () => void) => events.set(key, action), connect: () => queueMicrotask(() => events.get('connect_error')?.()), disconnect: () => undefined, removeAllListeners: () => events.clear() };
} }));
const user: User = { id: 'u_client', username: 'client_user', nickname: '甲', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const peer = { id: 'u_peer', username: 'peer_user', nickname: '乙', online: false };
const originalConversation: Conversation = { id: 'dm_client', kind: 'direct', title: '乙', description: '', peer, role: 'member', periodId: null, memberCount: 2, lastSeq: '0', readSeq: '0', peerReadSeq: '0', unreadCount: 0, lastMessage: null, canSend: true, sendDisabledReason: null, sendErrorCode: null, accessKey: 'relation:1', updatedAt: 1, preferences: { muted: false, pinned: false, archived: false } };
function message(id: string, seq: string, text = id): Message { return { id, seq, text, conversationId: 'dm_client', senderId: user.id, sender: user, clientMessageId: null, kind: 'user', status: 'sent', createdAt: 1, replyToMessageId: null, reply: null, mentionedUserIds: [], attachments: [], reactions: [] }; }
const clients: ChatClient[] = [];
let connected: boolean; let conversation: Conversation; let sent: unknown[]; let identity: User; let messages: Message[];
let failSend: boolean;
let syncEvents: SyncEvent[];
function result(data: unknown, status = 200) { return { ok: status < 400, status, json: async () => status < 400 ? { data } : data }; }
beforeEach(async () => {
  const windowMock = Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } });
  vi.stubGlobal('window', windowMock); vi.stubGlobal('BroadcastChannel', undefined);
  connected = true; conversation = structuredClone(originalConversation); identity = user; sent = []; messages = []; failSend = false; syncEvents = []; socketEvents.clear();
  vi.stubGlobal('navigator', { get onLine() { return connected; } });
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
  setCsrfToken('synthetic-csrf');
  vi.mocked(showBrowserNotification).mockClear(); vi.mocked(closeBrowserNotifications).mockClear();
  const db = await openLocalDatabase();
  await new Promise<void>((resolve) => { const tx = db.transaction(['meta', 'outbox', 'drafts', 'leases'], 'readwrite'); for (const name of ['meta', 'outbox', 'drafts', 'leases']) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
    if (url.endsWith('/auth/me')) return result({ user: identity });
    if (url.endsWith('/auth/ws-ticket')) return result({ ticket: 'synthetic-ticket' });
    if (url.endsWith('/sync/snapshot')) return result({ cursor: '0', contacts: { items: [], nextCursor: null }, conversations: { items: [conversation], nextCursor: null }, requests: { items: [], nextCursor: null }, policy: {} });
    if (url.includes('/sync?')) {
      const after = new URL(url, 'http://localhost').searchParams.get('after') || '0';
      const items = syncEvents.filter((event) => BigInt(event.cursor) > BigInt(after));
      const cursor = syncEvents.at(-1)?.cursor || after;
      return result({ items, cursor, highWatermark: cursor, hasMore: false });
    }
    if (url.includes('/notifications?')) return result({ items: [], nextCursor: null, unreadCount: 0 });
    if (url.endsWith('/conversations/dm_client')) return result(conversation);
    if (url.includes('/conversations/dm_client/messages')) {
      if (options?.method === 'POST') {
        const command = JSON.parse(options.body!); sent.push(command);
        if (failSend) return result({ error: { code: 'TEMPORARY_UNAVAILABLE', message: 'Result not yet known' } }, 503);
        const accepted = { ...message('m_sent', '1', command.text), clientMessageId: command.clientMessageId }; messages = [accepted]; return result({ message: accepted, duplicate: false }, 201);
      }
      return result({ items: messages, nextCursor: null, hasMore: false, lastSeq: conversation.lastSeq, accessKey: conversation.accessKey });
    }
    if (url.endsWith('/auth/logout')) return result({ loggedOut: true });
    if (url.endsWith('/read')) return result({});
    throw new Error('Uncovered test request ' + url);
  }));
});

describe('rich message persistence, located windows and live hints', () => {
  function locations(items: Message[], options: { hasAfter?: boolean; delayed?: boolean } = {}) {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish!: () => void; let entered = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/context')) {
        entered = true;
        if (options.delayed) await new Promise<void>((resolve) => { finish = resolve; });
        return result({ conversation, items, targetId: items[0].id, hasBefore: true, hasAfter: options.hasAfter ?? true }) as Response;
      }
      if (String(url).includes('afterSeq=')) return result({ items: [message('next', '13'), message('end', '14')], accessKey: conversation.accessKey, hasMore: false, nextCursor: null, lastSeq: '14' }) as Response;
      if (String(url).endsWith('/typing')) return result({ items: [] }) as Response;
      return original(url, init);
    });
    return { ready: () => entered, finish: () => finish() };
  }
  async function live(current: ChatClient, item: SyncEvent) {
    syncEvents.push(item); socketEvents.get('sync.available')?.();
    await until(() => vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/sync?')));
    // A known current message makes completion observable without reading private client state.
    if (item.message && current.getSnapshot().selectedId === item.message.conversationId && (!current.getSnapshot().historyAfter || current.getSnapshot().messages.some((row) => row.id === item.message!.id))) await until(() => current.getSnapshot().messages.some((row) => row.id === item.message!.id && row.status === item.message!.status));
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  it('stores only rich reference IDs with the real Blob and preserves the same offline command across restart', async () => {
    const current = await client(); connected = false; window.dispatchEvent(new Event('offline'));
    const file = localFile(); const metadata = { replyToMessageId: 'original-id', mentionedUserIds: [peer.id], mentionAll: true, files: [file] };
    await current.saveDraft(conversation.id, '本机引用草稿', metadata);
    expect(await current.getDraft(conversation.id)).toMatchObject({ text: '本机引用草稿', ...metadata });
    await current.queue(conversation.id, '引用发送', metadata);
    const saved = (await readQueue(user.id))[0];
    expect(saved.payload).toMatchObject({ text: '引用发送', replyToMessageId: 'original-id', mentionedUserIds: [peer.id], mentionAll: true });
    current.stop(); const restarted = await client();
    expect((await readQueue(user.id))[0].payload).toEqual(saved.payload);
    expect(await (await readQueue(user.id))[0].files[0].blob.text()).toBe('real local bytes');
    expect((await restarted.getLocalSummary()).pending).toBe(1);
  });
  it('does not mark a located history window read or append a distant live message across its gap', async () => {
    conversation.lastSeq = '14'; messages = [message('latest', '14')];
    const current = await client(); await current.selectConversation(conversation.id);
    locations([message('old', '11'), { ...message('quote', '12'), reply: { id: 'old', status: 'available', text: 'old', author: '甲' } }]);
    await current.jumpToMessage('old'); await current.read(conversation.id, '12');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/read'))).toHaveLength(0);
    await live(current, event('1', { message: message('far-away', '20') }));
    expect(current.getSnapshot().messages.map((row) => row.seq)).toEqual(['11', '12']);
    await current.applyMessage({ ...message('old', '11', ''), status: 'recalled' }, current.beginMessageUpdate());
    expect(current.getSnapshot().messages[1].reply).toMatchObject({ status: 'unavailable', text: '', author: '' });
    await current.loadNewer(); expect(current.getSnapshot().historyAfter).toBeNull();
    expect(current.getSnapshot().messages.map((row) => row.seq)).toEqual(['11', '12', '13', '14']);
    await current.read(conversation.id, '14');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/read'))).toHaveLength(1);
  });
  it('keeps the older-window boundary while returning to latest history is still in flight', async () => {
    const current = await client(); locations([message('old', '11')]); await current.jumpToMessage('old');
    const delayed = delayHistory(); const selection = current.selectConversation(conversation.id); await until(delayed.ready);
    expect(current.getSnapshot().historyAfter).toBe('11');
    await current.read(conversation.id, '11');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/read'))).toHaveLength(0);
    delayed.finish([message('latest', '14')]); await selection;
    expect(current.getSnapshot().historyAfter).toBeNull(); expect(current.getSnapshot().messages.map((row) => row.seq)).toEqual(['14']);
  });
  it('rejects a delayed context captured before a recall without restoring its old body', async () => {
    messages = [message('current', '50')]; const current = await client(); await current.selectConversation(conversation.id);
    const pending = locations([message('removed', '11', 'must not return')], { delayed: true });
    const jump = current.jumpToMessage('removed'); const rejection = expect(jump).rejects.toMatchObject({ code: 'STALE_HISTORY' }); await until(pending.ready);
    await current.applyMessage({ ...message('removed', '11', ''), status: 'recalled' }, current.beginMessageUpdate());
    pending.finish(); await rejection;
    expect(current.getSnapshot().messages.map((row) => row.id)).toEqual(['current']);
    expect(current.getSnapshot().locatedMessageId).toBeNull();
  });
  it('ignores an old context response after the user changes selection', async () => {
    const current = await client(); const pending = locations([message('old', '11')], { delayed: true });
    const jump = current.jumpToMessage('old'); await until(pending.ready);
    await current.selectConversation(null); pending.finish(); await jump;
    expect(current.getSnapshot().selectedId).toBeNull(); expect(current.getSnapshot().messages).toEqual([]);
  });
  it('suppresses boot replay and respects live DND, conversation mute and mentions-only notification controls', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false });
    const fromPeer = (id: string, seq: string, changes: Partial<Message> = {}) => ({ ...message(id, seq), senderId: peer.id, sender: peer, ...changes });
    syncEvents = [event('1', { message: fromPeer('backlog', '1') })];
    const current = await client(); expect(showBrowserNotification).not.toHaveBeenCalled();
    await live(current, event('2', { message: fromPeer('fresh', '2') }));
    expect(showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showBrowserNotification).mock.calls[0][1].body).not.toContain('fresh');
    current.updateUser({ ...user, preferences: { ...user.preferences, doNotDisturb: true } });
    await live(current, event('3', { message: fromPeer('quiet', '3') }));
    expect(showBrowserNotification).toHaveBeenCalledTimes(1);
    current.updateUser(user); conversation = { ...conversation, preferences: { ...conversation.preferences, onlyMentions: true } };
    await live(current, event('4', { type: 'conversation.updated', conversation }));
    await live(current, event('5', { message: fromPeer('unmentioned', '5') }));
    expect(showBrowserNotification).toHaveBeenCalledTimes(1);
    await live(current, event('6', { message: fromPeer('mentioned', '6', { mentionedUserIds: [user.id] }) }));
    expect(showBrowserNotification).toHaveBeenCalledTimes(2);
    conversation = { ...conversation, preferences: { ...conversation.preferences, muted: true } };
    await live(current, event('7', { type: 'conversation.updated', conversation }));
    await live(current, event('8', { message: fromPeer('all-muted', '8', { mentionAll: true }) }));
    expect(showBrowserNotification).toHaveBeenCalledTimes(2);
    current.stop(); expect(closeBrowserNotifications).toHaveBeenCalledWith(user.id);
  });
  it('emits throttled text-free typing hints and pauses synchronization before account deletion', async () => {
    const current = await client(); locations([message('old', '11')]); await current.selectConversation(conversation.id);
    current.typing(true); current.typing(true); current.typing(false);
    await until(() => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/typing')).length === 2);
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/typing'));
    expect(calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([{ active: true }, { active: false }]);
    expect(await readQueue(user.id)).toEqual([]);
    await current.saveDraft(conversation.id, '选择保留的本机内容');
    await current.prepareAccountDeletion(); expect(current.getSnapshot().phase).not.toBe('expired');
    await current.finishAccountDeletion('keep');
    expect((await current.getDraft(conversation.id))?.text).toBe('选择保留的本机内容');
    expect(await readOfflineIdentity()).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/auth/logout'))).toBe(false);
  });
  it('announces refreshed account metadata without broadcasting private user content', async () => {
    const current = await client(); const listener = vi.fn();
    window.addEventListener('tongpin:account-changed', listener);
    identity = { ...user, restrictions: { uploadDisabled: true, groupCreationDisabled: true, reason: '当前限制', mutedUntil: null, muteReason: '' } };
    await live(current, event('1', { type: 'account.changed' }));
    await until(() => listener.mock.calls.length === 1);
    expect(listener.mock.calls[0][0].detail).toEqual({ userId: user.id });
    window.removeEventListener('tongpin:account-changed', listener);
  });
  it('does not let a delayed complete action response restore a recalled body or quoted text', async () => {
    const source = message('original', '10', '已撤回的正文');
    messages = [source, { ...message('quote', '11'), reply: { id: source.id, status: 'available', text: source.text, author: '甲' } }];
    const current = await client(); await current.selectConversation(conversation.id);
    const token = current.beginMessageUpdate();
    await live(current, event('1', { type: 'message.updated', message: { ...source, status: 'recalled', text: '' } }));
    await current.applyMessage({ ...source, reactions: [{ key: '1F44D', count: 1, mine: true }] }, token);
    expect(current.getSnapshot().messages[0]).toMatchObject({ id: source.id, status: 'recalled', text: '' });
    expect(current.getSnapshot().messages[1].reply).toMatchObject({ status: 'unavailable', text: '', author: '' });
  });
  it.each([true, false])('refreshes quoted projection after management restore with source in window=%s', async (includeSource) => {
    const source = message('original', '10', '😀'.repeat(245));
    const quote = { ...message('quote', '11'), reply: { id: source.id, status: 'available' as const, text: '😀'.repeat(240), author: '甲' } };
    messages = includeSource ? [source, quote] : [quote];
    const current = await client(); await current.selectConversation(conversation.id);
    syncEvents.push(event('1', { type: 'message.updated', message: { ...source, status: 'moderated', text: '' } }));
    socketEvents.get('sync.available')?.();
    await until(() => current.getSnapshot().messages.at(-1)?.reply?.status === 'unavailable');
    expect(current.getSnapshot().messages.at(-1)?.reply).toMatchObject({ status: 'unavailable', text: '', author: '' });
    syncEvents.push(event('2', { type: 'message.updated', message: source }));
    socketEvents.get('sync.available')?.();
    await until(() => current.getSnapshot().messages.at(-1)?.reply?.status === 'available');
    expect(current.getSnapshot().messages.at(-1)?.reply).toMatchObject({ status: 'available', text: '😀'.repeat(240), author: '甲' });
    expect(current.getSnapshot().messages.map((item) => item.id)).toEqual(includeSource ? ['original', 'quote'] : ['quote']);
  });
  it('patches only bookmark state after a recall and ignores results from an earlier client identity generation', async () => {
    const source = message('original', '10', '不可恢复的旧正文');
    conversation.lastMessage = source; messages = [source];
    const current = await client(); await current.selectConversation(conversation.id);
    const token = current.beginMessageUpdate();
    const removed = { ...source, status: 'recalled' as const, text: '' };
    await live(current, event('1', { type: 'message.updated', message: removed }));
    current.applyBookmark(source.id, true, token);
    expect(current.getSnapshot().messages[0]).toMatchObject({ status: 'recalled', text: '', bookmarked: true });
    expect(current.getSnapshot().conversations[0].lastMessage).toMatchObject({ status: 'recalled', text: '', bookmarked: true });
    current.stop(); messages = [removed]; conversation.lastMessage = removed;
    await current.start(); await current.selectConversation(conversation.id);
    current.applyBookmark(source.id, true, token);
    await current.applyMessage(source, token);
    expect(current.getSnapshot().messages[0]).toMatchObject({ status: 'recalled', text: '' });
    expect(current.getSnapshot().messages[0].bookmarked).not.toBe(true);
  });
  it('rejects a delayed older page when a recall happened outside the located window', async () => {
    const current = await client(); locations([message('visible', '75'), message('end', '125')]);
    await current.jumpToMessage('visible');
    const pending = delayHistory(); const older = current.loadOlder();
    const rejection = expect(older).rejects.toMatchObject({ code: 'STALE_HISTORY' });
    await until(pending.ready);
    await live(current, event('1', { type: 'message.updated', message: { ...message('removed', '60', ''), status: 'recalled' } }));
    pending.finish([message('removed', '60', '旧分页中的已撤回正文')]);
    await rejection;
    expect(current.getSnapshot().messages.map((row) => row.id)).toEqual(['visible', 'end']);
    expect(current.getSnapshot().historyLoading).toBe(false);
  });
  it('rejects a late latest-page response after an off-window recall while leaving search context', async () => {
    conversation.lastSeq = '200';
    const current = await client(); locations([message('visible', '75'), message('end', '125')]);
    await current.jumpToMessage('visible');
    const pending = delayHistory(); const selection = current.selectConversation(conversation.id);
    const rejection = expect(selection).rejects.toMatchObject({ code: 'STALE_HISTORY' });
    await until(pending.ready);
    await live(current, event('1', { type: 'message.updated', message: { ...message('removed', '140', ''), status: 'recalled' } }));
    pending.finish([message('removed', '140', '已撤回的最新分页正文')]);
    await rejection;
    expect(current.getSnapshot().messages.map((row) => row.id)).toEqual(['visible', 'end']);
    expect(current.getSnapshot().historyAfter).toBe('125');
  });
  it('does not append a send acknowledgement across a gap in the located history', async () => {
    const current = await client(); locations([message('visible', '11'), message('end', '12')]);
    await current.jumpToMessage('visible');
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/conversations/dm_client/messages') && init?.method === 'POST') {
        const payload = JSON.parse(init.body as string);
        return result({ message: { ...message('newest', '100', payload.text), clientMessageId: payload.clientMessageId }, duplicate: false }, 201) as Response;
      }
      return original(url, init);
    });
    await current.queue(conversation.id, '查看旧记录时发送新消息');
    await until(async () => (await readQueue(user.id)).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(current.getSnapshot().messages.map((row) => row.seq)).toEqual(['11', '12']);
    expect(current.getSnapshot().historyAfter).toBe('12');
  });
  it('removes a successfully acknowledged outbox entry without restoring a body recalled before the ACK arrived', async () => {
    const current = await client(); await current.selectConversation(conversation.id);
    const original = vi.mocked(fetch).getMockImplementation()!;
    let accepted: Message | undefined; let finish!: () => void; let settled = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/conversations/dm_client/messages') && init?.method === 'POST') {
        const payload = JSON.parse(init.body as string);
        accepted = { ...message('ack_late', '1', payload.text), clientMessageId: payload.clientMessageId };
        await new Promise<void>((resolve) => { finish = resolve; });
        settled = true; return result({ message: accepted, duplicate: false }, 201) as Response;
      }
      return original(url, init);
    });
    await current.queue(conversation.id, '发送已成功随后在另一设备撤回');
    await until(() => Boolean(accepted));
    await live(current, event('1', { message: accepted! }));
    await live(current, event('2', { type: 'message.updated', message: { ...accepted!, status: 'recalled', text: '' } }));
    finish(); await until(() => settled);
    await until(async () => (await readQueue(user.id)).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(current.getSnapshot().messages).toMatchObject([{ id: 'ack_late', status: 'recalled', text: '' }]);
    expect(current.getSnapshot().outbox).toEqual([]);
  });
});
describe('notification reference authority', () => {
  const notice = { id: 'assigned', type: 'task.assigned', entityRef: 't_private', taskId: 't_private', available: true, text: '撤权后不可留下的标题', createdAt: 1, readAt: null };
  it.each(['access.revoked', 'task.deleted', 'conversation.updated'])('hides cached task and mention previews before %s revalidation finishes', async (type) => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let held = false; let entered = false; let release!: () => void;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/notifications?')) {
        if (held) { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return result({ items: [{ ...notice, text: '相关待办当前不可用', taskId: undefined, available: false }], nextCursor: null, unreadCount: 1 }) as Response; }
        return result({ items: [notice, { ...notice, id: 'mention', type: 'message.mentioned', taskId: undefined, messageId: 'm_old', conversationId: conversation.id }, { ...notice, id: 'report', type: 'task.report.updated', text: '举报结案反馈', taskId: undefined }], nextCursor: null, unreadCount: 3 }) as Response;
      }
      return original(url, init);
    });
    const current = await client(); expect(current.getSnapshot().notifications[0].text).toBe(notice.text);
    held = true; syncEvents.push(event('1', { type, entityRef: notice.entityRef })); socketEvents.get('sync.available')?.();
    await until(() => entered);
    expect(current.getSnapshot().notifications[0]).toMatchObject({ available: false, taskId: undefined });
    expect(current.getSnapshot().notifications[0].text).not.toContain(notice.text);
    expect(current.getSnapshot().notifications[1]).toMatchObject({ available: false, messageId: undefined, conversationId: undefined });
    expect(current.getSnapshot().notifications[2].text).toBe('举报结案反馈');
    release(); await until(() => current.getSnapshot().notifications.length === 1);
    expect(current.getSnapshot().notifications[0].available).toBe(false);
  });
  it('discards a paginated notification response captured before access revocation', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let revoked = false; let entered = false; let release!: () => void;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/notifications?')) {
        if (String(url).includes('&after=')) { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return result({ items: [{ ...notice, id: 'late' }], nextCursor: null, unreadCount: 2 }) as Response; }
        return result({ items: revoked ? [{ ...notice, text: '已撤权', available: false, taskId: undefined }] : [notice], nextCursor: revoked ? null : 'older', unreadCount: 1 }) as Response;
      }
      return original(url, init);
    });
    const current = await client(); const pending = current.loadMoreNotifications(); await until(() => entered);
    revoked = true; syncEvents.push(event('1', { type: 'access.revoked' })); socketEvents.get('sync.available')?.();
    await until(() => current.getSnapshot().notifications[0].text === '已撤权');
    release(); await pending;
    expect(current.getSnapshot().notifications).toHaveLength(1);
    expect(current.getSnapshot().notifications[0]).toMatchObject({ text: '已撤权', available: false });
    expect(current.getSnapshot().nextNotifications).toBeNull();
  });
});

afterEach(async () => { for (const client of clients.splice(0)) client.stop(); await new Promise((resolve) => setTimeout(resolve, 5)); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(''); });
async function client() { const value = new ChatClient(user); clients.push(value); await value.start(); return value; }
async function until(condition: () => boolean | Promise<boolean>) { for (let attempt = 0; attempt < 200; attempt++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Expected client state did not settle'); }
function event(cursor: string, changes: Partial<SyncEvent>): SyncEvent { return { v: 1, eventId: cursor, cursor, type: 'message.created', entityRef: 'message', occurredAt: 1, conversationId: conversation.id, ...changes }; }
function delayHistory() {
  const fetchMock = vi.mocked(fetch); const original = fetchMock.getMockImplementation()!;
  let finish!: (value: unknown) => void; let entered = false;
  fetchMock.mockImplementation((url, options) => {
    if (!entered && String(url).includes('/conversations/dm_client/messages') && options?.method !== 'POST') { entered = true; return new Promise((resolve) => { finish = resolve as (value: unknown) => void; }); }
    return original(url, options);
  });
  return { ready: () => entered, finish: (items: Message[], accessKey = 'relation:1', before: string | null = null) => finish(result({ items, nextCursor: before, hasMore: before !== null, lastSeq: items.at(-1)?.seq || '0', accessKey })) };
}

function fileServer(initialState: UploadRecord['state'] = 'ready') {
  const conversations = [conversation, { ...conversation, id: 'dm_file_b' }, { ...conversation, id: 'dm_text' }];
  const records = new Map<string, UploadRecord>();
  const requests: { url: string; method: string; body: unknown }[] = [];
  const deliveries: { conversationId: string; payload: Record<string, unknown> }[] = [];
  const control = { state: initialState, loseUploadResult: false, loseMessageResult: false, holdUpload: false };
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = String(input), method = options?.method || 'GET';
    requests.push({ url, method, body: options?.body });
    const reply = (data: unknown, status = 200) => result(data, status) as unknown as Response;
    if (url.endsWith('/sync/snapshot')) return reply({ cursor: '0', contacts: { items: [], nextCursor: null }, conversations: { items: conversations, nextCursor: null }, requests: { items: [], nextCursor: null }, policy: {} });
    const detail = conversations.find((row) => url.endsWith('/conversations/' + row.id));
    if (detail) return reply(detail);
    if (url.endsWith('/attachment-uploads')) {
      const data = JSON.parse(options!.body as string);
      const id = 'f_' + data.clientUploadId;
      const record: UploadRecord = { id, name: data.name, size: data.size, mime: 'text/plain', kind: 'file', purpose: 'message', conversationId: data.conversationId, state: 'reserved', scanStatus: 'unknown', errorCode: null, error: null, bound: false, createdAt: 1, expiresAt: Date.now() + 86400000, contentUrl: '' };
      records.set(id, record); return reply(record, 201);
    }
    if (url.endsWith('/attachments') && method === 'POST') {
      const id = new Headers(options?.headers).get('X-Upload-Id')!;
      const record = records.get(id)!; record.state = control.state;
      expect(options?.body).toBeInstanceOf(Blob);
      expect(await (options?.body as Blob).text()).toBe('real local bytes');
      if (control.holdUpload) await new Promise<void>((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }); });
      if (control.loseUploadResult) { control.loseUploadResult = false; throw new TypeError('Synthetic lost response after received bytes'); }
      return reply(record, 202);
    }
    const attachment = url.match(/\/attachments\/([^/]+)(?:\/(retry|cancel))?$/);
    if (attachment) {
      const record = records.get(attachment[1])!;
      if (attachment[2] === 'retry') record.state = 'ready';
      else if (attachment[2] === 'cancel') record.state = 'cancelled';
      else if (record.state === 'processing') record.state = control.state;
      return reply(record);
    }
    const send = url.match(/\/conversations\/([^/]+)\/messages$/);
    if (send && method === 'POST') {
      const payload = JSON.parse(options!.body as string); deliveries.push({ conversationId: send[1], payload });
      if (control.loseMessageResult) { control.loseMessageResult = false; return reply({ error: { code: 'TEMPORARY_UNAVAILABLE', message: 'Synthetic lost ACK' } }, 503); }
      return reply({ message: { ...message('m_' + payload.clientMessageId, String(deliveries.length), payload.text), conversationId: send[1], clientMessageId: payload.clientMessageId, attachments: payload.attachmentIds.map((id: string) => records.get(id)) }, duplicate: false }, 201);
    }
    return original(input, options);
  });
  return { conversations, records, requests, deliveries, control };
}
function localFile(): LocalAttachment { return { id: crypto.randomUUID(), blob: new Blob(['real local bytes']), name: '本机文件.txt', mime: 'text/plain' }; }

describe('real Blob outbox and controlled HTTP upload scheduling', () => {
  it('keeps two processing file conversations ordered while a newly queued third conversation sends text', async () => {
    const server = fileServer('processing'); const current = await client();
    await current.queue(conversation.id, '', { files: [localFile()] });
    await current.queue('dm_file_b', '', { files: [localFile()] });
    await until(() => server.records.size === 2 && [...server.records.values()].every((row) => row.state === 'processing'));
    await current.queue(conversation.id, 'must wait behind file');
    await current.queue('dm_text', 'text proceeds independently');
    await until(() => server.deliveries.length === 1);
    expect(server.deliveries[0]).toMatchObject({ conversationId: 'dm_text', payload: { text: 'text proceeds independently', attachmentIds: [] } });
    expect((await readQueue(user.id)).filter((row) => row.conversationId === conversation.id)).toHaveLength(2);
    server.control.state = 'ready';
    await until(async () => (await readQueue(user.id)).length === 0);
    const sameConversation = server.deliveries.filter((row) => row.conversationId === conversation.id);
    expect(sameConversation.map((row) => row.payload.text)).toEqual(['', 'must wait behind file']);
    expect(sameConversation[0].payload.attachmentIds).toHaveLength(1);
  });

  it('retains upload identifiers after an unknown raw response and reuses ready bytes without uploading again', async () => {
    const server = fileServer(); server.control.loseUploadResult = true; const current = await client();
    await current.queue(conversation.id, '', { files: [localFile()] });
    await until(async () => (await readQueue(user.id))[0]?.errorCode === 'NETWORK_ERROR');
    const retained = (await readQueue(user.id))[0]; expect(retained.files[0].attachmentId).toBeTruthy();
    expect(await retained.files[0].blob.text()).toBe('real local bytes');
    await current.retry(retained.payload.clientMessageId); await until(async () => (await readQueue(user.id)).length === 0);
    expect(server.requests.filter((row) => row.url.endsWith('/attachments') && row.method === 'POST')).toHaveLength(1);
    expect(server.requests.filter((row) => row.url.endsWith('/attachment-uploads'))).toHaveLength(1);
    expect(server.deliveries[0].payload.attachmentIds).toEqual([retained.files[0].attachmentId]);
  });

  it('retains the same message and attachment IDs across client restart after an unknown message ACK', async () => {
    const server = fileServer(); server.control.loseMessageResult = true; const current = await client();
    await current.queue(conversation.id, 'same bytes after restart', { files: [localFile()] });
    await until(async () => (await readQueue(user.id))[0]?.errorCode === 'TEMPORARY_UNAVAILABLE');
    const retained = (await readQueue(user.id))[0]; current.stop();
    const restarted = await client(); await restarted.retry(retained.payload.clientMessageId);
    await until(async () => (await readQueue(user.id)).length === 0);
    expect(server.deliveries).toHaveLength(2); expect(server.deliveries[0]).toEqual(server.deliveries[1]);
    expect(server.requests.filter((row) => row.url.endsWith('/attachments') && row.method === 'POST')).toHaveLength(1);
  });

  it('stops the same conversation behind quarantine and requests scanning again only on explicit retry', async () => {
    const server = fileServer('quarantined'); const current = await client();
    await current.queue(conversation.id, '', { files: [localFile()] });
    await until(async () => (await readQueue(user.id))[0]?.state === 'failed');
    const first = (await readQueue(user.id))[0]; expect(first.errorCode).toBe('FILE_QUARANTINED');
    await current.queue(conversation.id, 'ordered after quarantine'); await current.queue('dm_text', 'other conversation');
    await until(() => server.deliveries.length === 1); expect(server.deliveries[0].conversationId).toBe('dm_text');
    await current.refresh(); expect(server.requests.filter((row) => row.url.endsWith('/retry'))).toHaveLength(0);
    await current.retry(first.payload.clientMessageId); await until(async () => (await readQueue(user.id)).length === 0);
    expect(server.requests.filter((row) => row.url.endsWith('/retry'))).toHaveLength(1);
    expect(server.deliveries.filter((row) => row.conversationId === conversation.id).map((row) => row.payload.text)).toEqual(['', 'ordered after quarantine']);
  });

  it('aborts a pending raw upload, cancels its persisted record and never sends the removed entry', async () => {
    const server = fileServer('processing'); server.control.holdUpload = true; const current = await client();
    await current.queue(conversation.id, '', { files: [localFile()] });
    await until(() => server.requests.some((row) => row.url.endsWith('/attachments') && row.method === 'POST'));
    const retained = (await readQueue(user.id))[0]; await current.cancel(retained.payload.clientMessageId);
    expect(await readQueue(user.id)).toEqual([]); expect(server.deliveries).toEqual([]);
    expect(server.requests.filter((row) => row.url.endsWith('/cancel'))).toHaveLength(1);
  });

  it('preserves account A Blob and prevents send when identity changes during processing', async () => {
    const server = fileServer('processing'); const current = await client();
    await current.queue(conversation.id, '', { files: [localFile()] });
    await until(() => [...server.records.values()].some((row) => row.state === 'processing'));
    await rememberIdentity({ id: 'u_next', username: 'next_user', nickname: '下一个账号' }, await readOfflineIdentity());
    server.control.state = 'ready'; await until(() => current.getSnapshot().phase === 'expired');
    expect(server.deliveries).toEqual([]); expect((await readOfflineIdentity())?.user.id).toBe('u_next');
    expect(await (await readQueue(user.id))[0].files[0].blob.text()).toBe('real local bytes');
  });
});

describe('chat synchronization and outbox lifecycle', () => {
  it('merges duplicate updates using full decimal sequence precision and validates Unicode size', () => {
    expect(mergeMessages([message('later', '9007199254740993'), message('earlier', '9007199254740992')], [message('earlier', '9007199254740992', 'updated')]).map((item) => item.text)).toEqual(['updated', 'later']);
    expect(() => validateMessageText('🙂'.repeat(4000))).not.toThrow();
    expect(() => validateMessageText('🙂'.repeat(4001))).toThrow();
    expect(() => validateMessageText('line\nsecond\ttab')).not.toThrow();
    expect(() => validateMessageText('\ud800')).toThrow();
    expect(() => validateMessageText('\u0000')).toThrow();
  });

  it('retains offline queued text, then retries the same ID after an uncertain server result', async () => {
    const current = await client(); connected = false; window.dispatchEvent(new Event('offline'));
    await current.queue(conversation.id, 'offline persisted');
    const queued = (await readQueue(user.id))[0]; expect(queued.payload.actorContext).toBe(user.id); expect(sent).toHaveLength(0);
    failSend = true; connected = true; await current.refresh();
    await until(async () => (await readQueue(user.id))[0]?.errorCode === 'TEMPORARY_UNAVAILABLE');
    failSend = false; await current.retry(queued.payload.clientMessageId);
    await until(async () => (await readQueue(user.id)).length === 0);
    expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
  });

  it('stops an old queued message when the permission period changed while offline', async () => {
    const current = await client(); connected = false; window.dispatchEvent(new Event('offline'));
    await current.queue(conversation.id, 'old permission');
    conversation = { ...conversation, accessKey: 'relation:2' }; connected = true; await current.refresh();
    await until(() => current.getSnapshot().outbox[0]?.errorCode === 'STALE_ACCESS');
    expect(current.getSnapshot().outbox[0].state).toBe('failed'); expect(sent).toHaveLength(0);
    await expect(current.retry(current.getSnapshot().outbox[0].payload.clientMessageId)).rejects.toMatchObject({ code: 'STALE_ACCESS' });
  });

  it('does not send account A queue after the HTTP cookie changes to account B', async () => {
    const current = await client(); connected = false; window.dispatchEvent(new Event('offline'));
    await current.queue(conversation.id, 'only A'); identity = { ...user, id: 'u_new' }; connected = true;
    await expect(current.refresh()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(current.getSnapshot().phase).toBe('expired'); expect(sent).toHaveLength(0);
    expect((await readQueue(user.id))).toHaveLength(1); await until(async () => (await readOfflineIdentity()) === null);
  });

  it('forgets identity on keep-logout but preserves only the old account pending content', async () => {
    const current = await client(); connected = false; window.dispatchEvent(new Event('offline'));
    await current.queue(conversation.id, 'keep on this machine'); connected = true;
    await current.logout('keep'); expect(await readOfflineIdentity()).toBeNull();
    expect((await readQueue(user.id))).toHaveLength(1); expect(sent).toHaveLength(0);
  });

  it('refreshes cached bodies after reconnect so recalled source content cannot linger', async () => {
    messages = [message('first', '1', 'private old body')]; const current = await client();
    await current.selectConversation(conversation.id); expect(current.getSnapshot().messages[0].text).toBe('private old body');
    connected = false; window.dispatchEvent(new Event('offline')); messages = [{ ...messages[0], status: 'recalled', text: '' }];
    connected = true; await current.refresh();
    expect(current.getSnapshot().messages).toMatchObject([{ status: 'recalled', text: '' }]);
  });

  it('retains a newly synchronized message after a delayed history page and an empty subsequent sync', async () => {
    const current = await client(); const delayed = delayHistory();
    const selection = current.selectConversation(conversation.id); await until(delayed.ready);
    const arriving = message('m11', '11', 'arrived while loading');
    syncEvents = [event('11', { message: arriving, conversation: { ...conversation, lastSeq: '11' } })];
    socketEvents.get('sync.available')?.(); await until(() => current.getSnapshot().messages.some((row) => row.id === 'm11'));
    delayed.finish(Array.from({ length: 10 }, (_, i) => message('m' + (i + 1), String(i + 1)))); await selection;
    socketEvents.get('sync.available')?.(); await until(() => vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/sync?after=11')));
    expect(current.getSnapshot().messages.map((row) => row.seq)).toEqual(Array.from({ length: 11 }, (_, i) => String(i + 1)));
    expect(current.getSnapshot().conversations[0].lastSeq).toBe('11');
  });

  it('retains a committed own-send result while the initial history response is delayed', async () => {
    const current = await client(); const delayed = delayHistory(); const selection = current.selectConversation(conversation.id); await until(delayed.ready);
    await current.queue(conversation.id, 'accepted while loading'); await until(() => current.getSnapshot().messages.some((row) => row.id === 'm_sent'));
    delayed.finish([]); await selection;
    expect(current.getSnapshot().messages).toMatchObject([{ id: 'm_sent', text: 'accepted while loading' }]);
    expect(await readQueue(user.id)).toEqual([]);
  });

  it('keeps a recall and redacts a quote arriving in an older history response', async () => {
    const current = await client(); const delayed = delayHistory(); const selection = current.selectConversation(conversation.id); await until(delayed.ready);
    syncEvents = [event('1', { type: 'message.updated', message: { ...message('first', '1'), status: 'recalled', text: '' } })];
    socketEvents.get('sync.available')?.(); await until(() => current.getSnapshot().messages[0]?.status === 'recalled');
    delayed.finish([message('first', '1', 'old source'), { ...message('quote', '2'), replyToMessageId: 'first', reply: { id: 'first', status: 'available', text: 'old source', author: 'old author' } }]); await selection;
    expect(current.getSnapshot().messages[0]).toMatchObject({ status: 'recalled', text: '' });
    expect(current.getSnapshot().messages[1].reply).toEqual({ id: 'first', status: 'unavailable', text: '', author: '' });
  });

  it('rejects a late page from a previous permission period instead of rendering its bodies', async () => {
    const current = await client(); const delayed = delayHistory(); const selection = current.selectConversation(conversation.id);
    await until(delayed.ready);
    conversation = { ...conversation, accessKey: 'relation:2' }; messages = [message('new-period', '2', 'current authorized history')];
    syncEvents = [event('1', { type: 'conversation.updated', conversation })];
    socketEvents.get('sync.available')?.(); await until(() => current.getSnapshot().messages[0]?.id === 'new-period');
    delayed.finish([message('old-period', '1', 'forbidden after rejoin')]); await selection;
    expect(current.getSnapshot().messages).toMatchObject([{ id: 'new-period', text: 'current authorized history' }]);
  });

  it('reloads readable history after live mute and role changes without reopening the conversation', async () => {
    messages = [message('readable', '1', 'history survives a sending restriction')];
    const current = await client(); await current.selectConversation(conversation.id);
    conversation = { ...conversation, accessKey: 'relation:2', canSend: false, sendErrorCode: 'MUTED', sendDisabledReason: '当前处于禁言状态' };
    syncEvents = [event('1', { type: 'conversation.updated', conversation })]; socketEvents.get('sync.available')?.();
    await until(() => current.getSnapshot().conversations[0].accessKey === 'relation:2' && !current.getSnapshot().historyLoading);
    expect(current.getSnapshot().messages).toMatchObject([{ id: 'readable', text: 'history survives a sending restriction' }]);
    expect(current.getSnapshot().conversations[0].canSend).toBe(false);
    conversation = { ...conversation, accessKey: 'relation:3', role: 'admin', canSend: true, sendErrorCode: null, sendDisabledReason: null };
    syncEvents.push(event('2', { type: 'conversation.updated', conversation })); socketEvents.get('sync.available')?.();
    await until(() => current.getSnapshot().conversations[0].accessKey === 'relation:3' && !current.getSnapshot().historyLoading);
    expect(current.getSnapshot().messages).toMatchObject([{ id: 'readable' }]);
    expect(current.getSnapshot().conversations[0].role).toBe('admin');
  });

  it('offers older pagination at a gap between an old window and newer history', async () => {
    messages = [message('old', '1')]; const current = await client(); await current.selectConversation(conversation.id);
    messages = [message('new', '10'), message('latest', '11')]; await current.selectConversation(conversation.id);
    expect(current.getSnapshot().messages.map((row) => row.seq)).toEqual(['10', '11']); expect(current.getSnapshot().historyBefore).toBe('10');
  });

  it('does not clear a newer A identity when an old A client discovers a changed cookie', async () => {
    const current = await client(); await current.queue(conversation.id, 'settle initial delivery'); await until(async () => sent.length === 1 && (await readQueue(user.id)).length === 0);
    const captured = (await readOfflineIdentity())!;
    const fetchMock = vi.mocked(fetch); const original = fetchMock.getMockImplementation()!;
    let finish!: (value: Response) => void; let entered = false;
    fetchMock.mockImplementation((url, options) => {
      if (String(url).endsWith('/auth/me')) { entered = true; return new Promise((resolve) => { finish = resolve; }); }
      return original(url, options);
    });
    const refresh = current.refresh(); const rejected = expect(refresh).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); await until(() => entered);
    const other = { ...user, id: 'u_other' }; await rememberIdentity(other, captured); await rememberIdentity(user, await readOfflineIdentity());
    const renewed = (await readOfflineIdentity())!; expect(renewed.revision).not.toBe(captured.revision);
    finish(result({ user: other }) as Response); await rejected;
    expect((await readOfflineIdentity())?.revision).toBe(renewed.revision);
  });
});
