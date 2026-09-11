// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiBlob, fetchBootstrap, onAuthExpired, setCsrfToken } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setCsrfToken(''); });
const failure = (code: string) => ({ ok: false, status: 401, json: async () => ({ error: { code } }) });

describe('API session recovery and bounded requests', () => {
  it('translates browser network errors without claiming an unconfirmed write failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const expired = vi.fn(); const unsubscribe = onAuthExpired(expired);
    try {
      await expect(api('/offline')).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: '连接暂时中断，请检查网络后重新连接。' });
      await expect(api('/offline-write', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('操作结果尚未确认') });
      expect(expired).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
  it('shares an anonymous bootstrap request and sends its corresponding CSRF', async () => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    const first = fetchBootstrap(); const second = fetchBootstrap();
    expect(first).toBe(second); expect(fetchMock).toHaveBeenCalledTimes(1);
    finish({ ok: true, json: async () => ({ data: { csrfToken: 'only-flow' } }) });
    await first; await api('/login', { method: 'POST', body: {} });
    expect(fetchMock.mock.calls[1][1].headers['X-CSRF-Token']).toBe('only-flow');
  });

  it('starts a new bootstrap after identity changes and ignores the old response token', async () => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ data: { csrfToken: 'new-identity' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const old = fetchBootstrap();
    setCsrfToken('new-identity');
    const current = fetchBootstrap();
    expect(current).not.toBe(old);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish({ ok: true, json: async () => ({ data: { csrfToken: 'old-identity' } }) }); await old; await current;
    await api('/current', { method: 'POST', body: {} });
    expect(fetchMock.mock.calls[2][1].headers['X-CSRF-Token']).toBe('new-identity');
  });

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

describe('audited binary reads', () => {
  it('uses the current session and CSRF with a POST reason and returns the actual bytes', async () => {
    setCsrfToken('binary-session');
    const blob = new Blob(['bounded-test-file']);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiBlob('/binary-read', { body: { reason: '核验附件' } })).resolves.toBe(blob);
    expect(fetchMock).toHaveBeenCalledWith('/binary-read', expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ reason: '核验附件' }), headers: expect.objectContaining({ 'X-CSRF-Token': 'binary-session' }) }));
  });
  it('discards an old identity response even if its binary body completes later', async () => {
    setCsrfToken('old-binary');
    let finish!: (blob: Blob) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: () => new Promise<Blob>((resolve) => { finish = resolve; }) }));
    const pending = apiBlob('/binary-old', { body: { reason: '核验附件' } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    setCsrfToken('new-binary'); finish(new Blob(['old data']));
    await expect(pending).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });
  it('handles authentication errors through the same identity invalidation path', async () => {
    const expired = vi.fn(); const unsubscribe = onAuthExpired(expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failure('AUTH_REQUIRED')));
    try {
      await expect(apiBlob('/binary-denied', { body: { reason: '核验附件' } })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(expired).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });
});
