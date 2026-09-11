// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { api, fetchBootstrap, onAuthExpired, setCsrfToken } from './api';
import { openLocalDatabase, readDraft, readOfflineIdentity, readOfflineSnapshot, rememberIdentity, saveLocalDraft } from './outbox';

const one = { id: 'api_one', username: 'api_one', nickname: '甲' };
const two = { id: 'api_two', username: 'api_two', nickname: '乙' };
function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ data }) }; }
function failure(code: string) { return { ok: false, status: 401, json: async () => ({ error: { code } }) }; }
function delayedFetch() {
  let finish!: (value: unknown) => void;
  const mock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  vi.stubGlobal('fetch', mock);
  return { mock, finish: (value: unknown) => finish(value) };
}
beforeEach(async () => {
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('BroadcastChannel', undefined); setCsrfToken('api-A');
  const db = await openLocalDatabase();
  await new Promise<void>((resolve) => { const tx = db.transaction(['meta', 'drafts', 'outbox', 'leases'], 'readwrite'); for (const name of ['meta', 'drafts', 'outbox', 'leases']) tx.objectStore(name).clear(); tx.oncomplete = () => resolve(); });
  await rememberIdentity(one, null); await saveLocalDraft(one.id, 'dm_draft', 'retain private draft');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setCsrfToken(''); });

describe('shared API identity cleanup with actual IndexedDB transaction model', () => {
  it('forgets the captured identity on successful anonymous bootstrap without deleting content', async () => {
    const deferred = delayedFetch(); const first = fetchBootstrap(); const duplicate = fetchBootstrap(); expect(first).toBe(duplicate);
    await vi.waitFor(() => expect(deferred.mock).toHaveBeenCalledTimes(1));
    deferred.finish(response({ user: null, csrfToken: 'anonymous' })); await first;
    expect(await readOfflineSnapshot()).toBeNull(); expect((await readDraft(one.id, 'dm_draft'))?.text).toBe('retain private draft');
  });

  it.each(['B', 'ABA'])('preserves a newer %s identity after an old anonymous bootstrap arrives', async (change) => {
    const deferred = delayedFetch(); const first = fetchBootstrap(); await vi.waitFor(() => expect(deferred.mock).toHaveBeenCalledTimes(1));
    await rememberIdentity(two, await readOfflineIdentity());
    if (change === 'ABA') await rememberIdentity(one, await readOfflineIdentity());
    const current = (await readOfflineIdentity())!;
    deferred.finish(response({ user: null, csrfToken: 'anonymous' })); await first;
    expect((await readOfflineIdentity())?.revision).toBe(current.revision);
  });

  it('clears the active marker after any successful logout entry point', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ loggedOut: true })));
    await api('/api/v1/auth/logout', { method: 'POST', body: {} });
    expect(await readOfflineIdentity()).toBeNull(); expect((await readDraft(one.id, 'dm_draft'))?.text).toBe('retain private draft');
  });

  it('clears a revoked session but keeps wrong reauthentication and network failures recoverable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(failure('REAUTH_FAILED')).mockResolvedValueOnce(failure('AUTH_REQUIRED')));
    const expired = vi.fn(); const unsubscribe = onAuthExpired(expired);
    try {
      await expect(fetchBootstrap()).rejects.toMatchObject({ code: 'NETWORK_ERROR' }); expect(await readOfflineIdentity()).not.toBeNull();
      await expect(api('/api/v1/auth/reauth', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'REAUTH_FAILED' }); expect(expired).not.toHaveBeenCalled(); expect(await readOfflineIdentity()).not.toBeNull();
      await expect(api('/api/v1/auth/me')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(expired).toHaveBeenCalledTimes(1);
      expect(await readOfflineSnapshot()).toBeNull(); expect((await readDraft(one.id, 'dm_draft'))?.text).toBe('retain private draft');
    } finally { unsubscribe(); }
  });

  it('does not clear a renewed A marker for a delayed explicit session revocation', async () => {
    const deferred = delayedFetch(); const request = api('/api/v1/auth/me');
    const rejected = expect(request).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    await vi.waitFor(() => expect(deferred.mock).toHaveBeenCalledTimes(1));
    await rememberIdentity(two, await readOfflineIdentity()); await rememberIdentity(one, await readOfflineIdentity()); const current = (await readOfflineIdentity())!;
    deferred.finish(failure('SESSION_REVOKED')); await rejected;
    expect((await readOfflineIdentity())?.revision).toBe(current.revision);
  });
});
