// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import type { UserView } from './auth-types';
import { setCsrfToken } from './lib/api';
import { openLocalDatabase, readDraft, readOfflineIdentity, readOfflineSnapshot, rememberIdentity, saveLocalDraft } from './lib/outbox';

// No account, bootstrap, outbox or ChatClient module is mocked. Only HTTP and
// unavailable cross-window transport are isolated. IDB uses its transaction model.
const actor: UserView = { id: 'lifecycle-account-a', username: 'lifecycle_a', nickname: '账号甲', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const privateDraft = '账号甲保留的私人草稿，不得在匿名离线页展示';
const conversationId = 'lifecycle-private-conversation';
const bootstrap = (user: UserView | null) => ({ accountsEnabled: true, registrationMode: 'closed', user, csrfToken: user ? 'lifecycle-authenticated-csrf' : 'lifecycle-anonymous-csrf', terms: { version: 'lifecycle-test', operatorName: 'test', operatorContact: 'test', development: true, text: '测试条款' } });
const reply = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) });
const denied = () => Promise.resolve({ ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN', message: '当前账号没有管理权限' } }) });

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  setCsrfToken(''); window.history.replaceState({}, '', '/');
  const database = await openLocalDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['outbox', 'drafts', 'leases', 'meta'], 'readwrite');
    for (const name of ['outbox', 'drafts', 'leases', 'meta']) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  await rememberIdentity(actor, null);
  await saveLocalDraft(actor.id, conversationId, privateDraft);
  // Establish the precondition through the real storage API before mounting App.
  expect((await readOfflineIdentity())?.user.id).toBe(actor.id);
  expect((await readOfflineSnapshot())?.drafts[0].text).toBe(privateDraft);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(''); window.history.replaceState({}, '', '/'); });

async function assertRetainedButNotVisibleOffline() {
  expect(await readOfflineIdentity()).toBeNull();
  expect((await readDraft(actor.id, conversationId))?.text).toBe(privateDraft);
  expect(await readOfflineSnapshot()).toBeNull();
  // A fresh mount simulates reopening after connectivity is lost; do not clear
  // or reseed identity/content between logout and this recovery entry.
  cleanup(); window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  render(<StrictMode><App /></StrictMode>);
  await screen.findByRole('heading', { name: '暂时无法连接服务' });
  fireEvent.click(screen.getByRole('button', { name: '查看本机待发与草稿' }));
  expect(await screen.findByRole('heading', { name: '没有可展示的本机内容' })).toBeInTheDocument();
  expect(screen.queryByText(privateDraft)).not.toBeInTheDocument();
  expect(screen.queryByText(actor.nickname, { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '复制草稿' })).not.toBeInTheDocument();
  expect((await readDraft(actor.id, conversationId))?.text).toBe(privateDraft);
}

describe('M34-FIX account lifecycle with actual App and IndexedDB', () => {
  it('clears the active marker after an ordinary user exits the admin permission-error page, retaining private drafts', async () => {
    window.history.replaceState({}, '', '/admin');
    let signedOut = false;
    let bootstrapCalls = 0;
    const fetchMock = vi.fn((url: string, options: RequestInit = {}) => {
      if (url === '/api/v1/auth/bootstrap') { bootstrapCalls++; return reply(bootstrap(signedOut ? null : actor)); }
      if (url === '/api/v1/admin/auth') return denied();
      if (url === '/api/v1/auth/logout') {
        expect(options.method).toBe('POST');
        expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('lifecycle-authenticated-csrf');
        signedOut = true; return reply({});
      }
      if (url === '/api/v1/auth/captcha') return reply({ captchaId: 'lifecycle-captcha', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 });
      throw new Error(`Unexpected lifecycle HTTP request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StrictMode><App /></StrictMode>);
    await screen.findByRole('heading', { name: '无法进入管理后台' });
    expect(screen.getByRole('alert')).toHaveTextContent('当前账号没有管理权限');
    expect(bootstrapCalls).toBe(1);
    expect((await readOfflineIdentity())?.user.id).toBe(actor.id);
    fireEvent.click(screen.getByRole('button', { name: '退出当前账号' }));
    await screen.findByRole('heading', { name: '登录管理后台' });
    expect(bootstrapCalls).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/auth/logout')).toHaveLength(1);
    await assertRetainedButNotVisibleOffline();
  });

  it('clears an old active marker on the first successful anonymous bootstrap after a closed-page session expires', async () => {
    let bootstrapCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/auth/bootstrap') { bootstrapCalls++; return reply(bootstrap(null)); }
      if (url === '/api/v1/auth/captcha') return reply({ captchaId: 'lifecycle-captcha', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 });
      throw new Error(`Unexpected lifecycle HTTP request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(screen.getByLabelText('用户名')).toBeInTheDocument());
    expect(bootstrapCalls).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/auth/logout')).toBe(false);
    await assertRetainedButNotVisibleOffline();
  });
});
