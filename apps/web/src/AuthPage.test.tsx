// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AuthPage } from './AuthPage';
import { AccountSettings } from './AccountSettings';
import type { BootstrapView, UserView } from './auth-types';
import { setCsrfToken } from './lib/api';

const user: UserView = { id: 'test-user', username: 'test_user', nickname: '测试用户', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const bootstrap: BootstrapView = { accountsEnabled: true, registrationMode: 'open', csrfToken: 'test-csrf', user: null, terms: { version: 'test-terms', operatorName: '测试运营', operatorContact: '测试联系方式', development: true, text: '测试条款：管理方可以审阅消息与附件，所有访问均被审计。' } };
const response = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ data }) });
const captcha = () => response({ captchaId: 'test-captcha', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setCsrfToken(''); });
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
async function loginFields() { await waitFor(() => expect(screen.getByRole('button', { name: '刷新图形验证码' })).toBeEnabled()); fill('用户名', 'test_user'); fill('密码', 'a safe test password'); fill('图形验证码', 'ABCDEF'); }

describe('M2 authentication UI', () => {
  it('keeps login and recovery available when registration is closed', async () => {
    vi.stubGlobal('fetch', vi.fn(captcha));
    render(<AuthPage bootstrap={{ ...bootstrap, registrationMode: 'closed' }} admin={false} onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.getByText('暂未开放注册')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？使用恢复码找回' }));
    expect(screen.getByRole('heading', { name: '找回你的账号' })).toBeInTheDocument();
    expect(screen.getByLabelText('账号恢复码')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新图形验证码' })).toBeEnabled());
  });
  it('submits server terms and invite, then requires recovery-code save confirmation before entering', async () => {
    const authenticated = vi.fn();
    const fetchMock = vi.fn((url: string, _options?: RequestInit) => url.endsWith('/captcha') ? captcha() : response({ user, csrfToken: 'new-test-csrf', expiresAt: 1, recoveryCodes: ['TEST-CODE-ONE', 'TEST-CODE-TWO'] }));
    vi.stubGlobal('fetch', fetchMock); setCsrfToken('test-csrf');
    render(<AuthPage bootstrap={{ ...bootstrap, registrationMode: 'invite-only' }} admin={false} onAuthenticated={authenticated} />);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    await loginFields(); fill('昵称', '测试用户'); fill('站点邀请码', 'TEST-INVITE'); fill('确认密码', 'a safe test password');
    expect(screen.getByText(bootstrap.terms.text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建账号' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意上述服务条款与隐私说明' }));
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));
    expect(await screen.findByRole('heading', { name: '保存你的恢复码' })).toBeInTheDocument();
    expect(authenticated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '已保存，继续' })).toBeDisabled();
    const request = fetchMock.mock.calls.find(([url]) => url.endsWith('/register'));
    expect(request).toBeDefined();
    expect(JSON.parse(request![1]!.body as string)).toMatchObject({ termsVersion: 'test-terms', acceptTerms: true, siteInvite: 'TEST-INVITE', password: 'a safe test password' });
    expect(request![1]!.headers).toMatchObject({ 'X-CSRF-Token': 'test-csrf' });
    fireEvent.click(screen.getByRole('checkbox', { name: '我已将恢复码保存到安全的位置' }));
    fireEvent.click(screen.getByRole('button', { name: '已保存，继续' }));
    expect(authenticated).toHaveBeenCalledTimes(1);
  });
  it('refreshes consumed captcha and retains in-memory login fields when second factor is required', async () => {
    const fetchMock = vi.fn((url: string) => url.endsWith('/captcha') ? captcha() : Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { code: 'SECOND_FACTOR_REQUIRED', message: '需要第二因素' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthPage bootstrap={bootstrap} admin={false} onAuthenticated={vi.fn()} />);
    await loginFields(); fireEvent.click(screen.getAllByRole('button', { name: '登录' }).at(-1)!);
    expect(await screen.findByText('需要第二因素')).toBeInTheDocument();
    expect(screen.getByLabelText('动态码或第二因素恢复码')).toBeInTheDocument();
    expect(screen.getByLabelText('用户名')).toHaveValue('test_user');
    expect(screen.getByLabelText('密码', { exact: true })).toHaveValue('a safe test password');
    expect(screen.getByLabelText('图形验证码')).toHaveValue('');
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/captcha')).length).toBe(2);
  });
  it('returns to login after account recovery without treating it as authentication', async () => {
    const authenticated = vi.fn(); vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/captcha') ? captcha() : response({ recovered: true })));
    render(<AuthPage bootstrap={bootstrap} admin={false} onAuthenticated={authenticated} />);
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？使用恢复码找回' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新图形验证码' })).toBeEnabled());
    fill('用户名', 'test_user'); fill('新密码', 'a safe new password'); fill('确认密码', 'a safe new password'); fill('账号恢复码', 'TEST-CODE'); fill('图形验证码', 'ABCDEF');
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
    expect(await screen.findByText('密码已重置，旧会话已注销。请使用新密码登录。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeInTheDocument();
    expect(authenticated).not.toHaveBeenCalled();
  });
});

describe('M2 account security UI', () => {
  it('does not optimistically change a preference after server rejection', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => options?.method === 'PATCH' ? Promise.resolve({ ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN', message: '设置未保存' } }) }) : response({ items: [] })));
    const changed = vi.fn(); render(<AccountSettings user={user} onUserChange={changed} onSignedOut={vi.fn()} />);
    await screen.findByText('暂无可显示的登录设备。');
    fireEvent.click(screen.getByRole('checkbox', { name: /隐身状态/ }));
    expect(await screen.findByText('设置未保存')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /隐身状态/ })).not.toBeChecked(); expect(changed).not.toHaveBeenCalled();
  });
  it('reauthenticates for the exact session before revoking it', async () => {
    // jsdom lacks native modal methods. This test covers request ordering only.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    const requests: { url: string; body?: Record<string, unknown>; method?: string }[] = [];
    const session = { id: 'test-session', device: '测试浏览器', createdAt: 1, lastSeenAt: 1, expiresAt: 2, current: false };
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => { requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body as string) : undefined }); if (url.endsWith('/reauth')) return response({ reauthToken: 'test-action-token' }); if (options.method === 'DELETE') return response({ revoked: true }); return response({ items: url.endsWith('/sessions') ? [session] : [] }); }));
    render(<AccountSettings user={user} onUserChange={vi.fn()} onSignedOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '撤销会话' }));
    fill('当前密码', 'a safe test password'); fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    expect(await screen.findByText('该设备会话已撤销。')).toBeInTheDocument();
    expect(requests.find((item) => item.url.endsWith('/reauth'))?.body).toEqual({ password: 'a safe test password', action: 'revoke_session:test-session' });
    expect(requests.find((item) => item.method === 'DELETE')?.body).toEqual({ reauthToken: 'test-action-token' });
  });
  it('signs out only after the server confirms password replacement', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    const signedOut = vi.fn();
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => { requests.push({ url, body: options.body ? JSON.parse(options.body as string) : undefined }); if (url.endsWith('/reauth')) return response({ reauthToken: 'password-action-token' }); if (url.endsWith('/password')) return response({ changed: true }); return response({ items: [] }); }));
    render(<AccountSettings user={user} onUserChange={vi.fn()} onSignedOut={signedOut} />);
    await screen.findByText('暂无可显示的登录设备。');
    fill('新密码', 'a safe new password'); fill('确认新密码', 'a safe new password');
    fireEvent.click(screen.getByRole('button', { name: '验证身份并修改密码' }));
    expect(signedOut).not.toHaveBeenCalled();
    fill('当前密码', 'a safe old password'); fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    await waitFor(() => expect(signedOut).toHaveBeenCalledTimes(1));
    expect(requests.find((request) => request.url.endsWith('/reauth'))?.body?.action).toBe('change_password');
    expect(requests.find((request) => request.url.endsWith('/password'))?.body).toEqual({ password: 'a safe new password', reauthToken: 'password-action-token' });
  });
});
