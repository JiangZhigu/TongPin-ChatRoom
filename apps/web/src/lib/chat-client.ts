import { io, type Socket } from 'socket.io-client';
import { api, APIError, onAuthExpired, type User } from './api';
import type { ChatSnapshot, ChatState, Contact, Conversation, Draft, FriendRequest, HistoryPage, LocalAttachment, Message, NotificationItem, Page, QueuedMessage, SendPayload, SendResult, SyncEvent, SyncPage, UserSummary } from './chat-types';
import { uploadLocalAttachment, validateLocalFiles } from './files';
import type { MessageLocation, TypingUser } from './interactions-types';
import { closeBrowserNotifications, showBrowserNotification } from './browser-notifications';
import { addQueuedMessage, changeQueuedMessage, clearLocalUser, forgetIdentity, localError, localSummary, OUTBOX_AGE_MS, readDraft, readOfflineIdentity, readQueue, rememberIdentity, saveLocalDraft, withDeliveryLock } from './outbox';

const initialState = (): ChatState => ({ phase: 'connecting', conversations: [], contacts: [], requests: [], notifications: [], notificationCount: 0, selectedId: null, messages: [], historyBefore: null, historyAfter: null, locatedMessageId: null, typingUsers: [], historyLoading: false, outbox: [], error: null, nextConversations: null, nextContacts: null, nextRequests: null, nextNotifications: null, onlineNotice: null });
const permanentErrors = new Set(['VALIDATION_ERROR', 'PAYLOAD_TOO_LARGE', 'IDEMPOTENCY_CONFLICT', 'STALE_ACCESS', 'FRIENDSHIP_REQUIRED', 'CONTACT_UNAVAILABLE', 'RESOURCE_UNAVAILABLE', 'MUTED', 'CONVERSATION_FROZEN', 'FILE_REJECTED', 'FILE_QUARANTINED', 'FILE_NOT_READY', 'FILE_TYPE_UNSUPPORTED', 'FILE_INVALID', 'FILE_SIZE_MISMATCH', 'FILE_HASH_MISMATCH', 'FILE_INFECTED', 'FILE_IN_USE', 'ATTACHMENT_LIMIT', 'USER_QUOTA_EXCEEDED', 'OUTBOX_EXPIRED']);
const bySequence = (one: Message, two: Message) => BigInt(one.seq) < BigInt(two.seq) ? -1 : BigInt(one.seq) > BigInt(two.seq) ? 1 : one.id.localeCompare(two.id);
export function mergeMessages(existing: Message[], additions: Message[]): Message[] {
  const rows = new Map([...existing, ...additions].map((message) => [message.id, message]));
  return [...rows.values()].map((message) => {
    const source = message.reply ? rows.get(message.reply.id) : undefined;
    return source && source.status !== 'sent' ? { ...message, reply: { ...message.reply!, status: 'unavailable' as const, text: '', author: '' } } : message;
  }).sort(bySequence);
}
function mergeItems<T extends { id: string }>(existing: T[], additions: T[]): T[] { return [...new Map([...existing, ...additions].map((item) => [item.id, item])).values()]; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '暂时无法完成操作，请重试。'; }
export function validateMessageText(text: string, allowEmpty = false) {
  if ([...text].length > 4000 || new TextEncoder().encode(text).byteLength > 16384) throw new APIError(413, { code: 'PAYLOAD_TOO_LARGE', message: '消息最多4000字且不超过16 KiB。' });
  if (!allowEmpty && !text.trim()) throw new APIError(422, { code: 'VALIDATION_ERROR', message: '请填写消息内容。' });
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text) || [...text].some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) throw new APIError(422, { code: 'VALIDATION_ERROR', message: '消息不能包含无效或控制字符。' });
}

type WindowCache = { accessKey: string; messages: Message[]; before: string | null; after?: string | null };
export type MessageUpdateToken = Readonly<{ generation: number; contentRevision: number }>;
export class ChatClient {
  private user: User;
  private state = initialState();
  private listeners = new Set<() => void>();
  private running = false;
  private generation = 0;
  private selectionGeneration = 0;
  private contentRevision = 0;
  private messageUpdateTokens = new WeakSet<MessageUpdateToken>();
  private controller = new AbortController();
  private socket: Socket | null = null;
  private channel: BroadcastChannel | null = null;
  private unsubscribeExpiry: (() => void) | null = null;
  private cursor = '0';
  private initialized = false;
  private syncFlight: Promise<void> | null = null;
  private syncAgain = false;
  private drainFlight: Promise<void> | null = null;
  private wakeDelivery: (() => void) | null = null;
  private deliveryTasks = new Map<string, AbortController>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingFlight = false;
  private lastTyping = 0;
  private alertsEnabled = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private instanceId = crypto.randomUUID();
  private windows = new Map<string, WindowCache>();
  private localReady = false;
  private localIdentityRevision: string | null = null;
  private enqueueFlight: Promise<void> = Promise.resolve();
  private reading = new Set<string>();
  private online = () => { if (this.running) void this.reconnect(); };
  private offline = () => { if (this.running) { this.initialized = false; this.alertsEnabled = false; this.set({ phase: 'offline', typingUsers: [] }); this.closeSocket(); } };

  constructor(user: User) { this.user = user; }
  getSnapshot = (): ChatState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  updateUser(user: User) { if (user.id === this.user.id) this.user = user; }
  private set(patch: Partial<ChatState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private current(epoch: number) { return this.running && epoch === this.generation; }
  private request<T>(path: string, options: { method?: string; body?: unknown } = {}) { return api<T>('/api/v1' + path, { ...options, signal: this.controller.signal }); }
  private announce() { this.channel?.postMessage({ type: 'local.changed', userId: this.user.id }); }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true; const epoch = ++this.generation; this.controller = new AbortController();
    this.set({ phase: 'connecting', error: null });
    window.addEventListener('online', this.online); window.addEventListener('offline', this.offline);
    this.unsubscribeExpiry = onAuthExpired(() => this.expire());
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('tongpin-state-v1');
      this.channel.onmessage = (event) => {
        if (!this.current(epoch)) return;
        if (event.data?.type === 'identity.changed' && event.data.userId !== this.user.id) { this.expire(); return; }
        if (event.data?.userId === this.user.id) { void this.loadLocal(epoch); void this.synchronize(); void this.drain(); }
      };
    }
    this.pollTimer = setInterval(() => {
      if (!this.current(epoch)) return;
      void this.loadLocal(epoch);
      if (this.initialized) { void this.synchronize(); void this.drain(); }
      else if (navigator.onLine && !this.syncFlight) void this.reconnect();
    }, 5000);
    this.typingTimer = setInterval(() => { void this.pollTyping(); }, 2000);
    const flight = this.initialize(epoch);
    this.syncFlight = flight;
    try { await flight; }
    catch (error) { this.connectionFailure(error, epoch); }
    finally { if (this.syncFlight === flight) this.syncFlight = null; }
  }

  stop(): void {
    this.running = false; this.generation++; this.selectionGeneration++; this.initialized = false;
    this.controller.abort(); this.closeSocket();
    for (const task of this.deliveryTasks.values()) task.abort();
    this.wakeDelivery?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.pollTimer = null; this.reconnectTimer = null; this.noticeTimer = null;
    this.typingTimer = null; this.typingFlight = false; this.alertsEnabled = false;
    closeBrowserNotifications(this.user.id);
    this.unsubscribeExpiry?.(); this.unsubscribeExpiry = null;
    this.channel?.close(); this.channel = null;
    window.removeEventListener('online', this.online); window.removeEventListener('offline', this.offline);
    this.windows.clear(); this.syncFlight = null; this.drainFlight = null;
  }

  private expire() {
    if (!this.running) return;
    this.stop();
    if (this.localIdentityRevision) void forgetIdentity(this.user.id, this.localIdentityRevision).catch(() => undefined);
    this.set({ ...initialState(), phase: 'expired', error: '登录身份已改变，请重新登录后继续。' });
  }

  private connectionFailure(error: unknown, epoch: number) {
    if (!this.current(epoch) || this.controller.signal.aborted) return;
    if (error instanceof APIError && ['AUTH_REQUIRED', 'SESSION_REVOKED', 'LOCAL_IDENTITY_CHANGED'].includes(error.code)) { this.expire(); return; }
    this.initialized = false;
    this.set({ phase: 'offline', error: error instanceof APIError ? error.message : '连接暂时中断。本机待发内容会保留，恢复连接后先核对权限。' });
    this.scheduleReconnect();
  }

  private async verifyIdentity(epoch: number) {
    let previous = null;
    try { previous = await readOfflineIdentity(); this.localReady = true; if (!this.localIdentityRevision && previous?.user.id === this.user.id) this.localIdentityRevision = previous.revision; }
    catch (error) { this.localReady = false; if (this.current(epoch)) this.set({ error: localError(error).message }); }
    const data = await this.request<{ user: User }>('/auth/me');
    if (!this.current(epoch)) return;
    if (data.user.id !== this.user.id) { this.expire(); throw new APIError(401, { code: 'AUTH_REQUIRED', message: '浏览器已切换账号。' }); }
    this.user = data.user;
    if (this.localReady) {
      try { this.localIdentityRevision = (await rememberIdentity(this.user, previous)).revision; }
      catch (error) {
        if (error instanceof APIError && error.code === 'LOCAL_IDENTITY_CHANGED') throw error;
        this.localReady = false; this.set({ error: localError(error).message });
      }
      if (this.localReady && previous?.user.id !== this.user.id) this.channel?.postMessage({ type: 'identity.changed', userId: this.user.id });
    }
  }

  private async initialize(epoch: number) {
    await this.verifyIdentity(epoch);
    if (!this.current(epoch)) return;
    await this.loadLocal(epoch);
    await this.openSocket(epoch);
    if (!this.current(epoch)) return;
    await this.fullSnapshot(epoch);
    if (this.current(epoch)) void this.drain();
  }

  private async reconnect() {
    if (!this.running || !navigator.onLine || this.syncFlight) return;
    const epoch = this.generation;
    const flight = this.initialize(epoch).catch((error) => this.connectionFailure(error, epoch));
    this.syncFlight = flight;
    try { await flight; } finally { if (this.syncFlight === flight) this.syncFlight = null; }
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer || !navigator.onLine) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(5, this.retryAttempt++)) * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.reconnect(); }, delay);
  }

  private closeSocket() { if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); this.socket = null; } }
  private async openSocket(epoch: number): Promise<void> {
    if (this.socket?.connected || !this.current(epoch)) return;
    this.closeSocket();
    const ticket = await this.request<{ ticket: string }>('/auth/ws-ticket', { method: 'POST', body: {} });
    if (!this.current(epoch)) return;
    const socket = io(window.location.origin, { transports: ['websocket'], autoConnect: false, reconnection: false, forceNew: true, withCredentials: true, timeout: 6000, auth: { ticket: ticket.ticket } });
    this.socket = socket;
    socket.on('sync.available', () => { if (this.current(epoch)) { this.syncAgain = true; if (this.initialized) void this.synchronize(); } });
    socket.on('presence.changed', (value: { userId: string; online: boolean; notify: boolean; user: UserSummary }) => {
      if (!this.current(epoch)) return;
      this.set({ contacts: this.state.contacts.map((item) => item.id === value.userId ? { ...item, online: value.online } : item), conversations: this.state.conversations.map((item) => item.peer?.id === value.userId ? { ...item, peer: { ...item.peer, online: value.online } } : item) });
      if (value.notify && value.online && !this.user.preferences.doNotDisturb) {
        this.set({ onlineNotice: { id: crypto.randomUUID(), user: value.user } });
        if (this.noticeTimer) clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => { if (this.current(epoch)) this.set({ onlineNotice: null }); }, 6000);
      }
    });
    socket.on('disconnect', () => {
      if (!this.current(epoch) || this.socket !== socket) return;
      this.set({ phase: navigator.onLine ? 'degraded' : 'offline' });
      this.scheduleReconnect();
    });
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); this.controller.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 6500);
      this.controller.signal.addEventListener('abort', finish, { once: true });
      socket.on('connect', () => { if (this.current(epoch)) { this.retryAttempt = 0; if (this.initialized) this.set({ phase: 'online' }); } finish(); });
      socket.on('connect_error', () => { finish(); if (this.current(epoch)) this.scheduleReconnect(); });
      socket.connect();
    });
  }

  private async fullSnapshot(epoch: number) {
    this.alertsEnabled = false;
    if (this.current(epoch)) this.set({ phase: 'syncing' });
    const snapshot = await this.request<ChatSnapshot>('/sync/snapshot');
    if (!this.current(epoch)) return;
    const selected = this.state.selectedId;
    this.contentRevision++;
    // Fresh server state replaces stale permission-bearing lists.
    this.windows.clear();
    this.set({ messages: [], historyBefore: null, historyAfter: null, locatedMessageId: null, typingUsers: [] });
    this.cursor = snapshot.cursor;
    this.set({ contacts: snapshot.contacts.items, conversations: snapshot.conversations.items, requests: snapshot.requests.items, nextContacts: snapshot.contacts.nextCursor, nextConversations: snapshot.conversations.nextCursor, nextRequests: snapshot.requests.nextCursor });
    if (selected && !this.state.conversations.some((item) => item.id === selected)) {
      try {
        const detail = await this.request<Conversation>('/conversations/' + encodeURIComponent(selected));
        if (this.current(epoch)) this.upsertConversation(detail);
      } catch (error) { if (error instanceof APIError && [403, 404].includes(error.status)) this.revokeConversation(selected); else throw error; }
    }
    await this.catchUp(epoch);
    await this.loadNotifications(epoch, false);
    if (!this.current(epoch)) return;
    this.initialized = true; this.retryAttempt = 0;
    this.set({ phase: this.socket?.connected ? 'online' : 'degraded', error: this.localReady ? null : this.state.error });
    if (this.state.selectedId) await this.selectConversation(this.state.selectedId);
    if (this.current(epoch)) this.alertsEnabled = true;
  }

  async refresh(): Promise<void> {
    if (!this.running) return;
    if (this.syncFlight) await this.syncFlight;
    const epoch = this.generation;
    const flight = (async () => { await this.verifyIdentity(epoch); if (this.current(epoch)) await this.fullSnapshot(epoch); })();
    this.syncFlight = flight;
    try { await flight; } catch (error) { this.connectionFailure(error, epoch); throw error; }
    finally { if (this.syncFlight === flight) this.syncFlight = null; }
    if (this.current(epoch)) void this.drain();
  }

  private async synchronize(): Promise<void> {
    if (!this.running || !this.initialized) return;
    if (this.syncFlight) { this.syncAgain = true; return; }
    const epoch = this.generation;
    const flight = (async () => {
      try { await this.catchUp(epoch); if (this.current(epoch)) this.set({ phase: this.socket?.connected ? 'online' : 'degraded' }); }
      catch (error) { if (error instanceof APIError && error.code === 'RESYNC_REQUIRED') await this.fullSnapshot(epoch); else this.connectionFailure(error, epoch); }
    })();
    this.syncFlight = flight;
    try { await flight; } finally { if (this.syncFlight === flight) this.syncFlight = null; }
  }

  private async catchUp(epoch: number) {
    do {
      this.syncAgain = false;
      let more: boolean;
      do {
        const page = await this.request<SyncPage>('/sync?after=' + encodeURIComponent(this.cursor) + '&limit=100');
        if (!this.current(epoch)) return;
        let contactsChanged = false; let notificationsChanged = false;
        for (const event of page.items) {
          if (!this.current(epoch)) return;
          if (BigInt(event.cursor) <= BigInt(this.cursor)) continue;
          await this.applyEvent(event, epoch);
          contactsChanged ||= event.type === 'contacts.changed';
          notificationsChanged ||= event.type.startsWith('notification.');
        }
        if (contactsChanged) {
          const [contacts, requests] = await Promise.all([this.request<Page<Contact>>('/friends?limit=100'), this.request<Page<FriendRequest>>('/friend-requests?limit=100')]);
          if (this.current(epoch)) this.set({ contacts: contacts.items, requests: requests.items, nextContacts: contacts.nextCursor, nextRequests: requests.nextCursor });
        }
        if (notificationsChanged) await this.loadNotifications(epoch, false);
        if (!this.current(epoch)) return;
        this.cursor = page.cursor; more = page.hasMore;
      } while (more && this.current(epoch));
    } while (this.syncAgain && this.current(epoch));
  }

  private upsertConversation(conversation: Conversation) {
    const cached = this.windows.get(conversation.id);
    const previous = this.state.conversations.find((item) => item.id === conversation.id);
    if ((cached && cached.accessKey !== conversation.accessKey) || (previous && previous.accessKey !== conversation.accessKey)) {
      this.contentRevision++;
      this.windows.delete(conversation.id);
      if (this.state.selectedId === conversation.id) this.set({ messages: [], historyBefore: null });
    }
    this.set({ conversations: mergeItems(this.state.conversations, [conversation]).sort((one, two) => Number(two.preferences.pinned) - Number(one.preferences.pinned) || two.updatedAt - one.updatedAt || one.id.localeCompare(two.id)) });
  }

  private revokeConversation(cid: string) {
    this.contentRevision++;
    this.windows.delete(cid);
    if (this.state.selectedId === cid) { this.selectionGeneration++; this.set({ selectedId: null, messages: [], historyBefore: null, historyAfter: null, locatedMessageId: null, typingUsers: [], historyLoading: false }); }
    this.set({ conversations: this.state.conversations.filter((conversation) => conversation.id !== cid) });
  }

  private async applyEvent(event: SyncEvent, epoch: number) {
    if (event.type === 'message.updated') this.contentRevision++;
    if (event.type === 'account.changed') {
      const account = await this.request<{ user: User }>('/auth/me');
      if (this.current(epoch)) {
        this.updateUser(account.user);
        if (account.user.id === this.user.id) window.dispatchEvent(new CustomEvent('tongpin:account-changed', { detail: { userId: this.user.id } }));
      }
      return;
    }
    if (event.type === 'access.revoked' && event.conversationId) { this.revokeConversation(event.conversationId); return; }
    const refreshHistory = event.conversation && this.state.selectedId === event.conversation.id && this.state.conversations.some((item) => item.id === event.conversation!.id && item.accessKey !== event.conversation!.accessKey);
    if (event.conversation) this.upsertConversation(event.conversation);
    if (event.message) {
      const message = event.message;
      const cache = this.windows.get(message.conversationId);
      // This event carries the server's current authorized source projection.
      // Refresh visible references without inserting a source across a history gap.
      const updateReference = (item: Message): Message => {
        if (item.status !== 'sent' || item.conversationId !== message.conversationId || item.reply?.id !== message.id) return item;
        return { ...item, reply: message.status === 'sent'
          ? { id: message.id, status: 'available', text: [...message.text].slice(0, 240).join(''), author: message.sender?.nickname ?? '系统' }
          : { id: message.id, status: 'unavailable', text: '', author: '' } };
      };
      const update = (messages: Message[], hasAfter = false) => {
        const known = messages.some((item) => item.id === message.id);
        const last = messages.at(-1);
        const append = event.type === 'message.created' && (!hasAfter || !!last && BigInt(message.seq) === BigInt(last.seq) + 1n) || event.type === 'message.updated' && !hasAfter && this.state.historyLoading && this.state.selectedId === message.conversationId;
        return mergeMessages(messages, known || append ? [message] : []).map(updateReference);
      };
      if (cache) {
        const updated = update(cache.messages, !!cache.after);
        cache.messages = updated.slice(-1000);
        if (updated.length > 1000) cache.before = cache.messages[0].seq;
      }
      if (this.state.selectedId === message.conversationId) {
        const messages = update(this.state.messages, !!this.state.historyAfter);
        const last = messages.at(-1);
        const latest = this.state.conversations.find((item) => item.id === message.conversationId)?.lastSeq;
        this.set({ messages, ...(this.state.historyAfter && last ? { historyAfter: latest && BigInt(last.seq) >= BigInt(latest) ? null : last.seq } : {}) });
      }
      this.set({ conversations: this.state.conversations.map((item) => item.lastMessage ? { ...item, lastMessage: item.lastMessage.id === message.id ? message : updateReference(item.lastMessage) } : item) });
      if (event.type === 'message.created' && this.alertsEnabled && this.initialized && message.senderId !== this.user.id && message.kind === 'user' && message.status === 'sent' && !this.user.preferences.doNotDisturb && (document.visibilityState !== 'visible' || !document.hasFocus())) {
        const conversation = this.state.conversations.find((item) => item.id === message.conversationId);
        const mentioned = message.mentionAll || message.mentionedUserIds.includes(this.user.id);
        if (conversation && !conversation.preferences.muted && (!conversation.preferences.onlyMentions || mentioned)) {
          showBrowserNotification(this.user.id, { tag: conversation.id, title: '同频 · 收到新消息', body: mentioned ? '有人在消息中提及了你，打开同频查看。' : '你有一条新消息，打开同频查看。', onClick: () => { if (this.current(epoch)) window.dispatchEvent(new CustomEvent('tongpin:open-message', { detail: { userId: this.user.id, messageId: message.id } })); } });
        }
      }
      if (message.senderId === this.user.id && message.clientMessageId && this.localReady) {
        await changeQueuedMessage(this.user.id, this.user.id + ':' + message.clientMessageId, () => null);
        await this.loadLocal(epoch); this.announce();
      }
    }
    // Permission changes invalidate the old window, including write-only changes
    // such as mute/role updates. Reload the authorized history for the open chat.
    if (refreshHistory && this.current(epoch) && this.state.selectedId === event.conversation!.id) await this.selectConversation(event.conversation!.id);
  }

  async selectConversation(id: string | null): Promise<void> {
    const previous = this.state.selectedId;
    if (previous && previous !== id) this.cacheWindow(previous);
    const selection = ++this.selectionGeneration; const epoch = this.generation;
    if (!id) { this.set({ selectedId: null, messages: [], historyBefore: null, historyAfter: null, locatedMessageId: null, typingUsers: [], historyLoading: false }); return; }
    const cache = this.windows.get(id);
    this.lastTyping = 0;
    this.set({ selectedId: id, messages: cache?.messages || (previous === id ? this.state.messages : []), historyBefore: cache?.before || null, historyAfter: cache?.after || (previous === id ? this.state.historyAfter : null), locatedMessageId: null, typingUsers: [], historyLoading: true });
    if (!navigator.onLine || !this.initialized) { this.set({ historyLoading: false }); return; }
    const startedConversation = this.state.conversations.find((item) => item.id === id);
    const startedMessages = this.state.messages;
    const startedById = new Map(startedMessages.map((item) => [item.id, item]));
    const startedBefore = this.state.historyBefore;
    const startedAfter = this.state.historyAfter;
    const contentRevision = this.contentRevision;
    try {
      const [conversation, history] = await Promise.all([this.request<Conversation>('/conversations/' + encodeURIComponent(id)), this.request<HistoryPage>('/conversations/' + encodeURIComponent(id) + '/messages?limit=50')]);
      if (!this.current(epoch) || this.selectionGeneration !== selection) return;
      if (startedAfter && contentRevision !== this.contentRevision) throw new APIError(409, { code: 'STALE_HISTORY', message: '消息内容刚刚改变，请重新返回最新消息。' });
      const currentConversation = this.state.conversations.find((item) => item.id === id);
      const newerConversation = currentConversation !== startedConversation ? currentConversation : null;
      if (history.accessKey !== conversation.accessKey || (newerConversation && newerConversation.accessKey !== history.accessKey)) throw new APIError(409, { code: 'STALE_HISTORY', message: '会话权限已改变，请重新加载当前可访问的历史。' });
      // Only rows changed since this request began override its fresh history.
      // This preserves new events/ACKs and tombstones without preserving stale cache bodies.
      const duringRequest = this.state.messages.filter((item) => startedById.get(item.id) !== item);
      const matching = (cache?.accessKey || startedConversation?.accessKey) === history.accessKey;
      let combined = mergeMessages(mergeMessages(matching ? startedMessages : [], history.items), duringRequest);
      let before = matching && startedMessages.length && (!history.items.length || BigInt(startedMessages[0].seq) <= BigInt(history.items[0].seq)) ? startedBefore : history.nextCursor;
      let contiguousStart = 0;
      for (let i = 1; i < combined.length; i++) if (BigInt(combined[i].seq) !== BigInt(combined[i - 1].seq) + 1n) contiguousStart = i;
      if (contiguousStart) { combined = combined.slice(contiguousStart); before = combined[0].seq; }
      if (!newerConversation) this.upsertConversation(conversation);
      this.set({ messages: combined, historyBefore: before, historyAfter: null, historyLoading: false });
      this.cacheWindow(id);
    } catch (error) {
      if (!this.current(epoch) || this.selectionGeneration !== selection) return;
      if (error instanceof APIError && [403, 404].includes(error.status)) this.revokeConversation(id);
      this.set({ historyLoading: false, error: errorMessage(error) });
      throw error;
    }
  }

  private cacheWindow(cid: string) {
    const conversation = this.state.conversations.find((item) => item.id === cid);
    if (!conversation) return;
    this.windows.delete(cid);
    const messages = this.state.messages.slice(-1000);
    this.windows.set(cid, { accessKey: conversation.accessKey, messages, before: this.state.messages.length > 1000 ? messages[0].seq : this.state.historyBefore, after: this.state.historyAfter });
    while (this.windows.size > 10) this.windows.delete(this.windows.keys().next().value!);
  }

  async jumpToMessage(messageId: string): Promise<void> {
    if (!this.running || !this.initialized || !navigator.onLine) throw new APIError(503, { code: 'CONNECTION_REQUIRED', message: '请恢复连接后定位消息，当前草稿会保留。' });
    const epoch = this.generation; const selection = ++this.selectionGeneration;
    const contentRevision = this.contentRevision;
    const previous = this.state.selectedId;
    const known = new Map(this.state.conversations.map((conversation) => [conversation.id, conversation]));
    const location = await this.request<MessageLocation>('/messages/' + encodeURIComponent(messageId) + '/context');
    if (!this.current(epoch) || selection !== this.selectionGeneration) return;
    if (contentRevision !== this.contentRevision) throw new APIError(409, { code: 'STALE_HISTORY', message: '消息或访问权限刚刚改变，请重新定位。' });
    const changed = this.state.conversations.find((conversation) => conversation.id === location.conversation.id);
    if (changed && changed !== known.get(changed.id) && changed.accessKey !== location.conversation.accessKey) throw new APIError(409, { code: 'STALE_HISTORY', message: '消息权限已经改变，请重新打开搜索结果。' });
    if (previous) this.cacheWindow(previous);
    this.upsertConversation(location.conversation);
    this.set({ selectedId: location.conversation.id, messages: location.items, historyBefore: location.hasBefore ? location.items[0]?.seq || null : null, historyAfter: location.hasAfter ? location.items.at(-1)?.seq || null : null, locatedMessageId: location.targetId, historyLoading: false, typingUsers: [] });
    this.cacheWindow(location.conversation.id);
  }

  async loadNewer(): Promise<void> {
    const cid = this.state.selectedId; const after = this.state.historyAfter;
    if (!cid || !after || this.state.historyLoading || !this.running || !this.initialized) return;
    const epoch = this.generation; const selection = this.selectionGeneration;
    const contentRevision = this.contentRevision;
    const accessKey = this.state.conversations.find((item) => item.id === cid)?.accessKey;
    this.set({ historyLoading: true });
    try {
      const page = await this.request<HistoryPage>('/conversations/' + encodeURIComponent(cid) + '/messages?afterSeq=' + encodeURIComponent(after) + '&limit=50');
      if (!this.current(epoch) || selection !== this.selectionGeneration) return;
      if (contentRevision !== this.contentRevision) throw new APIError(409, { code: 'STALE_HISTORY', message: '消息内容刚刚改变，请重新加载。' });
      if (page.accessKey !== accessKey || this.state.conversations.find((item) => item.id === cid)?.accessKey !== accessKey) throw new APIError(409, { code: 'STALE_HISTORY', message: '会话权限已改变，请重新加载消息。' });
      this.set({ messages: mergeMessages(this.state.messages, page.items), historyAfter: page.hasMore ? page.nextCursor : null, historyLoading: false });
      this.cacheWindow(cid);
    } catch (error) { if (this.current(epoch) && selection === this.selectionGeneration) this.set({ historyLoading: false, error: errorMessage(error) }); throw error; }
  }

  beginMessageUpdate(): MessageUpdateToken {
    const token = Object.freeze({ generation: this.generation, contentRevision: this.contentRevision });
    this.messageUpdateTokens.add(token);
    return token;
  }

  async applyMessage(message: Message, token: MessageUpdateToken): Promise<void> {
    if (!this.messageUpdateTokens.has(token) || !this.current(token.generation)) return;
    if (token.contentRevision !== this.contentRevision) { this.syncAgain = true; void this.synchronize(); return; }
    await this.applyEvent({ v: 1, eventId: '0', cursor: '0', type: 'message.updated', entityRef: message.id, occurredAt: Date.now(), conversationId: message.conversationId, message }, this.generation);
  }

  applyBookmark(messageId: string, bookmarked: boolean, token: MessageUpdateToken): void {
    if (!this.messageUpdateTokens.has(token) || !this.current(token.generation)) return;
    // A bookmark response carries no message body and may safely update a tombstone.
    const patch = (message: Message) => message.id === messageId ? { ...message, bookmarked } : message;
    for (const cache of this.windows.values()) cache.messages = cache.messages.map(patch);
    this.set({ messages: this.state.messages.map(patch), conversations: this.state.conversations.map((item) => item.lastMessage?.id === messageId ? { ...item, lastMessage: patch(item.lastMessage) } : item) });
  }

  typing(active: boolean): void {
    const cid = this.state.selectedId;
    if (!cid || !this.running || !this.initialized || !navigator.onLine) return;
    if (active && (document.visibilityState !== 'visible' || !document.hasFocus() || Date.now() - this.lastTyping < 2000 || !this.state.conversations.find((item) => item.id === cid)?.canSend)) return;
    this.lastTyping = active ? Date.now() : 0;
    // This hint never contains text and never enters the durable outbox.
    void this.request('/conversations/' + encodeURIComponent(cid) + '/typing', { method: 'POST', body: { active } }).catch(() => undefined);
  }

  private async pollTyping(): Promise<void> {
    const cid = this.state.selectedId; const epoch = this.generation; const selection = this.selectionGeneration;
    const remaining = this.state.typingUsers?.filter((item) => item.expiresAt > Date.now()) || [];
    if (remaining.length !== this.state.typingUsers?.length) this.set({ typingUsers: remaining });
    if (!cid || !this.running || !this.initialized || !navigator.onLine || this.typingFlight || document.visibilityState !== 'visible') return;
    this.typingFlight = true;
    try { const result = await this.request<{ items: TypingUser[] }>('/conversations/' + encodeURIComponent(cid) + '/typing'); if (this.current(epoch) && selection === this.selectionGeneration) this.set({ typingUsers: result.items }); }
    catch { if (this.current(epoch) && selection === this.selectionGeneration) this.set({ typingUsers: [] }); }
    finally { if (this.current(epoch)) this.typingFlight = false; }
  }

  async loadOlder(): Promise<void> {
    const cid = this.state.selectedId; const before = this.state.historyBefore;
    if (!cid || !before || this.state.historyLoading) return;
    const epoch = this.generation; const selection = this.selectionGeneration;
    const contentRevision = this.contentRevision;
    const accessKey = this.state.conversations.find((item) => item.id === cid)?.accessKey;
    this.set({ historyLoading: true });
    try {
      const history = await this.request<HistoryPage>('/conversations/' + encodeURIComponent(cid) + '/messages?limit=50&beforeSeq=' + encodeURIComponent(before));
      if (!this.current(epoch) || selection !== this.selectionGeneration) return;
      if (contentRevision !== this.contentRevision) throw new APIError(409, { code: 'STALE_HISTORY', message: '消息内容刚刚改变，请重新加载历史。' });
      if (accessKey !== history.accessKey || this.state.conversations.find((item) => item.id === cid)?.accessKey !== accessKey) throw new APIError(409, { code: 'STALE_HISTORY', message: '会话权限已改变，请重新加载历史。' });
      this.set({ messages: mergeMessages(history.items, this.state.messages), historyBefore: history.nextCursor, historyLoading: false });
      this.cacheWindow(cid);
    } catch (error) { if (this.current(epoch) && selection === this.selectionGeneration) this.set({ historyLoading: false, error: errorMessage(error) }); throw error; }
  }

  private async loadLocal(epoch: number) {
    if (!this.localReady) return;
    try {
      const hint = await readOfflineIdentity();
      if (!this.current(epoch)) return;
      if (hint?.user.id !== this.user.id) { this.expire(); return; }
      const entries = await readQueue(this.user.id);
      for (const entry of entries) if (entry.expiresAt <= Date.now() && entry.errorCode !== 'OUTBOX_EXPIRED') await changeQueuedMessage(this.user.id, entry.key, (item) => ({ ...item, state: 'failed', errorCode: 'OUTBOX_EXPIRED', error: '待发内容已超过7天，已停止自动发送。可以复制内容后重新编辑。' }));
      if (this.current(epoch)) this.set({ outbox: await readQueue(this.user.id) });
    } catch (error) { if (this.current(epoch)) this.set({ error: localError(error).message }); }
  }

  async queue(conversationId: string, text: string, options: { replyToMessageId?: string | null; mentionedUserIds?: string[]; mentionAll?: boolean; files?: LocalAttachment[] } = {}): Promise<void> {
    validateLocalFiles(options.files || []);
    validateMessageText(text, Boolean(options.files?.length));
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!this.running || !conversation?.canSend) throw new APIError(403, { code: conversation?.sendErrorCode || 'RESOURCE_UNAVAILABLE', message: conversation?.sendDisabledReason || '当前会话无法发送，请保留草稿。' });
    if (!this.localReady) throw localError();
    const epoch = this.generation; const clientMessageId = crypto.randomUUID();
    const payload: SendPayload = { clientMessageId, text, attachmentIds: [], replyToMessageId: options.replyToMessageId || null, mentionedUserIds: options.mentionedUserIds || [], accessKey: conversation.accessKey, actorContext: this.user.id };
    if (options.mentionAll) payload.mentionAll = true;
    const entry: QueuedMessage = { key: this.user.id + ':' + clientMessageId, userId: this.user.id, conversationId, conversationTitle: conversation.title, payload, createdAt: Date.now(), expiresAt: Date.now() + OUTBOX_AGE_MS, state: 'queued', attempts: 0, retryAt: 0, error: null, errorCode: null, files: options.files || [] };
    const saving = this.enqueueFlight.catch(() => undefined).then(async () => {
      if (!this.current(epoch)) throw new APIError(401, { code: 'AUTH_REQUIRED', message: '账号状态已改变，内容尚未排队。' });
      await addQueuedMessage(entry);
    });
    this.enqueueFlight = saving;
    await saving;
    if (this.current(epoch)) { await this.loadLocal(epoch); this.announce(); this.typing(false); void this.drain(); }
  }

  async retry(clientMessageId: string): Promise<void> {
    const key = this.user.id + ':' + clientMessageId;
    await changeQueuedMessage(this.user.id, key, (item) => {
      if (['STALE_ACCESS', 'IDEMPOTENCY_CONFLICT', 'OUTBOX_EXPIRED'].includes(item.errorCode || '')) throw new APIError(409, { code: item.errorCode!, message: '这条内容不能按原状态重试，请复制回编辑器并检查后重新发送。' });
      if (this.deliveryTasks.has(key)) throw new APIError(409, { code: 'UPLOAD_BUSY', message: '该条内容仍在处理中，请稍候或先停止。' });
      return { ...item, state: 'queued', retryAt: 0, error: null, errorCode: null, retryFiles: item.retryFiles || item.errorCode === 'FILE_QUARANTINED' };
    }, this.localIdentityRevision || undefined);
    await this.refresh(); await this.loadLocal(this.generation); this.announce(); void this.drain();
  }

  async cancel(clientMessageId: string): Promise<void> {
    const epoch = this.generation; const key = this.user.id + ':' + clientMessageId;
    this.deliveryTasks.get(key)?.abort();
    let files: LocalAttachment[] = [];
    await changeQueuedMessage(this.user.id, key, (entry) => { files = entry.files; return null; }, this.localIdentityRevision || undefined);
    await this.loadLocal(epoch); this.announce(); this.wakeDelivery?.();
    if (this.current(epoch) && navigator.onLine) {
      await Promise.allSettled(files.filter((file) => file.attachmentId).map((file) => this.request('/attachments/' + encodeURIComponent(file.attachmentId!) + '/cancel', { method: 'POST', body: {} })));
    }
  }

  private async send(entry: QueuedMessage, signal: AbortSignal): Promise<SendResult> {
    if (this.socket?.connected) {
      if (signal.aborted) throw signal.reason;
      const ack = await new Promise<{ ok: boolean; status?: number; error?: { code: string; message: string; retryAfterMs?: number }; data: SendResult }>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        this.socket!.timeout(10000).emitWithAck('message.send', { ...entry.payload, v: 1, conversationId: entry.conversationId, requestId: crypto.randomUUID() }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      if (!ack?.ok) throw new APIError(ack?.status || 503, ack?.error || { code: 'INVALID_RESPONSE', message: '消息结果尚未确认，请稍后重试。' });
      return ack.data;
    }
    return api<SendResult>('/api/v1/conversations/' + encodeURIComponent(entry.conversationId) + '/messages', { method: 'POST', body: entry.payload, signal });
  }

  private async drain(): Promise<void> {
    if (this.drainFlight) { this.wakeDelivery?.(); return; }
    if (!this.running || !this.initialized || !this.localReady || !navigator.onLine) return;
    const epoch = this.generation; const signal = this.controller.signal;
    const flight = withDeliveryLock(this.user.id, this.instanceId, signal, async (stillOwner) => {
      await this.verifyIdentity(epoch);
      if (!this.current(epoch) || !stillOwner()) return;
      const active = new Map<string, { file: boolean; controller: AbortController; done: Promise<void> }>();
      try {
        while (this.current(epoch) && stillOwner() && navigator.onLine) {
          const entries = await readQueue(this.user.id);
          if (!this.current(epoch) || !stillOwner()) break;
          // The first retained item, including failed/delayed items, owns its conversation order.
          const heads = new Map<string, QueuedMessage>();
          for (const entry of entries) if (!heads.has(entry.conversationId)) heads.set(entry.conversationId, entry);
          for (const entry of heads.values()) {
            if (active.has(entry.conversationId) || entry.state === 'failed' || entry.retryAt > Date.now()) continue;
            const file = entry.files.length > 0;
            const occupied = [...active.values()].filter((task) => task.file === file).length;
            if (occupied >= (file ? 2 : 1)) continue;
            const controller = new AbortController(); const abort = () => controller.abort();
            signal.addEventListener('abort', abort, { once: true });
            this.deliveryTasks.set(entry.key, controller);
            const done = this.deliverEntry(entry, epoch, controller.signal, stillOwner).finally(() => {
              signal.removeEventListener('abort', abort);
              if (this.deliveryTasks.get(entry.key) === controller) this.deliveryTasks.delete(entry.key);
              active.delete(entry.conversationId); this.wakeDelivery?.();
            });
            active.set(entry.conversationId, { file, controller, done });
          }
          if (!active.size) break;
          await new Promise<void>((resolve) => {
            const wake = () => { clearTimeout(timer); signal.removeEventListener('abort', wake); if (this.wakeDelivery === wake) this.wakeDelivery = null; resolve(); };
            const timer = setTimeout(wake, 1000);
            this.wakeDelivery = wake; signal.addEventListener('abort', wake, { once: true });
            if (signal.aborted) wake();
          });
        }
      } finally {
        for (const task of active.values()) task.controller.abort();
        await Promise.allSettled([...active.values()].map((task) => task.done));
      }
    }).catch((error) => { if (this.current(epoch)) this.connectionFailure(error, epoch); });
    this.drainFlight = flight;
    try { await flight; } finally { if (this.drainFlight === flight) this.drainFlight = null; }
  }

  private async deliverEntry(entry: QueuedMessage, epoch: number, signal: AbortSignal, stillOwner: () => boolean): Promise<void> {
    const revision = this.localIdentityRevision || undefined;
    const continuing = () => this.current(epoch) && stillOwner() && !signal.aborted;
    const ensure = () => { if (!continuing()) throw new DOMException('已停止本次发送', 'AbortError'); };
    const change = (update: (value: QueuedMessage) => QueuedMessage | null) => changeQueuedMessage(this.user.id, entry.key, (value) => { ensure(); return update(value); }, revision);
    try {
      ensure();
      const conversation = await api<Conversation>('/api/v1/conversations/' + encodeURIComponent(entry.conversationId), { signal });
      ensure();
      if (entry.expiresAt <= Date.now()) throw new APIError(409, { code: 'OUTBOX_EXPIRED', message: '待发内容已超过7天，请复制后重新编辑。' });
      if (!conversation.canSend) throw new APIError(403, { code: conversation.sendErrorCode || 'RESOURCE_UNAVAILABLE', message: conversation.sendDisabledReason || '当前无法发送。' });
      if (entry.payload.accessKey !== conversation.accessKey) throw new APIError(409, { code: 'STALE_ACCESS', message: '会话权限期已改变，这条待发内容已停止发送。请复制并检查后重新编辑。' });
      let retained = await change((item) => ({ ...item, state: 'sending', attempts: item.attempts + 1, error: null, errorCode: null }));
      if (!retained) return;
      await this.loadLocal(epoch); this.announce();
      const attachmentIds: string[] = [];
      for (const file of retained.files) {
        ensure();
        const record = await uploadLocalAttachment(file, { actorContext: this.user.id, purpose: 'message', conversationId: entry.conversationId, accessKey: entry.payload.accessKey }, {
          signal, retry: retained.retryFiles,
          onChange: async (updated) => {
            const kept = await change((item) => ({ ...item, files: item.files.map((value) => value.id === updated.id ? updated : value) }));
            if (!kept) throw new DOMException('待发内容已删除', 'AbortError');
            await this.loadLocal(epoch); this.announce();
          },
        });
        attachmentIds.push(record.id);
      }
      ensure();
      retained = await change((item) => ({ ...item, retryFiles: false, payload: { ...item.payload, attachmentIds } }));
      if (!retained) return;
      ensure();
      const contentRevision = this.contentRevision;
      const result = await this.send(retained, signal);
      ensure();
      await change(() => null);
      if (this.current(epoch)) {
        const last = this.state.messages.at(-1);
        const contiguous = !this.state.historyAfter || this.state.messages.some((item) => item.id === result.message.id) || !!last && BigInt(result.message.seq) === BigInt(last.seq) + 1n;
        if (contentRevision === this.contentRevision && this.state.selectedId === result.message.conversationId && contiguous) this.set({ messages: mergeMessages(this.state.messages, [result.message]) });
        await this.loadLocal(epoch); this.announce(); this.syncAgain = true; void this.synchronize();
      }
    } catch (error) {
      if (!continuing()) return;
      if (error instanceof APIError && ['AUTH_REQUIRED', 'SESSION_REVOKED', 'LOCAL_IDENTITY_CHANGED'].includes(error.code)) { this.expire(); return; }
      const code = error instanceof APIError ? error.code : 'NETWORK_ERROR';
      const terminal = permanentErrors.has(code) || (error instanceof APIError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status) && code !== 'UPLOAD_BUSY');
      const delay = Math.max(error instanceof APIError ? error.retryAfterMs || 0 : 0, Math.min(30000, 1000 * 2 ** Math.min(entry.attempts + 1, 5))) * (0.9 + Math.random() * 0.2);
      try {
        await change((item) => ({ ...item, state: terminal ? 'failed' : 'queued', retryAt: Date.now() + delay, errorCode: code, error: error instanceof APIError ? error.message : '发送结果尚未确认，将使用同一消息标识重试。' }));
        await this.loadLocal(epoch); this.announce();
      } catch (saveError) { if (continuing()) this.connectionFailure(saveError, epoch); }
    }
  }

  getDraft(conversationId: string): Promise<Draft | null> { return readDraft(this.user.id, conversationId); }
  saveDraft(conversationId: string, text: string, position: Pick<Draft, 'scrollTop' | 'anchorId' | 'files' | 'replyToMessageId' | 'mentionedUserIds' | 'mentionAll'> = {}): Promise<void> { return saveLocalDraft(this.user.id, conversationId, text, position); }
  async getLocalSummary(): Promise<{ pending: number; drafts: number }> { await this.enqueueFlight.catch(() => undefined); return localSummary(this.user.id); }
  async logout(choice: 'keep' | 'delete'): Promise<void> {
    const pendingSave = this.enqueueFlight; const pendingSend = this.drainFlight;
    this.stop();
    await pendingSave.catch(() => undefined); await pendingSend?.catch(() => undefined);
    try {
      await api('/api/v1/auth/logout', { method: 'POST', body: {} });
      if (choice === 'delete') await clearLocalUser(this.user.id);
      this.set({ ...initialState(), phase: 'expired' });
    } catch (error) { void this.start(); throw error; }
  }

  async finishAccountDeletion(choice: 'keep' | 'delete'): Promise<void> {
    const pendingSave = this.enqueueFlight; const pendingSend = this.drainFlight;
    this.stop();
    await pendingSave.catch(() => undefined); await pendingSend?.catch(() => undefined);
    if (choice === 'delete') await clearLocalUser(this.user.id);
    if (this.localIdentityRevision) await forgetIdentity(this.user.id, this.localIdentityRevision);
    this.set({ ...initialState(), phase: 'expired' });
  }

  async prepareAccountDeletion(): Promise<void> {
    const pendingSave = this.enqueueFlight; const pendingSend = this.drainFlight;
    this.stop();
    await pendingSave.catch(() => undefined); await pendingSend?.catch(() => undefined);
  }

  resumeAccountAfterDeletionFailure(): void { if (!this.running) void this.start(); }

  async read(conversationId: string, seq: string): Promise<void> {
    if (!this.running || !this.initialized || this.state.historyLoading || this.state.historyAfter || this.state.selectedId !== conversationId || document.visibilityState !== 'visible' || !document.hasFocus() || this.reading.has(conversationId)) return;
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation || BigInt(seq) <= BigInt(conversation.readSeq)) return;
    this.reading.add(conversationId); const epoch = this.generation;
    try { await this.request('/conversations/' + encodeURIComponent(conversationId) + '/read', { method: 'POST', body: { readSeq: seq } }); const current = await this.request<Conversation>('/conversations/' + encodeURIComponent(conversationId)); if (this.current(epoch)) this.upsertConversation(current); }
    finally { this.reading.delete(conversationId); }
  }

  private async loadNotifications(epoch: number, more: boolean) {
    const cursor = more ? this.state.nextNotifications : null;
    if (more && !cursor) return;
    const page = await this.request<Page<NotificationItem> & { unreadCount: number }>('/notifications?limit=100' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
    if (this.current(epoch)) this.set({ notifications: more ? mergeItems(this.state.notifications, page.items) : page.items, notificationCount: page.unreadCount, nextNotifications: page.nextCursor });
  }
  async loadMoreNotifications(): Promise<void> { await this.loadNotifications(this.generation, true); }
  async loadMoreConversations(): Promise<void> { const cursor = this.state.nextConversations; if (!cursor) return; const epoch = this.generation; const page = await this.request<Page<Conversation>>('/conversations?limit=100&after=' + encodeURIComponent(cursor)); if (this.current(epoch)) { for (const item of page.items) this.upsertConversation(item); this.set({ nextConversations: page.nextCursor }); } }
  async loadMoreContacts(): Promise<void> { const cursor = this.state.nextContacts; if (!cursor) return; const epoch = this.generation; const page = await this.request<Page<Contact>>('/friends?limit=100&after=' + encodeURIComponent(cursor)); if (this.current(epoch)) this.set({ contacts: mergeItems(this.state.contacts, page.items), nextContacts: page.nextCursor }); }
  async loadMoreRequests(): Promise<void> { const cursor = this.state.nextRequests; if (!cursor) return; const epoch = this.generation; const page = await this.request<Page<FriendRequest>>('/friend-requests?limit=100&after=' + encodeURIComponent(cursor)); if (this.current(epoch)) this.set({ requests: mergeItems(this.state.requests, page.items), nextRequests: page.nextCursor }); }
}
