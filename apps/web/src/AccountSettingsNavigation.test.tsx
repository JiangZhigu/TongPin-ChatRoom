// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AccountSettings } from './AccountSettings';
import type { UserView } from './auth-types';

const request = vi.hoisted(() => vi.fn());
vi.mock('./lib/api', async (original) => ({ ...await original<typeof import('./lib/api')>(), api: request }));
const user: UserView = { id: 'navigation-user', username: 'navigation_user', nickname: '设置导航测试', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; }
const tab = (name: string) => screen.getByRole('tab', { name });
const select = (name: string) => fireEvent.click(tab(name));

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/me') return { user };
    if (path === '/api/v1/account/admin-enrollment') return { invitation: null };
    return { items: [] };
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(cleanup);

describe('settings grouped navigation', () => {
  it('shows one panel, retains password drafts across groups, and supports keyboard selection', async () => {
    render(<AccountSettings embedded user={user} onUserChange={vi.fn()} onSignedOut={vi.fn()} />);
    await screen.findByText('暂无可显示的登录设备。');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByRole('tabpanel', { name: '隐私与通知偏好' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '账号使用限制', hidden: true })).not.toBeVisible();
    select('修改密码');
    const password = screen.getByLabelText('新密码', { exact: true });
    fireEvent.change(password, { target: { value: 'unsent local password draft' } });
    select('浏览器通知');
    expect(password).not.toBeVisible();
    expect(password.closest('[role=tabpanel]')).toHaveAttribute('inert');
    select('修改密码');
    expect(screen.getByLabelText('新密码', { exact: true })).toBe(password);
    expect(password).toHaveValue('unsent local password draft');
    const privacy = tab('隐私与通知偏好'); privacy.focus();
    fireEvent.keyDown(privacy, { key: 'Home' });
    fireEvent.keyDown(privacy, { key: 'ArrowDown' });
    expect(tab('浏览器通知')).toHaveAttribute('aria-selected', 'true');
    expect(tab('浏览器通知')).toHaveFocus();
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('locks navigation until a real preference request finishes and preserves its server result', async () => {
    const pending = deferred<{ user: UserView }>(); const changed = vi.fn(); const busy = vi.fn();
    const original = request.getMockImplementation()!;
    request.mockImplementation((path, options) => path === '/api/v1/account/preferences' ? pending.promise : original(path, options));
    render(<AccountSettings embedded user={user} onUserChange={changed} onSignedOut={vi.fn()} onBusyChange={busy} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /隐身状态/ }));
    expect(request).toHaveBeenCalledWith('/api/v1/account/preferences', expect.objectContaining({ method: 'PATCH', body: { invisible: true } }));
    expect(busy).toHaveBeenLastCalledWith(true);
    for (const item of screen.getAllByRole('tab')) expect(item).toBeDisabled();
    fireEvent.click(tab('修改密码'));
    expect(tab('隐私与通知偏好')).toHaveAttribute('aria-selected', 'true');
    const updated = { ...user, preferences: { ...user.preferences, invisible: true } };
    await act(async () => pending.resolve({ user: updated }));
    expect(changed).toHaveBeenCalledWith(updated);
    expect(tab('修改密码')).toBeEnabled();
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it('keeps navigation locked while administrator verification is running or a binding secret is open', async () => {
    const pending = deferred<{ reauthToken: string }>(); const busy = vi.fn();
    const original = request.getMockImplementation()!;
    request.mockImplementation((path, options) => {
      if (path === '/api/v1/account/admin-enrollment') return Promise.resolve({ invitation: { id: 'invitation', purpose: 'grant', expiresAt: Date.now() + 60000, inviter: { id: 'owner', nickname: '邀请人', username: 'owner' } } });
      if (path === '/api/v1/auth/reauth') return pending.promise;
      if (path === '/api/v1/account/admin-enrollment/start') return Promise.resolve({ enrollmentId: 'test-enrollment', secret: 'ISOLATED-TEST-SECRET', uri: 'otpauth://totp/isolated-test', expiresAt: Date.now() + 60000 });
      return original(path, options);
    });
    render(<AccountSettings embedded user={user} onUserChange={vi.fn()} onSignedOut={vi.fn()} onBusyChange={busy} />);
    select('管理权限邀请与绑定');
    fireEvent.change(await screen.findByLabelText('绑定验证密码'), { target: { value: 'isolated test password' } });
    fireEvent.click(screen.getByRole('button', { name: '验证密码并开始绑定' }));
    await waitFor(() => expect(tab('隐私与通知偏好')).toBeDisabled());
    expect(busy).toHaveBeenLastCalledWith(true);
    await act(async () => pending.resolve({ reauthToken: 'isolated-action-token' }));
    await screen.findByRole('button', { name: '隐藏秘密并重新开始' });
    expect(tab('隐私与通知偏好')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '隐藏秘密并重新开始' }));
    await waitFor(() => expect(tab('隐私与通知偏好')).toBeEnabled());
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it('offers callback-dependent destinations and does not leave an empty administrator binding destination', async () => {
    const reports = vi.fn();
    const view = render(<AccountSettings embedded user={user} onUserChange={vi.fn()} onSignedOut={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: '举报与反馈' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '注销账号' })).not.toBeInTheDocument();
    view.rerender(<AccountSettings embedded user={user} onUserChange={vi.fn()} onSignedOut={vi.fn()} onOpenReports={reports} onDeleted={vi.fn()} />);
    select('举报与反馈');
    fireEvent.click(screen.getByRole('button', { name: '我的举报' })); expect(reports).toHaveBeenCalledOnce();
    view.rerender(<AccountSettings embedded user={{ ...user, siteRole: 'super_admin' }} onUserChange={vi.fn()} onSignedOut={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: '管理权限邀请与绑定' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });
});
