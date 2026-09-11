let csrfToken = '';
let identityGeneration = 0;
const expiredListeners = new Set<() => void>();
const REQUEST_TIMEOUT_MS = 15000;

export class APIError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors?: Record<string, string>;
  readonly retryAfterMs?: number;
  constructor(status: number, error: { code?: string; message?: string; fieldErrors?: Record<string, string>; retryAfterMs?: number }) {
    super(error.message || '请求未能完成，请稍后重试。');
    this.name = 'APIError'; this.status = status; this.code = error.code || 'NETWORK_ERROR';
    this.fieldErrors = error.fieldErrors; this.retryAfterMs = error.retryAfterMs;
  }
}

export function setCsrfToken(value: string) {
  if (csrfToken !== value) identityGeneration += 1;
  csrfToken = value;
}

export function onAuthExpired(listener: () => void): () => void {
  expiredListeners.add(listener);
  return () => { expiredListeners.delete(listener); };
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method || 'GET';
  const generation = identityGeneration;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(options.signal?.reason); reject(options.signal?.reason || new DOMException('请求已取消', 'AbortError')); };
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => {
      reject(new APIError(0, { code: 'REQUEST_TIMEOUT', message: ['GET', 'HEAD'].includes(method) ? '请求超时，请检查网络后重试。' : '请求超时，结果尚未确认。请先刷新确认结果，避免重复提交。' }));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([interrupted, (async () => {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        const error = new APIError(response.status, payload?.error || { message: '服务暂不可用，请重试。' });
        if (['AUTH_REQUIRED', 'SESSION_REVOKED'].includes(error.code) && generation === identityGeneration) {
          csrfToken = '';
          identityGeneration += 1;
          for (const listener of expiredListeners) listener();
        }
        throw error;
      }
      if (!payload || !Object.hasOwn(payload, 'data')) throw new APIError(502, { code: 'INVALID_RESPONSE', message: '服务响应无效，请重新连接。' });
      if (typeof payload.data?.csrfToken === 'string' && generation === identityGeneration) setCsrfToken(payload.data.csrfToken);
      return payload.data as T;
    })()]);
  } finally {
    clearTimeout(timeout);
    if (cancel) options.signal?.removeEventListener('abort', cancel);
  }
}

export type User = { id: string; username: string; nickname: string; bio: string; siteRole: 'user' | 'super_admin'; status: string; createdAt: number; preferences: { invisible: boolean; readReceipts: boolean; doNotDisturb: boolean; [key: string]: unknown } };
export type Bootstrap = { accountsEnabled: boolean; registrationMode: 'closed' | 'invite-only' | 'open'; csrfToken: string; user: User | null; terms: { version: string; operatorName: string; operatorContact: string; development: boolean; text: string } };
let bootstrapFlight: { generation: number; promise: Promise<Bootstrap> } | undefined;
export function fetchBootstrap(): Promise<Bootstrap> {
  // StrictMode and simultaneous consumers must share one anonymous Set-Cookie response.
  if (bootstrapFlight?.generation === identityGeneration) return bootstrapFlight.promise;
  // A new identity waits for the previous request to settle so a delayed Set-Cookie
  // cannot arrive after the new identity's bootstrap response.
  const previous = bootstrapFlight;
  const request = () => api<Bootstrap>('/api/v1/auth/bootstrap');
  const flight = { generation: identityGeneration, promise: previous ? previous.promise.catch(() => undefined).then(request) : request() };
  bootstrapFlight = flight;
  void flight.promise.finally(() => { if (bootstrapFlight === flight) bootstrapFlight = undefined; }).catch(() => undefined);
  return flight.promise;
}
