// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APIError } from './api';
import type { ChatClient } from './chat-client';
import { TaskClient } from './tasks-client';
import type { Task, TaskCreate } from './tasks-types';
import { clearTaskDrafts } from './task-drafts';

const mocked = vi.hoisted(() => ({ api: vi.fn(), expiry: (() => {}) as () => void }));
vi.mock('./api', async () => { const actual = await vi.importActual<typeof import('./api')>('./api'); return { ...actual, api: mocked.api, onAuthExpired: (callback: () => void) => { mocked.expiry = callback; return () => {}; } }; });
let taskEvent: (event: { type: string; entityRef: string; conversationId: string | null }) => void;
let connection: () => void;
let phase: 'offline' | 'online' = 'offline';
const clients: TaskClient[] = [];
function client() {
  const chat = { getSnapshot: () => ({ phase }), subscribe: (callback: () => void) => { connection = callback; return () => {}; }, subscribeTaskEvents: (callback: typeof taskEvent) => { taskEvent = callback; return () => {}; } } as unknown as ChatClient;
  const current = new TaskClient('a', chat); clients.push(current); current.start(); return current;
}
function task(version = 1): Task { return { id: 't1', viewerId: 'a', groupId: 'g1', version, etag: '"v' + version + '"', title: 'private title', status: 'todo' } as Task; }
const payload: TaskCreate = { scope: 'personal', title: '草稿', description: 'secret', priority: 'normal', dueOn: null, dueTimezone: 'Asia/Shanghai', assigneeId: 'a' };
beforeEach(async () => { mocked.api.mockReset(); phase = 'offline'; await clearTaskDrafts('a'); });
afterEach(() => { clients.splice(0).forEach((current) => current.stop()); vi.restoreAllMocks(); });

it('bounds long-session cache bookkeeping without losing the invalidation of a still-cached private body', async () => {
  const current = client();
  for (let index = 0; index < 700; index++) { mocked.api.mockResolvedValueOnce({ ...task(), id: 'many-' + index }); await current.get('many-' + index); }
  expect(Object.keys(current.getSnapshot().entities)).toHaveLength(500);
  expect(Object.keys((current as unknown as { appliedSerial: Record<string, number> }).appliedSerial)).toHaveLength(500);
  taskEvent({ type: 'task.updated', entityRef: 'many-699', conversationId: 'g1' });
  for (let index = 0; index < 1200; index++) taskEvent({ type: 'task.deleted', entityRef: 'unknown-' + index, conversationId: 'g1' });
  expect(current.getSnapshot().invalid['many-699']).toBe(true);
  expect(Object.keys(current.getSnapshot().invalid)).toHaveLength(501);
  mocked.api.mockRejectedValueOnce(new APIError(404, { code: 'TASK_UNAVAILABLE' }));
  await expect(current.get('many-699')).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' });
  expect(current.getSnapshot().entities['many-699']).toBeUndefined();
  expect(Object.keys((current as unknown as { appliedSerial: Record<string, number> }).appliedSerial)).toHaveLength(499);
});

it('uses the current actor header and exact stored ETag/key, keeping one central current entity', async () => {
  const current = client(); mocked.api.mockResolvedValueOnce(task());
  const first = await current.get('t1');
  mocked.api.mockResolvedValueOnce({ task: task(2), duplicate: false });
  const latest = await current.patch(first, { status: 'doing' }, 'stable-key');
  expect(mocked.api.mock.calls[1]).toEqual(['/api/v1/tasks/t1', expect.objectContaining({ actorContext: 'a', ifMatch: '"v1"', idempotencyKey: 'stable-key', method: 'PATCH' })]);
  expect(current.getSnapshot().entities.t1).toBe(latest);
  mocked.api.mockResolvedValueOnce(task(1));
  expect((await current.get('t1')).version).toBe(2);
});

it('discards a delayed card body after membership revocation and a delayed response after identity expiry', async () => {
  const current = client(); mocked.api.mockResolvedValueOnce(task()); await current.get('t1');
  let resolve!: (value: unknown) => void;
  mocked.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const card = current.card('m1'); taskEvent({ type: 'access.revoked', entityRef: 'g1', conversationId: 'g1' });
  expect(current.getSnapshot().entities.t1).toBeUndefined();
  resolve({ kind: 'live', task: task() });
  await expect(card).rejects.toMatchObject({ code: 'TASK_VIEW_CHANGED' });
  mocked.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const late = current.get('t1'); mocked.expiry(); resolve(task());
  await expect(late).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  expect(current.getSnapshot().entities).toEqual({});
});

it('revalidates a mutation response that raced with a revoke instead of restoring stale private content', async () => {
  const current = client(); let resolve!: (value: unknown) => void;
  mocked.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const pending = current.patch(task(), { title: 'new' }, 'same-command');
  taskEvent({ type: 'access.revoked', entityRef: 'g1', conversationId: 'g1' });
  mocked.api.mockRejectedValueOnce(new APIError(404, { code: 'TASK_UNAVAILABLE' }));
  resolve({ task: task(2), duplicate: false });
  await expect(pending).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' });
  expect(current.getSnapshot().entities).toEqual({});
});

it('keeps offline drafts unsent on reconnection and requires a fresh explicit review', async () => {
  const current = client(); const draft = await current.saveDraft({ taskId: null, kind: 'create', payload, baseEtag: null });
  expect(mocked.api).not.toHaveBeenCalled();
  phase = 'online'; connection();
  expect(mocked.api).not.toHaveBeenCalled();
  mocked.api.mockResolvedValueOnce({ actorId: 'a', enabled: true, enhanced: true });
  const review = await current.reviewDraft(draft);
  expect(review.latest).toBeNull(); expect(mocked.api).toHaveBeenCalledTimes(1);
  expect(mocked.api.mock.calls[0][0]).toBe('/api/v1/tasks/meta');
  expect(await current.drafts()).toHaveLength(1);
});

it('preserves a conflict as a visible failed command without retrying or replacing the cached task', async () => {
  const current = client(); mocked.api.mockResolvedValueOnce(task()); await current.get('t1');
  mocked.api.mockRejectedValueOnce(new APIError(412, { code: 'VERSION_CONFLICT' }));
  await expect(current.patch(task(), { title: 'local edited' }, 'one-key')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(mocked.api).toHaveBeenCalledTimes(2);
  expect(current.getSnapshot().entities.t1.title).toBe('private title');
});

it('does not replace a newer authorized representation with a late read of the same task version', async () => {
  const current = client(); let resolve!: (value: unknown) => void;
  mocked.api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const older = current.get('t1');
  mocked.api.mockResolvedValueOnce({ ...task(), etag: '"new-authority"', capabilities: { edit: false } });
  await current.get('t1');
  resolve({ ...task(), capabilities: { edit: true } });
  expect((await older).etag).toBe('"new-authority"');
  expect(current.getSnapshot().entities.t1.capabilities.edit).toBe(false);
});
