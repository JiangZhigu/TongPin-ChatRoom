// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { addQueuedMessage, changeQueuedMessage, claimLease, clearLocalUser, forgetIdentity, openLocalDatabase, OUTBOX_BLOB_LIMIT, readOfflineIdentity, readOfflineSnapshot, readQueue, releaseLease, rememberIdentity, removeOfflineItem, saveLocalDraft, withDeliveryLock } from './outbox';
import type { QueuedMessage } from './chat-types';

const one = { id: 'u_one', username: 'actor_one', nickname: '一' };
const two = { id: 'u_two', username: 'actor_two', nickname: '二' };
function entry(userId = one.id): QueuedMessage {
  const clientMessageId = crypto.randomUUID();
  return { key: userId + ':' + clientMessageId, userId, conversationId: 'dm_one', conversationTitle: '测试', payload: { clientMessageId, accessKey: 'epoch-one', actorContext: userId, text: '草稿', attachmentIds: [], mentionedUserIds: [], replyToMessageId: null }, createdAt: Date.now(), expiresAt: Date.now() + 100000, state: 'queued', attempts: 0, retryAt: 0, error: null, errorCode: null, files: [] };
}
beforeEach(async () => {
  const eventTarget = new EventTarget();
  vi.stubGlobal('window', eventTarget); vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('navigator', {});
  const db = await openLocalDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbox', 'drafts', 'leases', 'meta'], 'readwrite');
    for (const name of ['outbox', 'drafts', 'leases', 'meta']) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  await rememberIdentity(one, null);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('per-account IndexedDB transaction and delivery boundary (in-memory IDB model)', () => {
  it('retains committed Blob bytes and rejects a rolled-back write instead of claiming queued', async () => {
    const first = entry(); first.files = [{ id: 'local-file', blob: new Blob(['preserved 中文 bytes']), name: 'test.txt', mime: 'text/plain' }];
    await addQueuedMessage(first);
    expect(await (await readQueue(one.id))[0].files[0].blob.text()).toBe('preserved 中文 bytes');
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === 'outbox') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(addQueuedMessage(entry())).rejects.toMatchObject({ code: 'LOCAL_STORAGE_UNAVAILABLE' });
    expect((await readQueue(one.id)).map((row) => row.key)).toEqual([first.key]);
  });

  it('enforces the last queue slot under concurrent transactions and its byte ceiling', async () => {
    for (let number = 0; number < 99; number++) await addQueuedMessage(entry());
    const race = await Promise.allSettled([addQueuedMessage(entry()), addQueuedMessage(entry())]);
    expect(race.map((row) => row.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await readQueue(one.id)).length).toBe(100);
    await clearLocalUser(one.id);
    const tooLarge = entry(); tooLarge.files = [{ id: 'large', blob: new Blob([new Uint8Array(OUTBOX_BLOB_LIMIT + 1)]), name: 'large.bin', mime: 'application/octet-stream' }];
    await expect(addQueuedMessage(tooLarge)).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(await readQueue(one.id)).toEqual([]);
  });

  it('does not reveal or mutate an old identity after another tab switches account', async () => {
    const first = entry(); await addQueuedMessage(first); await saveLocalDraft(one.id, 'dm_one', 'old draft');
    const previous = (await readOfflineIdentity())!;
    await rememberIdentity(two, previous);
    expect((await readOfflineSnapshot())?.outbox).toEqual([]);
    await expect(readOfflineSnapshot(previous.revision)).rejects.toMatchObject({ code: 'LOCAL_IDENTITY_CHANGED' });
    await expect(removeOfflineItem(previous.revision, 'outbox', first.key)).rejects.toMatchObject({ code: 'LOCAL_IDENTITY_CHANGED' });
    await expect(addQueuedMessage(entry())).rejects.toMatchObject({ code: 'LOCAL_IDENTITY_CHANGED' });
    await expect(saveLocalDraft(one.id, 'dm_one', 'stale-tab edit')).rejects.toMatchObject({ code: 'LOCAL_IDENTITY_CHANGED' });
    await expect(rememberIdentity(one, previous)).rejects.toMatchObject({ code: 'LOCAL_IDENTITY_CHANGED' });
    expect((await readQueue(one.id))[0].key).toBe(first.key);
    await forgetIdentity(one.id); expect((await readOfflineIdentity())?.user.id).toBe(two.id);
    await forgetIdentity(two.id); expect(await readOfflineSnapshot()).toBeNull();
  });

  it('pages every nonempty draft and restricts deletion to the current account', async () => {
    for (let number = 0; number < 103; number++) await saveLocalDraft(one.id, 'dm_' + String(number).padStart(3, '0'), 'draft ' + number);
    await saveLocalDraft(one.id, 'dm_empty', '');
    const first = (await readOfflineSnapshot())!;
    expect(first.drafts).toHaveLength(100); expect(first.nextDraftCursor).toBeTruthy();
    const second = (await readOfflineSnapshot(first.identity.revision, first.nextDraftCursor!))!;
    expect(second.drafts).toHaveLength(3); expect(second.nextDraftCursor).toBeNull();
    expect(new Set([...first.drafts, ...second.drafts].map((draft) => draft.key)).size).toBe(103);
    await removeOfflineItem(first.identity.revision, 'draft', first.drafts[0].key);
    expect((await readOfflineSnapshot())?.drafts.some((draft) => draft.key === first.drafts[0].key)).toBe(false);
  });

  it('serializes lease ownership, preserves the winner on stale release and recovers expiry', async () => {
    const outcomes = await Promise.all([claimLease(one.id, 'tab-a', 100), claimLease(one.id, 'tab-b', 100)]);
    expect(outcomes).toEqual([true, false]);
    await releaseLease(one.id, 'tab-b'); expect(await claimLease(one.id, 'tab-b', 200)).toBe(false);
    expect(await claimLease(one.id, 'tab-b', 30101)).toBe(true);
    await releaseLease(one.id, 'tab-a'); expect(await claimLease(one.id, 'tab-a', 30102)).toBe(false);
    await releaseLease(one.id, 'tab-b'); expect(await claimLease(one.id, 'tab-a', 30102)).toBe(true);
  });

  it('keeps one fallback sender active and releases its lease after cancellation', async () => {
    let finish!: () => void; let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const controller = new AbortController();
    const first = withDeliveryLock(one.id, 'first', controller.signal, async (owned) => { expect(owned()).toBe(true); entered(); await new Promise<void>((resolve) => { finish = resolve; }); expect(owned()).toBe(false); });
    await active; const second = vi.fn();
    await withDeliveryLock(one.id, 'second', new AbortController().signal, second); expect(second).not.toHaveBeenCalled();
    controller.abort(); finish(); await first;
    expect(await claimLease(one.id, 'second')).toBe(true);
  });

  it('cannot alter another account entry through a forged key or ownership transition', async () => {
    const first = entry(); await addQueuedMessage(first);
    expect(await changeQueuedMessage(two.id, first.key, () => null)).toBeNull();
    await expect(changeQueuedMessage(one.id, first.key, (row) => ({ ...row, userId: two.id }))).rejects.toMatchObject({ code: 'LOCAL_STORAGE_UNAVAILABLE' });
    expect((await readQueue(one.id))[0].key).toBe(first.key);
  });
});
