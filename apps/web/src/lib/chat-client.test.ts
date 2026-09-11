// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatClient, mergeMessages, validateMessageText } from './chat-client';
import { setCsrfToken, type User } from './api';
import { openLocalDatabase, readQueue, readOfflineIdentity } from './outbox';
import type { Conversation, Message } from './chat-types';

vi.mock('socket.io-client', () => ({ io: () => {
  const events = new Map<string, () => void>();
  return { connected: false, on: (key: string, action: () => void) => events.set(key, action), connect: () => queueMicrotask(() => events.get('connect_error')?.()), disconnect: () => undefined, removeAllListeners: () => events.clear() };
} }));
const user: User = { id: 'u_client', username: 'client_user', nickname: '甲', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const peer = { id: 'u_peer', username: 'peer_user', nickname: '乙', online: false };
const originalConversation: Conversation = { id: 'dm_client', kind: 'direct', title: '乙', description: '', peer, role: 'member', periodId: null, memberCount: 2, lastSeq: '0', readSeq: '0', peerReadSeq: '0', unreadCount: 0, lastMessage: null, canSend: true, sendDisabledReason: null, sendErrorCode: null, accessKey: 'relation:1', updatedAt: 1, preferences: { muted: false, pinned: false, archived: false } };
function message(id: string, seq: string, text = id): Message { return { id, seq, text, conversationId: 'dm_client', senderId: user.id, sender: user, clientMessageId: null, kind: 'user', status: 'sent', createdAt: 1, replyToMessageId: null, reply: null, mentionedUserIds: [], attachments: [], reactions: [] }; }
const clients: ChatClient[] = [];
let connected: boolean; let conversation: Conversation; let sent: unknown[]; let identity: User; let messages: Message[];
let failSend: boolean;
function result(data: unknown, status = 200) { return { ok: status < 400, status, json: async () => status < 400 ? { data } : data }; }
beforeEach(async () => {
  const windowMock = Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } });
  vi.stubGlobal('window', windowMock); vi.stubGlobal('BroadcastChannel', undefined);
  connected = true; conversation = structuredClone(originalConversation); identity = user; sent = []; messages = []; failSend = false;
  vi.stubGlobal('navigator', { get onLine() { return connected; } });
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
  setCsrfToken('synthetic-csrf');
  const db = await openLocalDatabase();
  await new Promise<void>((resolve) => { const tx = db.transaction(['meta', 'outbox', 'drafts', 'leases'], 'readwrite'); for (const name of ['meta', 'outbox', 'drafts', 'leases']) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
    if (url.endsWith('/auth/me')) return result({ user: identity });
    if (url.endsWith('/auth/ws-ticket')) return result({ ticket: 'synthetic-ticket' });
    if (url.endsWith('/sync/snapshot')) return result({ cursor: '0', contacts: { items: [], nextCursor: null }, conversations: { items: [conversation], nextCursor: null }, requests: { items: [], nextCursor: null }, policy: {} });
    if (url.includes('/sync?')) return result({ items: [], cursor: '0', highWatermark: '0', hasMore: false });
    if (url.includes('/notifications?')) return result({ items: [], nextCursor: null, unreadCount: 0 });
    if (url.endsWith('/conversations/dm_client')) return result(conversation);
    if (url.includes('/conversations/dm_client/messages')) {
      if (options?.method === 'POST') {
        const command = JSON.parse(options.body!); sent.push(command);
        if (failSend) return result({ error: { code: 'TEMPORARY_UNAVAILABLE', message: 'Result not yet known' } }, 503);
        const accepted = { ...message('m_sent', '1', command.text), clientMessageId: command.clientMessageId }; messages = [accepted]; return result({ message: accepted, duplicate: false }, 201);
      }
      return result({ items: messages, nextCursor: null, hasMore: false, lastSeq: conversation.lastSeq });
    }
    if (url.endsWith('/auth/logout')) return result({ loggedOut: true });
    if (url.endsWith('/read')) return result({});
    throw new Error('Uncovered test request ' + url);
  }));
});
afterEach(async () => { for (const client of clients.splice(0)) client.stop(); await new Promise((resolve) => setTimeout(resolve, 5)); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(''); });
async function client() { const value = new ChatClient(user); clients.push(value); await value.start(); return value; }
async function until(condition: () => boolean | Promise<boolean>) { for (let attempt = 0; attempt < 80; attempt++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Expected client state did not settle'); }

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
});
