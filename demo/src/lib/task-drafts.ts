import { APIError } from './api';
import { openLocalDatabase } from './outbox';
import type { TaskDraft } from './tasks-types';

const AGE = 7 * 86400000;
const unavailable = () => new APIError(0, { code: 'LOCAL_STORAGE_UNAVAILABLE', message: '无法保存本机任务草稿，请复制内容后再离开。' });
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, setResult: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    let result: T; let failure: Error | null = null;
    const tx = db.transaction('taskDrafts', mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    const timer = setTimeout(() => { failure = unavailable(); try { tx.abort(); } catch { reject(failure); } }, 5000);
    tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(failure || unavailable()); };
    try { run(tx.objectStore('taskDrafts'), (value) => { result = value; }, (error) => { failure = error; tx.abort(); }); }
    catch (error) { failure = error instanceof Error ? error : unavailable(); tx.abort(); }
  });
}
export function readTaskDrafts(userId: string): Promise<TaskDraft[]> {
  return transaction('readonly', (store, set) => { const req = store.index('userId').getAll(userId); req.onsuccess = () => set((req.result as TaskDraft[]).sort((a, b) => b.updatedAt - a.updatedAt)); });
}
export function saveTaskDraft(userId: string, value: Pick<TaskDraft, 'taskId' | 'kind' | 'payload' | 'baseEtag'> & { id?: string }, isCurrent?: () => boolean): Promise<TaskDraft> {
  return transaction('readwrite', (store, set, fail) => {
    const req = store.index('userId').getAll(userId);
    req.onsuccess = () => {
      if (isCurrent && !isCurrent()) { fail(new APIError(409, { code: 'IDENTITY_CHANGED', message: '账号状态已改变，旧草稿未保存。' })); return; }
      const rows = req.result as TaskDraft[]; const old = rows.find((item) => item.id === value.id); const stamp = Date.now();
      if (!old && rows.length >= 100) { fail(new APIError(409, { code: 'TASK_DRAFT_LIMIT', message: '本机最多保存100份任务草稿，请先整理。' })); return; }
      if (new TextEncoder().encode(JSON.stringify(value.payload)).byteLength > 32768) { fail(new APIError(422, { code: 'TASK_DRAFT_LIMIT', message: '草稿内容过大，请缩短内容。' })); return; }
      const draft: TaskDraft = { ...value, id: old?.id || crypto.randomUUID(), userId, createdAt: old?.createdAt || stamp, updatedAt: stamp, expiresAt: stamp + AGE };
      store.put(draft); set(draft);
    };
  });
}
export function removeTaskDraft(userId: string, id: string): Promise<void> {
  return transaction('readwrite', (store, set) => { const req = store.get(id); req.onsuccess = () => { if (req.result?.userId === userId) store.delete(id); set(undefined); }; });
}
export function clearTaskDrafts(userId: string): Promise<void> {
  return transaction('readwrite', (store, set) => { const req = store.index('userId').openKeyCursor(userId); req.onsuccess = () => { const cursor = req.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } else set(undefined); }; });
}
