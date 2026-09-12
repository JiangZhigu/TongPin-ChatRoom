let csrfToken = '';
let identityGeneration = 0;
const expiredListeners = new Set<() => void>();
const REQUEST_TIMEOUT_MS = 15000;

// Resolve the store lazily: the store uses APIError but authentication owns its
// lifecycle. Offline recovery reports its own storage availability errors.
async function captureOfflineState() {
  if (typeof indexedDB === 'undefined') return null;
  const storage = await import('./outbox');
  try { return { storage, identity: await storage.readOfflineIdentity() }; }
  catch { return null; }
}

async function forgetCapturedState(captured: Awaited<ReturnType<typeof captureOfflineState>>) {
  if (captured?.identity) await captured.storage.forgetIdentity(captured.identity.user.id, captured.identity.revision);
}

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

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; inviteToken?: string; responseType?: 'blob'; timeoutMs?: number; ifMatch?: string; idempotencyKey?: string; actorContext?: string; upload?: { id: string; blob: Blob } } = {}): Promise<T> {
  const method = options.method || 'GET';
  const generation = identityGeneration;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.actorContext) headers['X-Actor-Context'] = options.actorContext;
  if (options.inviteToken) headers['X-Group-Invite'] = options.inviteToken;
  if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.upload) {
    if (path !== '/api/v1/attachments' || method !== 'POST' || options.body !== undefined) throw new APIError(0, { code: 'INVALID_UPLOAD', message: '上传请求格式无效。' });
    headers['Content-Type'] = 'application/octet-stream'; headers['X-Upload-Id'] = options.upload.id;
  }
  const controller = new AbortController();
  const binaryTimeout = options.responseType === 'blob' && typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? Math.max(REQUEST_TIMEOUT_MS, Math.min(600000, options.timeoutMs)) : REQUEST_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(options.signal?.reason); reject(options.signal?.reason || new DOMException('请求已取消', 'AbortError')); };
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => {
      reject(new APIError(0, { code: 'REQUEST_TIMEOUT', message: options.responseType === 'blob' ? '文件读取超时，请检查连接后重试。' : ['GET', 'HEAD'].includes(method) ? '请求超时，请检查网络后重试。' : '请求超时，结果尚未确认。请先刷新确认结果，避免重复提交。' }));
      controller.abort();
    }, options.upload ? 120000 : binaryTimeout);
  });
  try {
    return await Promise.race([interrupted, (async () => {
      const localState = path.startsWith('/api/v1/') && !['/api/v1/auth/bootstrap', '/api/v1/auth/captcha', '/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/recover'].includes(path) ? await captureOfflineState() : null;
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, body: options.upload?.blob ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: controller.signal });
      if (response.ok && options.responseType === 'blob') {
        const blob = await response.blob();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (generation !== identityGeneration) throw new APIError(409, { code: 'IDENTITY_CHANGED', message: '账号已改变，已丢弃本次文件读取结果。' });
        return blob as T;
      }
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        const error = new APIError(response.status, payload?.error || { message: '服务暂不可用，请重试。' });
        if (['AUTH_REQUIRED', 'SESSION_REVOKED'].includes(error.code) && generation === identityGeneration) {
          try { await forgetCapturedState(localState); } finally {
            if (generation === identityGeneration) {
              csrfToken = '';
              identityGeneration += 1;
              for (const listener of expiredListeners) listener();
            }
          }
        }
        throw error;
      }
      if (!payload || !Object.hasOwn(payload, 'data')) throw new APIError(502, { code: 'INVALID_RESPONSE', message: '服务响应无效，请重新连接。' });
      if (path === '/api/v1/auth/logout') await forgetCapturedState(localState);
      if (typeof payload.data?.csrfToken === 'string' && generation === identityGeneration) setCsrfToken(payload.data.csrfToken);
      return payload.data as T;
    })()]);
  } catch (error) {
    if (error instanceof TypeError && !controller.signal.aborted) {
      throw new APIError(0, { code: 'NETWORK_ERROR', message: ['GET', 'HEAD'].includes(method) ? '连接暂时中断，请检查网络后重新连接。' : '连接暂时中断，操作结果尚未确认。请重新连接并确认结果。' });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (cancel) options.signal?.removeEventListener('abort', cancel);
  }
}

export function apiBlob(path: string, options: { body: unknown; signal?: AbortSignal; timeoutMs?: number }): Promise<Blob> {
  return api<Blob>(path, { ...options, method: 'POST', responseType: 'blob' });
}

export type User = { id: string; username: string; nickname: string; bio: string; avatarUrl?: string | null; siteRole: 'user' | 'super_admin'; status: string; createdAt: number; preferences: { invisible: boolean; readReceipts: boolean; doNotDisturb: boolean; [key: string]: unknown }; restrictions?: { uploadDisabled: boolean; groupCreationDisabled: boolean; reason: string; mutedUntil: number | null; muteReason: string } };
export type Bootstrap = { accountsEnabled: boolean; registrationMode: 'closed' | 'invite-only' | 'open'; csrfToken: string; user: User | null; terms: { version: string; operatorName: string; operatorContact: string; development: boolean; text: string } };
let bootstrapFlight: { generation: number; promise: Promise<Bootstrap> } | undefined;
export function fetchBootstrap(): Promise<Bootstrap> {
  // StrictMode and simultaneous consumers must share one anonymous Set-Cookie response.
  if (bootstrapFlight?.generation === identityGeneration) return bootstrapFlight.promise;
  // A new identity waits for the previous request to settle so a delayed Set-Cookie
  // cannot arrive after the new identity's bootstrap response.
  const previous = bootstrapFlight;
  const request = async () => {
    const expectedGeneration = identityGeneration;
    const captured = typeof indexedDB === 'undefined' ? null : await captureOfflineState();
    if (expectedGeneration !== identityGeneration) throw new APIError(409, { code: 'IDENTITY_CHANGED', message: '账号状态已改变，请重新连接。' });
    const data = await api<Bootstrap>('/api/v1/auth/bootstrap');
    // API's identity guard prevents an older response from installing its CSRF.
    // Compare the captured store revision as well: another tab may have signed in.
    if (data.user === null && csrfToken === data.csrfToken) await forgetCapturedState(captured);
    return data;
  };
  const flight = { generation: identityGeneration, promise: previous ? previous.promise.catch(() => undefined).then(request) : request() };
  bootstrapFlight = flight;
  void flight.promise.finally(() => { if (bootstrapFlight === flight) bootstrapFlight = undefined; }).catch(() => undefined);
  return flight.promise;
}
