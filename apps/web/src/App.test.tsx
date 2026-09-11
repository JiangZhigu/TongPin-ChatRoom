// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { ConversationList } from './components/ConversationList';
import { Composer } from './components/Composer';
import { api, setCsrfToken } from './lib/api';
import type { UserView } from './auth-types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setCsrfToken(''); window.history.replaceState({}, '', '/'); });
function healthyResponse(url: string) {
  const data = url === '/health/ready' ? { status: 'ready', version: '0.1.0', features: { accounts: false } } : { accountsEnabled: false, registrationMode: 'closed' };
  return Promise.resolve({ ok: true, json: async () => ({ data, requestId: 'test-only' }) });
}

describe('real service entry', () => {
  it('shows disabled account capability after checking both endpoints, without credentials or fake chats', async () => {
    const fetchMock = vi.fn(healthyResponse);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('基础服务已连接')).toBeInTheDocument();
    expect(screen.getByText('账号功能尚未启用，暂时无法登录或注册。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('消息记录')).not.toBeInTheDocument();
  });
  it('retries a failed service check and replaces the error only after a successful response', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('暂时无法连接服务')).toBeInTheDocument();
    fetchMock.mockImplementation(healthyResponse);
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(await screen.findByText('基础服务已连接')).toBeInTheDocument();
    expect(screen.queryByText('暂时无法连接服务')).not.toBeInTheDocument();
  });
  it('rejects a malformed successful response instead of presenting the service as ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
    render(<App />);
    expect(await screen.findByText('暂时无法连接服务')).toBeInTheDocument();
  });
  it('keeps the admin route separate and requires a real authenticated session', async () => {
    window.history.replaceState({}, '', '/admin');
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => ({ data: url.endsWith('/bootstrap') ? { accountsEnabled: true, user: null, csrfToken: 'test', registrationMode: 'closed', terms: { version: 'test', text: 'test' } } : { captchaId: 'test', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 } }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回同频' })).toHaveAttribute('href', '/');
    expect(screen.getByLabelText('动态码或第二因素恢复码')).toBeInTheDocument();
    expect(screen.queryByText('管理身份已确认')).not.toBeInTheDocument();
  });
});

const expiryUser: UserView = { id: 'expiry-test-user', username: 'expiry_test', nickname: '失效测试用户', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const bootstrapData = (user: UserView | null) => ({ accountsEnabled: true, registrationMode: 'closed', csrfToken: user ? 'authenticated-test-token' : 'anonymous-test-token', user, terms: { version: 'test', operatorName: 'test', operatorContact: 'test', development: true, text: '测试条款' } });
const dataReply = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) });
const failureReply = (code = 'AUTH_REQUIRED') => Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { code, message: code === 'REAUTH_FAILED' ? '当前密码不正确' : '登录会话已失效' } }) });
const captchaReply = () => dataReply({ captchaId: 'expiry-captcha', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; }

describe('M2 auth expiry', () => {
  it.each(['read', 'write', 'logout'] as const)('clears settings identity after AUTH_REQUIRED on %s', async (operation) => {
    let bootstrapCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
      if (url.endsWith('/bootstrap')) return dataReply(bootstrapData(bootstrapCalls++ === 0 ? expiryUser : null));
      if (url.endsWith('/captcha')) return captchaReply();
      if ((operation === 'read' && url.endsWith('/sessions')) || (operation === 'write' && options.method === 'PATCH') || (operation === 'logout' && url.endsWith('/logout'))) return failureReply();
      return dataReply({ items: [] });
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    if (operation === 'write') {
      fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '未提交的资料' } });
      fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
    } else if (operation === 'logout') fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '账号设置' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('未提交的资料')).not.toBeInTheDocument();
    expect(screen.queryByText(expiryUser.nickname)).not.toBeInTheDocument();
    expect(bootstrapCalls).toBe(2);
  });
  it.each(['verification', 'logout'] as const)('returns to administrator login after expired admin %s', async (operation) => {
    window.history.replaceState({}, '', '/admin'); let bootstrapCalls = 0;
    const adminUser = { ...expiryUser, siteRole: 'super_admin' as const };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/bootstrap')) return dataReply(bootstrapData(bootstrapCalls++ === 0 ? adminUser : null));
      if (url.endsWith('/captcha')) return captchaReply();
      if (url.endsWith('/admin/auth')) return operation === 'verification' ? failureReply('SESSION_REVOKED') : dataReply({ user: adminUser, secondFactorRequired: true });
      return failureReply();
    }));
    render(<App />);
    if (operation === 'logout') { await screen.findByRole('heading', { name: '管理身份已确认' }); fireEvent.click(screen.getByRole('button', { name: '退出当前账号' })); }
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeInTheDocument();
    expect(screen.getByLabelText('动态码或第二因素恢复码')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '管理身份已确认' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin'); expect(bootstrapCalls).toBe(2);
  });
  it('keeps a failed reauthentication in the settings form with its error', async () => {
    // jsdom substitutes only modal visibility, not native focus behavior.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    let bootstrapCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/bootstrap')) { bootstrapCalls++; return dataReply(bootstrapData(expiryUser)); }
      if (url.endsWith('/reauth')) return failureReply('REAUTH_FAILED');
      return dataReply({ items: [] });
    }));
    render(<App />); fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '验证身份并重新生成' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'wrong in-memory password' } });
    fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('当前密码')).toHaveValue('wrong in-memory password');
    expect(screen.queryByRole('heading', { name: '欢迎回来' })).not.toBeInTheDocument(); expect(bootstrapCalls).toBe(1);
  });
  it('ignores old bootstrap success and coalesces repeated expiry notifications while refreshing', async () => {
    const initial = deferred<Awaited<ReturnType<typeof dataReply>>>(); const refreshed = deferred<Awaited<ReturnType<typeof dataReply>>>(); let bootstrapCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/bootstrap')) return ++bootstrapCalls === 1 ? initial.promise : refreshed.promise;
      if (url.endsWith('/captcha')) return captchaReply();
      return failureReply();
    }));
    render(<App />);
    await act(async () => { await api('/api/v1/account/sessions').catch(() => undefined); await api('/api/v1/account/security-events').catch(() => undefined); });
    expect(bootstrapCalls).toBe(2);
    await act(async () => refreshed.resolve(await dataReply(bootstrapData(null))));
    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    await act(async () => initial.resolve(await dataReply(bootstrapData(expiryUser))));
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByText(expiryUser.nickname)).not.toBeInTheDocument();
  });
  it('does not let a late profile success restore the expired user', async () => {
    const profile = deferred<Awaited<ReturnType<typeof dataReply>>>(); let bootstrapCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/bootstrap')) return dataReply(bootstrapData(bootstrapCalls++ === 0 ? expiryUser : null));
      if (url.endsWith('/captcha')) return captchaReply();
      if (url.endsWith('/profile')) return profile.promise;
      if (url.endsWith('/auth/me')) return failureReply();
      return dataReply({ items: [] });
    }));
    render(<App />); fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
    await act(async () => { await api('/api/v1/auth/me').catch(() => undefined); });
    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    await act(async () => profile.resolve(await dataReply({ user: expiryUser })));
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument();
  });
  it('unsubscribes on unmount and ignores a bootstrap that settles afterward', async () => {
    const initial = deferred<Awaited<ReturnType<typeof dataReply>>>(); let bootstrapCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => { if (url.endsWith('/bootstrap')) { bootstrapCalls++; return initial.promise; } return failureReply(); }));
    const view = render(<App />); view.unmount();
    await act(async () => { await api('/api/v1/account/sessions').catch(() => undefined); initial.resolve(await dataReply(bootstrapData(expiryUser))); });
    expect(bootstrapCalls).toBe(1); expect(view.container).toBeEmptyDOMElement();
  });
});

describe('chat presentation boundaries', () => {
  it('distinguishes an empty conversation list from no search results', () => {
    render(<ConversationList conversations={[]} onSelect={vi.fn()} />);
    expect(screen.getByText('还没有会话')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: '查询' } });
    expect(screen.getByText('没有找到会话')).toBeInTheDocument();
  });
  it('never sends on IME confirmation, Shift+Enter or disabled access, but sends on plain Enter', async () => {
    const send = vi.fn();
    const { rerender } = render(<Composer value="一条待发送消息" onChange={vi.fn()} onSend={send} />);
    const textarea = screen.getByRole('textbox', { name: '消息内容' });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender(<Composer value="一条待发送消息" onChange={vi.fn()} onSend={send} disabledReason="当前无法发送消息" />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(textarea).toBeDisabled();
  });
});
