// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, mergeMessages, validateMessageText } from './chat-client';
import { setCsrfToken, type User } from './api';
import { openLocalDatabase, readQueue, readOfflineIdentity, rememberIdentity } from './outbox';
import type { Conversation, LocalAttachment, Message, SyncEvent } from './chat-types';
import type { UploadRecord } from './files-types';

const socketEvents = vi.hoisted(() => new Map<string, () => void>());
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
