// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { ConversationList } from './components/ConversationList';
import { Composer } from './components/Composer';
import { api, setCsrfToken } from './lib/api';
import type { UserView } from './auth-types';
import { StrictMode } from 'react';

vi.mock('./lib/tasks-client', () => ({ TaskClient: class {
  userId: string; constructor(id: string) { this.userId = id; }
  private state = { revision: 0, listRevision: 0, entities: {}, invalid: {}, online: false, enabled: true, enhanced: true, error: null };
  getSnapshot = () => this.state; subscribe = () => () => undefined; start = () => undefined; stop = () => undefined;
} }));
// Authentication tests retain the real App/ChatWorkspace/settings components.
// Only the unrelated chat transport is isolated; bootstrap and auth use real api().
vi.mock('./lib/chat-client', () => ({
  ChatClient: class {
    private snapshot = { phase: 'connecting', conversations: [], contacts: [], requests: [], notifications: [], notificationCount: 0, selectedId: null, messages: [], historyBefore: null, historyLoading: false, outbox: [], error: null, nextConversations: null, nextContacts: null, nextRequests: null, nextNotifications: null, onlineNotice: null };
    private listeners = new Set<() => void>();
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    start = async () => { this.snapshot = { ...this.snapshot, phase: 'online' }; this.listeners.forEach((listener) => listener()); };
    stop = () => undefined;
    updateUser = () => undefined;
    getLocalSummary = async () => ({ pending: 0, drafts: 0 });
    logout = async () => { const { api: request } = await import('./lib/api'); await request('/api/v1/auth/logout', { method: 'POST', body: {} }); };
  },
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setCsrfToken(''); window.history.replaceState({}, '', '/'); });
function healthyResponse(url: string) {
  const data = url === '/health/ready' ? { status: 'ready', version: '0.1.0', features: { accounts: false } } : { accountsEnabled: false, registrationMode: 'closed' };
  return Promise.resolve({ ok: true, json: async () => ({ data, requestId: 'test-only' }) });
}

describe('real service entry', () => {
  it.each(['open', 'closed', 'invite-only'] as const)('opens /register using the current %s policy and can return to login', async (registrationMode) => {
    window.history.replaceState({}, '', '/register');
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/bootstrap') ? dataReply({ ...bootstrapData(null), registrationMode }) : captchaReply()));
    render(<App />); expect(await screen.findByRole('heading', { name: '创建你的账号' })).toBeInTheDocument();
    if (registrationMode === 'closed') {
      expect(screen.getByText('暂未开放注册')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    } else {
      expect(screen.getByLabelText('昵称')).toBeInTheDocument();
      expect(Boolean(screen.queryByLabelText('站点邀请码'))).toBe(registrationMode === 'invite-only');
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
    }
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument();
  });
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
async function openAccountSettings() {
  // Only this mounted instance's start() publishes online; a previous instance's
  // calls or an initial synthetic online snapshot cannot satisfy this readiness.
  await screen.findByText('已连接', { exact: true });
  expect(screen.getByText(expiryUser.nickname, { exact: true })).toBeInTheDocument();
  // Navigation saves the outgoing draft asynchronously before committing the page.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设置' })); });
}

describe('M7 current-account restrictions', () => {
  it('shows server-supplied restriction reasons as read-only account information', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/bootstrap') ? dataReply(bootstrapData({ ...expiryUser, restrictions: { uploadDisabled: true, groupCreationDisabled: false, reason: '附件违规审核期间', mutedUntil: 1999999999999, muteReason: '已核实连续骚扰' } })) : dataReply({ items: [] })));
    render(<App />); await openAccountSettings(); await screen.findByRole('heading', { name: '账号使用限制' });
    expect(screen.getByText('限制理由：附件违规审核期间')).toBeInTheDocument(); expect(screen.getByText('禁言理由：已核实连续骚扰')).toBeInTheDocument(); expect(screen.getByText('上传：已限制')).toBeInTheDocument(); expect(screen.getByText('创建群聊：未限制')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '解除限制' })).not.toBeInTheDocument();
  });
});

describe('M2 bootstrap StrictMode', () => {
  it.each(['login', 'register'] as const)('creates one anonymous flow and submits its CSRF token through the actual %s form', async (operation) => {
    let bootstrapCalls = 0;
    let cookieFlowToken = '';
    const submissions: { path: string; csrfToken: string | null; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
      if (url.endsWith('/bootstrap')) {
        // A first anonymous request has no flow cookie: each network request
        // would create a distinct flow cookie and matching CSRF token.
        const csrfToken = `anonymous-flow-${++bootstrapCalls}-csrf`;
        cookieFlowToken = csrfToken;
        return dataReply({ ...bootstrapData(null), registrationMode: 'open', csrfToken });
      }
      if (url.endsWith('/captcha')) return captchaReply();
      if (url.endsWith(`/auth/${operation}`)) {
        const csrfToken = new Headers(options.headers).get('X-CSRF-Token');
        submissions.push({ path: url, csrfToken, body: JSON.parse(options.body as string) });
        if (csrfToken !== cookieFlowToken) return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: { code: 'CSRF_INVALID', message: '验证码流程与CSRF不匹配' } }) });
        return dataReply({ user: expiryUser, csrfToken: 'post-auth-test-token', expiresAt: Date.now() + 60000, ...(operation === 'register' ? { recoveryCodes: ['STRICT-MODE-TEST-RECOVERY'] } : {}) });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }));
    render(<StrictMode><App /></StrictMode>);
    await screen.findByRole('heading', { name: '欢迎回来' });
    if (operation === 'register') fireEvent.click(screen.getByRole('button', { name: '注册' }));
    if (operation === 'register') await waitFor(() => expect(screen.getByRole('button', { name: '刷新图形验证码' })).toBeEnabled());
    expect(bootstrapCalls).toBe(1);
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'strict_mode_user' } });
    fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'a strict mode test password' } });
    if (operation === 'register') fireEvent.change(screen.getByLabelText('图形验证码'), { target: { value: 'ABCDEF' } });
    if (operation === 'register') {
      fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '严格模式测试' } });
      fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'a strict mode test password' } });
      fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意上述服务条款与隐私说明' }));
      fireEvent.click(screen.getByRole('button', { name: '创建账号' }));
      expect(await screen.findByRole('heading', { name: '保存你的恢复码' })).toBeInTheDocument();
    } else {
      fireEvent.click(screen.getAllByRole('button', { name: '登录' }).at(-1)!);
      expect(await screen.findByRole('heading', { name: '欢迎来到同频' })).toBeInTheDocument();
    }
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ path: `/api/v1/auth/${operation}`, csrfToken: 'anonymous-flow-1-csrf', body: { username: 'strict_mode_user', ...(operation === 'register' ? { captchaId: 'expiry-captcha', captchaAnswer: 'ABCDEF' } : {}) } });
    expect(bootstrapCalls).toBe(1);
    expect(screen.queryByText('验证码流程与CSRF不匹配')).not.toBeInTheDocument();
  });
});

describe('M2 auth expiry', () => {
  it.each(['read', 'write', 'logout'] as const)('clears settings identity after AUTH_REQUIRED on %s', async (operation) => {
    let bootstrapCalls = 0;
    const expired = deferred<Awaited<ReturnType<typeof failureReply>>>();
    const expiryRequests: { path: string; method: string; body: unknown }[] = [];
    const expiryPath = operation === 'read' ? '/api/v1/account/sessions' : operation === 'write' ? '/api/v1/account/profile' : '/api/v1/auth/logout';
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
      if (url.endsWith('/bootstrap')) return dataReply(bootstrapData(bootstrapCalls++ === 0 ? expiryUser : null));
      if (url.endsWith('/captcha')) return captchaReply();
      if (url === '/api/v1/auth/me') return dataReply({ user: expiryUser });
      if (url === expiryPath) {
        expiryRequests.push({ path: url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body as string) : null });
        return expired.promise;
      }
      return dataReply({ items: [] });
    }));
    render(<App />);
    await openAccountSettings();
    expect(await screen.findByRole('heading', { name: '账号设置' })).toBeInTheDocument();
    if (operation === 'write') {
      fireEvent.change(await screen.findByLabelText('昵称'), { target: { value: '未提交的资料' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存资料' })); });
      expect(screen.getByLabelText('昵称')).toHaveValue('未提交的资料');
    } else if (operation === 'logout') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '退出登录' })); });
    }
    // The expiry must come from this settings operation, after the real page mounted.
    await waitFor(() => expect(expiryRequests).toHaveLength(1));
    expect(expiryRequests[0]).toEqual({ path: expiryPath, method: operation === 'read' ? 'GET' : operation === 'write' ? 'PATCH' : 'POST', body: operation === 'write' ? { nickname: '未提交的资料', bio: '' } : operation === 'logout' ? {} : null });
    expect(bootstrapCalls).toBe(1);
    expect(screen.queryByRole('heading', { name: '欢迎回来' })).not.toBeInTheDocument();
    await act(async () => { expired.resolve(await failureReply()); });
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
      if (url.startsWith('/api/v1/admin/overview')) return dataReply({ window: '24h', from: 0, to: 1, generatedAt: 1, metrics: [], trends: [], processStartedAt: 0 });
      return failureReply();
    }));
    render(<App />);
    if (operation === 'logout') { await screen.findByRole('heading', { name: '运营概览' }); fireEvent.click(screen.getByRole('button', { name: '退出当前账号' })); }
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
    render(<App />); await openAccountSettings();
    fireEvent.click(await screen.findByRole('button', { name: '验证身份并重新生成' }));
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
    // A new identity's flow must wait for the old Set-Cookie response to settle.
    expect(bootstrapCalls).toBe(1);
    await act(async () => initial.resolve(await dataReply(bootstrapData(expiryUser))));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    expect(screen.getByRole('heading', { name: '正在连接同频' })).toBeInTheDocument();
    expect(screen.queryByText(expiryUser.nickname)).not.toBeInTheDocument();
    await act(async () => refreshed.resolve(await dataReply(bootstrapData(null))));
    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(screen.queryByText(expiryUser.nickname)).not.toBeInTheDocument();
  });
  it('does not let a late profile success restore the expired user', async () => {
    const profile = deferred<Awaited<ReturnType<typeof dataReply>>>(); let bootstrapCalls = 0; let profileStarted = false;
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
      if (url.endsWith('/bootstrap')) return dataReply(bootstrapData(bootstrapCalls++ === 0 ? expiryUser : null));
      if (url.endsWith('/captcha')) return captchaReply();
      if (url.endsWith('/profile') && options.method === 'PATCH') { profileStarted = true; return profile.promise; }
      // Settings now verifies identity on mount. Expire only after the pending write exists.
      if (url.endsWith('/auth/me')) return profileStarted ? failureReply() : dataReply({ user: expiryUser });
      return dataReply({ items: [] });
    }));
    render(<App />); await openAccountSettings();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存资料' })); });
    expect(profileStarted).toBe(true);
    expect(screen.getByRole('heading', { name: '账号设置' })).toBeInTheDocument();
    expect(bootstrapCalls).toBe(1);
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
