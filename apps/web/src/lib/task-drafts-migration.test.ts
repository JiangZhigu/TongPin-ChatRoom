// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';

it('upgrades an existing V1 chat database without losing messages, then clears task and chat drafts atomically', async () => {
  const stamp = Date.now();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tongpin-local-v1', 1);
    request.onupgradeneeded = () => {
      for (const name of ['outbox', 'drafts']) { const store = request.result.createObjectStore(name, { keyPath: 'key' }); store.createIndex('userId', 'userId'); }
      request.result.createObjectStore('leases', { keyPath: 'userId' }); request.result.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const user = { id: 'migration-a', username: 'migration_a', nickname: '原账号' };
  await new Promise<void>((resolve) => {
    const tx = db.transaction(['meta', 'drafts', 'outbox'], 'readwrite');
    tx.objectStore('meta').put({ key: 'active-user', user, revision: 'old-revision', savedAt: stamp });
    tx.objectStore('drafts').put({ key: 'draft-old', userId: user.id, conversationId: 'dm', text: '升级前聊天草稿', updatedAt: stamp });
    tx.objectStore('outbox').put({ key: 'queue-old', userId: user.id, conversationId: 'dm', createdAt: stamp, payload: { text: '升级前待发' } });
    tx.oncomplete = () => resolve();
  }); db.close();
  const local = await import('./outbox'); const tasks = await import('./task-drafts');
  const upgraded = await local.openLocalDatabase(); expect(upgraded.version).toBe(2);
  let snapshot = await local.readOfflineSnapshot('old-revision');
  expect(snapshot?.drafts[0].text).toBe('升级前聊天草稿'); expect(snapshot?.outbox[0].payload.text).toBe('升级前待发');
  expect(snapshot?.taskDrafts).toEqual([]);
  await tasks.saveTaskDraft(user.id, { taskId: null, kind: 'create', baseEtag: null, payload: { scope: 'personal', title: '待办草稿', description: '', priority: 'normal', dueOn: null, dueTimezone: 'Asia/Shanghai', assigneeId: user.id } });
  const original = IDBObjectStore.prototype.delete;
  const failure = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) { if (this.name === 'taskDrafts') throw new DOMException('isolated abort', 'AbortError'); return original.call(this, key); });
  await expect(local.clearLocalUser(user.id)).rejects.toMatchObject({ code: 'LOCAL_STORAGE_UNAVAILABLE' }); failure.mockRestore();
  snapshot = await local.readOfflineSnapshot('old-revision');
  expect(snapshot?.outbox).toHaveLength(1); expect(snapshot?.drafts).toHaveLength(1); expect(snapshot?.taskDrafts).toHaveLength(1);
  await expect(local.removeOfflineItem('wrong-revision', 'taskDraft', snapshot!.taskDrafts[0].id)).rejects.toMatchObject({ code: 'LOCAL_IDENTITY_CHANGED' });
  await local.clearLocalUser(user.id);
  snapshot = await local.readOfflineSnapshot('old-revision');
  expect(snapshot?.outbox).toEqual([]); expect(snapshot?.drafts).toEqual([]); expect(snapshot?.taskDrafts).toEqual([]);
});
