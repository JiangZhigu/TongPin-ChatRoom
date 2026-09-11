// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, onAuthExpired, setCsrfToken } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setCsrfToken(''); });
const failure = (code: string) => ({ ok: false, status: 401, json: async () => ({ error: { code } }) });

describe('API session recovery and bounded requests', () => {
  it('expires identity only for a session failure, keeping reauthentication failures retryable', async () => {
    setCsrfToken('current');
    const expired = vi.fn(); const unsubscribe = onAuthExpired(expired);
    const fetchMock = vi.fn().mockResolvedValueOnce(failure('REAUTH_FAILED')).mockResolvedValueOnce(failure('SECOND_FACTOR_REQUIRED')).mockResolvedValueOnce(failure('AUTH_REQUIRED'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(api('/reauth')).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
      await expect(api('/login')).rejects.toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
      expect(expired).not.toHaveBeenCalled();
      await expect(api('/profile')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(expired).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('ignores a delayed failure belonging to the previous identity', async () => {
    setCsrfToken('old');
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const expired = vi.fn(); const unsubscribe = onAuthExpired(expired);
    try {
      const request = api('/old-session');
      setCsrfToken('new'); finish(failure('AUTH_REQUIRED'));
      await expect(request).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(expired).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('bounds response body reads and labels timed-out writes as unconfirmed', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options) => { signal = options.signal; return Promise.resolve({ ok: true, json: () => new Promise(() => undefined) }); }));
    const request = api('/profile', { method: 'PATCH', body: { nickname: 'test' } });
    const assertion = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining('结果尚未确认') });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('respects explicit cancellation without reporting identity expiry', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const expired = vi.fn(); const unsubscribe = onAuthExpired(expired);
    try {
      const request = api('/slow', { signal: controller.signal });
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(expired).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
