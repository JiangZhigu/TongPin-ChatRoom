// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearTaskDrafts, readTaskDrafts, removeTaskDraft, saveTaskDraft } from './task-drafts';
import type { TaskCreate } from './tasks-types';

const payload: TaskCreate = { scope: 'personal', title: '本机待确认', description: 'secret', priority: 'normal', dueOn: null, dueTimezone: 'Asia/Shanghai', assigneeId: 'a' };
beforeEach(async () => { await clearTaskDrafts('a'); await clearTaskDrafts('b'); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('persists isolated drafts across connections, preserves TTL, and deletes only the selected account', async () => {
  const a = await saveTaskDraft('a', { taskId: null, kind: 'create', payload, baseEtag: null });
  const b = await saveTaskDraft('b', { taskId: null, kind: 'create', payload: { ...payload, assigneeId: 'b', title: 'B only' }, baseEtag: null });
  expect((await readTaskDrafts('a')).map((row) => row.id)).toEqual([a.id]);
  expect(a.expiresAt - a.updatedAt).toBe(7 * 86400000);
  await removeTaskDraft('b', a.id); expect(await readTaskDrafts('a')).toHaveLength(1);
  await clearTaskDrafts('a'); expect(await readTaskDrafts('a')).toEqual([]);
  expect((await readTaskDrafts('b'))[0].id).toBe(b.id);
});

it('reports rollback instead of saved success and retains the prior committed draft', async () => {
  const a = await saveTaskDraft('a', { taskId: null, kind: 'create', payload, baseEtag: null });
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) { const request = original.call(this, value, key); request.addEventListener('success', () => this.transaction.abort()); return request; });
  await expect(saveTaskDraft('a', { ...a, payload: { ...payload, title: 'not committed' } })).rejects.toMatchObject({ code: 'LOCAL_STORAGE_UNAVAILABLE' });
  expect((await readTaskDrafts('a'))[0].payload.title).toBe(payload.title);
});

it('rejects a delayed save after its identity is stopped or local data is cleared', async () => {
  let current = true;
  const pending = saveTaskDraft('a', { taskId: null, kind: 'create', payload, baseEtag: null }, () => current);
  current = false;
  await expect(pending).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  expect(await readTaskDrafts('a')).toEqual([]);
});

it('keeps expired content available for review without silently dropping it and enforces a bounded count', async () => {
  const expired = await saveTaskDraft('a', { taskId: null, kind: 'create', payload, baseEtag: null });
  vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt + 1);
  expect((await readTaskDrafts('a'))[0].expiresAt).toBeLessThan(Date.now());
  for (let i = 1; i < 100; i++) await saveTaskDraft('a', { taskId: null, kind: 'create', payload, baseEtag: null });
  await expect(saveTaskDraft('a', { taskId: null, kind: 'create', payload, baseEtag: null })).rejects.toMatchObject({ code: 'TASK_DRAFT_LIMIT' });
  expect(await readTaskDrafts('a')).toHaveLength(100);
});
