import { coreRoute } from './core';
import { groupRoute } from './groups';
import { taskRoute } from './tasks';
import { adminRoute } from './admin';
import { DemoError, offline } from './state';

export const calls: { method: string; path: string; status: number; at: number }[] = [];
const nativeFetch = window.fetch.bind(window);
export async function localRequest(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://tongpin.demo');
  if (url.protocol === 'blob:' || url.protocol === 'data:') return nativeFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  const path = decodeURI(url.pathname).replace(/^\/api\/v1/, '');
  if (init.signal?.aborted) throw new DOMException('演示请求已取消', 'AbortError');
  if (offline) throw new TypeError('Demo is offline');
  const headers = new Headers(init.headers); let body: Record<string, any> = {};
  if (typeof init.body === 'string') body = JSON.parse(init.body || '{}');
  else if (init.body instanceof Blob) body = { __blob: init.body };
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(done, 65); function stop() { clearTimeout(timer); reject(new DOMException('演示请求已取消', 'AbortError')); } function done() { init.signal?.removeEventListener('abort', stop); resolve(); } init.signal?.addEventListener('abort', stop, { once: true }); });
  let status = 200; let payload: unknown;
  try {
    let data = await adminRoute(path, method, body, url.searchParams);
    if (data === undefined) data = taskRoute(path, method, body, url.searchParams, headers);
    if (data === undefined) data = groupRoute(path, method, body, url.searchParams, headers);
    if (data === undefined) data = await coreRoute(path, method, body, url.searchParams, headers);
    if (data === undefined) throw new DemoError(501, 'DEMO_ROUTE_NOT_FOUND', '此演示操作尚未识别：' + method + ' ' + path);
    payload = data instanceof Blob ? data : { data };
  } catch (cause) { if (!(cause instanceof DemoError)) throw cause; status = cause.status; payload = { error: { code: cause.code, message: cause.message, ...cause.extras } }; }
  calls.push({ method, path, status, at: Date.now() }); if (calls.length > 1000) calls.shift();
  return payload instanceof Blob ? new Response(payload, { status }) : new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', 'X-Demo-Transport': 'browser-local' } });
}
window.fetch = localRequest;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !offline });
Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });
// A missing adapter must fail locally instead of contacting an actual server.
window.WebSocket = class { constructor() { throw new Error('Demo blocks network WebSocket connections.'); } } as unknown as typeof WebSocket;
window.EventSource = class { constructor() { throw new Error('Demo blocks network EventSource connections.'); } } as unknown as typeof EventSource;
Object.defineProperty(window, '__TONGPIN_DEMO__', { value: { calls, backendRequests: 0, transport: 'browser-local', version: 1 } });
