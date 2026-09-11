let csrfToken = '';

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

export function setCsrfToken(value: string) { csrfToken = value; }

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method || 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new APIError(response.status, payload?.error || { message: '服务暂不可用，请重试。' });
  if (!payload || !Object.hasOwn(payload, 'data')) throw new APIError(502, { code: 'INVALID_RESPONSE', message: '服务响应无效，请重新连接。' });
  if (typeof payload.data?.csrfToken === 'string') setCsrfToken(payload.data.csrfToken);
  return payload.data as T;
}

export type User = { id: string; username: string; nickname: string; bio: string; siteRole: 'user' | 'super_admin'; status: string; createdAt: number; preferences: { invisible: boolean; readReceipts: boolean; doNotDisturb: boolean; [key: string]: unknown } };
export type Bootstrap = { accountsEnabled: boolean; registrationMode: 'closed' | 'invite-only' | 'open'; csrfToken: string; user: User | null; terms: { version: string; operatorName: string; operatorContact: string; development: boolean; text: string } };
export function fetchBootstrap() { return api<Bootstrap>('/api/v1/auth/bootstrap'); }
