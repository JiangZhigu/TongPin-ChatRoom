import { APIError } from './api';
import type { Draft, LocalAttachment, QueuedMessage, UserSummary } from './chat-types';

const DATABASE = 'tongpin-local-v1';
const VERSION = 1;
export const OUTBOX_LIMIT = 100;
export const OUTBOX_BLOB_LIMIT = 50 * 1024 * 1024;
export const OUTBOX_AGE_MS = 7 * 86400000;
let databasePromise: Promise<IDBDatabase> | undefined;

export function localError(error?: unknown): APIError {
  if (error instanceof APIError) return error;
  return new APIError(0, { code: 'LOCAL_STORAGE_UNAVAILABLE', message: error instanceof DOMException && error.name === 'QuotaExceededError' ? '本机存储空间不足，内容尚未保存。请复制草稿或删除不需要的本机内容。' : '无法保存本机数据，内容尚未排队。请保留或复制草稿，并检查浏览器存储权限。' });
}

export function openLocalDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(localError()); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, VERSION); } catch (error) { reject(localError(error)); return; }
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(localError()); }, 5000);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['outbox', 'drafts']) {
        const store = db.createObjectStore(name, { keyPath: 'key' });
        store.createIndex('userId', 'userId');
      }
      db.createObjectStore('leases', { keyPath: 'userId' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onerror = () => { clearTimeout(timer); reject(localError(request.error)); };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (expired) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
  });
  databasePromise = promise;
  void promise.catch(() => { if (databasePromise === promise) databasePromise = undefined; });
  return promise;
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

async function transaction<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openLocalDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
    catch (error) { reject(localError(error)); return; }
    let result: T; let failure: unknown;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(localError(failure || tx.error));
    tx.onerror = () => { failure ||= tx.error; };
    // Only IDB request promises are awaited in work, keeping the transaction active.
    Promise.resolve().then(() => work(tx)).then((value) => { result = value; }).catch((error) => {
      failure = error;
      try { tx.abort(); } catch { reject(localError(error)); }
    });
  });
}

export type OfflineIdentity = { key: 'active-user'; user: UserSummary; revision: string; savedAt: number };

export type OfflineLocalSnapshot = { identity: OfflineIdentity; outbox: QueuedMessage[]; drafts: Draft[]; nextDraftCursor: string | null };

function identityChanged(): APIError { return new APIError(0, { code: 'LOCAL_IDENTITY_CHANGED', message: '本机账号状态已改变，请关闭旧内容并重新连接。' }); }

function announceLocal(kind: 'identity' | 'content', userId?: string) {
  window.dispatchEvent(new CustomEvent('tongpin:local-change', { detail: kind }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('tongpin-state-v1');
    channel.postMessage({ type: kind === 'identity' ? 'identity.changed' : 'local.changed', userId });
    channel.close();
  }
}

/** Local recovery is deliberately separate from authenticated chat state. */
export function readOfflineSnapshot(expectedRevision?: string, afterDraftKey?: string): Promise<OfflineLocalSnapshot | null> {
  return transaction(['meta', 'outbox', 'drafts'], 'readonly', async (tx) => {
    const identity: OfflineIdentity | undefined = await requested(tx.objectStore('meta').get('active-user'));
    if (expectedRevision && identity?.revision !== expectedRevision) throw identityChanged();
    if (!identity) return null;
    const outbox: QueuedMessage[] = await requested(tx.objectStore('outbox').index('userId').getAll(IDBKeyRange.only(identity.user.id), OUTBOX_LIMIT + 1));
    const drafts = await new Promise<Draft[]>((resolve, reject) => {
      const values: Draft[] = [];
      const cursor = tx.objectStore('drafts').index('userId').openCursor(IDBKeyRange.only(identity.user.id));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row || values.length > 100) { resolve(values); return; }
        const draft: Draft = row.value;
        if ((!afterDraftKey || draft.key > afterDraftKey) && (draft.text.trim() || draft.files?.length || draft.replyToMessageId || draft.mentionedUserIds?.length || draft.mentionAll)) values.push(draft);
        row.continue();
      };
    });
    return { identity, outbox: outbox.filter((row) => row.userId === identity.user.id).sort((a, b) => a.createdAt - b.createdAt), drafts: drafts.slice(0, 100), nextDraftCursor: drafts.length > 100 ? drafts[99].key : null };
  });
}

export async function removeOfflineItem(expectedRevision: string, kind: 'outbox' | 'draft', key: string): Promise<void> {
  const userId = await transaction(['meta', kind === 'draft' ? 'drafts' : 'outbox'], 'readwrite', async (tx) => {
    const identity: OfflineIdentity | undefined = await requested(tx.objectStore('meta').get('active-user'));
    if (!identity || identity.revision !== expectedRevision) throw identityChanged();
    const store = tx.objectStore(kind === 'draft' ? 'drafts' : 'outbox');
    const row: Draft | QueuedMessage | undefined = await requested(store.get(key));
    if (row && row.userId !== identity.user.id) throw identityChanged();
    if (row) await requested(store.delete(key));
    return identity.user.id;
  });
  announceLocal('content', userId);
}

export function subscribeOfflineChanges(listener: (kind: 'identity' | 'content' | 'check') => void): () => void {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tongpin-state-v1') : null;
  if (channel) channel.onmessage = (event) => listener(event.data?.type === 'identity.changed' ? 'identity' : 'content');
  const changed = (event: Event) => listener((event as CustomEvent).detail === 'identity' ? 'identity' : 'content');
  const check = () => listener('check');
  const timer = setInterval(check, 2000);
  window.addEventListener('tongpin:local-change', changed); window.addEventListener('focus', check);
  return () => { clearInterval(timer); channel?.close(); window.removeEventListener('tongpin:local-change', changed); window.removeEventListener('focus', check); };
}

export function readOfflineIdentity(): Promise<OfflineIdentity | null> {
  return transaction(['meta'], 'readonly', async (tx) => (await requested(tx.objectStore('meta').get('active-user'))) || null);
}

export async function rememberIdentity(user: UserSummary, previous: OfflineIdentity | null): Promise<OfflineIdentity> {
  const identity = await transaction(['meta'], 'readwrite', async (tx) => {
    const store = tx.objectStore('meta');
    const current: OfflineIdentity | undefined = await requested(store.get('active-user'));
    if (current?.revision !== previous?.revision && current?.user.id !== user.id) throw new APIError(0, { code: 'LOCAL_IDENTITY_CHANGED', message: '另一标签页已切换账号，请重新连接。' });
    const next: OfflineIdentity = { key: 'active-user', user: { id: user.id, username: user.username, nickname: user.nickname }, revision: current?.user.id === user.id ? current.revision : crypto.randomUUID(), savedAt: Date.now() };
    await requested(store.put(next));
    return next;
  });
  if (previous?.user.id !== user.id) announceLocal('identity', user.id);
  return identity;
}

export async function forgetIdentity(userId: string, expectedRevision?: string): Promise<void> {
  const forgotten = await transaction(['meta'], 'readwrite', async (tx) => {
    const store = tx.objectStore('meta');
    const current: OfflineIdentity | undefined = await requested(store.get('active-user'));
    if (current?.user.id !== userId || (expectedRevision !== undefined && current.revision !== expectedRevision)) return false;
    await requested(store.delete('active-user'));
    return true;
  });
  if (forgotten) announceLocal('identity');
}

export function readQueue(userId: string): Promise<QueuedMessage[]> {
  return transaction(['outbox'], 'readonly', async (tx) => {
    const rows: QueuedMessage[] = await requested(tx.objectStore('outbox').index('userId').getAll(IDBKeyRange.only(userId), OUTBOX_LIMIT + 1));
    return rows.filter((row) => row.userId === userId).sort((one, two) => one.createdAt - two.createdAt || one.key.localeCompare(two.key));
  });
}

export function addQueuedMessage(entry: QueuedMessage): Promise<void> {
  return transaction(['outbox', 'drafts', 'meta'], 'readwrite', async (tx) => {
    const identity: OfflineIdentity | undefined = await requested(tx.objectStore('meta').get('active-user'));
    if (identity?.user.id !== entry.userId) throw new APIError(0, { code: 'LOCAL_IDENTITY_CHANGED', message: '本机账号状态已改变，内容尚未保存。请重新连接。' });
    const store = tx.objectStore('outbox');
    const pending: QueuedMessage[] = await requested(store.index('userId').getAll(IDBKeyRange.only(entry.userId), OUTBOX_LIMIT + 1));
    if (pending.length >= OUTBOX_LIMIT) throw new APIError(0, { code: 'STORAGE_FULL', message: '本机待发队列已达到100条，请先处理或删除部分待发内容。' });
    const drafts = tx.objectStore('drafts');
    const draftRows: Draft[] = await requested(drafts.index('userId').getAll(IDBKeyRange.only(entry.userId)));
    const transferring = new Set(entry.files.map((file) => file.id));
    if (pending.some((row) => row.files.some((file) => transferring.has(file.id)))) throw new APIError(0, { code: 'FILE_ALREADY_QUEUED', message: '这些附件已经排队，请先确认原待发项。' });
    const adjusted = draftRows.map((draft) => draft.conversationId === entry.conversationId ? { ...draft, files: (draft.files || []).filter((file) => !transferring.has(file.id)) } : draft);
    const bytes = localBlobBytes([...pending, entry, ...adjusted]);
    if (bytes > OUTBOX_BLOB_LIMIT) throw new APIError(0, { code: 'STORAGE_FULL', message: '离线附件总量不能超过50 MiB，请删除部分附件后再试。' });
    await requested(store.add(entry));
    const originalDraft = adjusted.find((draft) => draft.conversationId === entry.conversationId);
    if (originalDraft && entry.files.length) await requested(drafts.put(originalDraft));
  });
}

function localBlobBytes(rows: { files?: LocalAttachment[] }[]): number {
  return rows.reduce((total, row) => total + (row.files || []).reduce((sum, file) => sum + file.blob.size, 0), 0);
}

export function changeQueuedMessage(userId: string, key: string, change: (value: QueuedMessage) => QueuedMessage | null, expectedRevision?: string): Promise<QueuedMessage | null> {
  return transaction(['outbox', 'meta'], 'readwrite', async (tx) => {
    if (expectedRevision !== undefined) {
      const identity: OfflineIdentity | undefined = await requested(tx.objectStore('meta').get('active-user'));
      if (identity?.user.id !== userId || identity.revision !== expectedRevision) throw identityChanged();
    }
    const store = tx.objectStore('outbox');
    const original: QueuedMessage | undefined = await requested(store.get(key));
    if (!original || original.userId !== userId) return null;
    const updated = change(original);
    if (updated) {
      if (updated.key !== key || updated.userId !== userId) throw new Error('Invalid local ownership transition');
      await requested(store.put(updated));
    } else await requested(store.delete(key));
    return updated;
  });
}

export function readDraft(userId: string, conversationId: string): Promise<Draft | null> {
  return transaction(['drafts'], 'readonly', async (tx) => {
    const value: Draft | undefined = await requested(tx.objectStore('drafts').get(userId + ':' + conversationId));
    return value?.userId === userId ? value : null;
  });
}

export function saveLocalDraft(userId: string, conversationId: string, text: string, position: Pick<Draft, 'scrollTop' | 'anchorId' | 'files' | 'replyToMessageId' | 'mentionedUserIds' | 'mentionAll'> = {}): Promise<void> {
  return transaction(['drafts', 'outbox', 'meta'], 'readwrite', async (tx) => {
    const identity: OfflineIdentity | undefined = await requested(tx.objectStore('meta').get('active-user'));
    if (identity?.user.id !== userId) throw new APIError(0, { code: 'LOCAL_IDENTITY_CHANGED', message: '账号已切换，未将此草稿写入另一个账号。' });
    const store = tx.objectStore('drafts'); const key = userId + ':' + conversationId;
    const current: Draft | undefined = await requested(store.get(key));
    const next = { ...current, ...position, key, userId, conversationId, text, updatedAt: Date.now() } satisfies Draft;
    const drafts: Draft[] = await requested(store.index('userId').getAll(IDBKeyRange.only(userId)));
    const queued: QueuedMessage[] = await requested(tx.objectStore('outbox').index('userId').getAll(IDBKeyRange.only(userId), OUTBOX_LIMIT + 1));
    if (localBlobBytes([...drafts.filter((draft) => draft.key !== key), next, ...queued]) > OUTBOX_BLOB_LIMIT) throw new APIError(0, { code: 'STORAGE_FULL', message: '本机草稿与待发附件合计超过50 MiB，请移除部分附件。' });
    await requested(store.put(next));
  });
}

export function localSummary(userId: string): Promise<{ pending: number; drafts: number }> {
  return transaction(['outbox', 'drafts'], 'readonly', async (tx) => {
    const pending = await requested(tx.objectStore('outbox').index('userId').count(IDBKeyRange.only(userId)));
    const rows: Draft[] = await requested(tx.objectStore('drafts').index('userId').getAll(IDBKeyRange.only(userId)));
    return { pending, drafts: rows.filter((row) => row.text.trim() || row.files?.length || row.replyToMessageId || row.mentionedUserIds?.length || row.mentionAll).length };
  });
}

export function clearLocalUser(userId: string): Promise<void> {
  return transaction(['outbox', 'drafts', 'leases'], 'readwrite', async (tx) => {
    for (const name of ['outbox', 'drafts']) {
      const store = tx.objectStore(name);
      const keys = await requested(store.index('userId').getAllKeys(IDBKeyRange.only(userId)));
      for (const key of keys) await requested(store.delete(key));
    }
    await requested(tx.objectStore('leases').delete(userId));
  });
}

type Lease = { userId: string; owner: string; until: number };
export function claimLease(userId: string, owner: string, now = Date.now()): Promise<boolean> {
  return transaction(['leases'], 'readwrite', async (tx) => {
    const store = tx.objectStore('leases');
    const lease: Lease | undefined = await requested(store.get(userId));
    if (lease && lease.owner !== owner && lease.until > now) return false;
    await requested(store.put({ userId, owner, until: now + 30000 } satisfies Lease));
    return true;
  });
}

export function releaseLease(userId: string, owner: string): Promise<void> {
  return transaction(['leases'], 'readwrite', async (tx) => {
    const store = tx.objectStore('leases');
    const lease: Lease | undefined = await requested(store.get(userId));
    if (lease?.owner === owner) await requested(store.delete(userId));
  });
}

export async function withDeliveryLock(userId: string, owner: string, signal: AbortSignal, work: (stillOwner: () => boolean) => Promise<void>): Promise<void> {
  if (signal.aborted) return;
  if (navigator.locks?.request) {
    try {
      await navigator.locks.request('tongpin-delivery:' + userId, { ifAvailable: true }, async (lock) => {
        if (lock && !signal.aborted) await work(() => !signal.aborted);
      });
      return;
    } catch (error) {
      // Security-disabled Web Locks uses the same IndexedDB lease fallback.
      if (!(error instanceof DOMException && ['SecurityError', 'NotSupportedError'].includes(error.name))) throw error;
    }
  }
  if (!(await claimLease(userId, owner))) return;
  if (signal.aborted) { await releaseLease(userId, owner); return; }
  let owned = true;
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || signal.aborted) return;
    renewing = true;
    void claimLease(userId, owner).then((result) => { owned = result; }).catch(() => { owned = false; }).finally(() => { renewing = false; });
  }, 5000);
  try { await work(() => owned && !signal.aborted); }
  finally { owned = false; clearInterval(timer); await releaseLease(userId, owner); }
}
