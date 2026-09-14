// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api, APIError } from './lib/api';
import type { UserView } from './auth-types';
import { AdminEnrollmentPanel } from './AdminEnrollmentPanel';

vi.mock('./lib/api', async (original) => ({ ...await original<typeof import('./lib/api')>(), api: vi.fn() }));
const requestApi = vi.mocked(api);
const user: UserView = { id: 'u1', username: 'one', nickname: '本人', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const invitation = { id: 'invite1', purpose: 'grant', expiresAt: Date.now() + 86400000, inviter: { id: 'admin', username: 'admin', nickname: '邀请者' } };
const enrollment = { enrollmentId: 'enroll1', expiresAt: Date.now() + 600000 };
beforeEach(() => { requestApi.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function accept() { fireEvent.change(await screen.findByLabelText('当前密码'), { target: { value: 'private-password' } }); fireEvent.click(screen.getByRole('button', { name: '验证密码并接受邀请' })); }
function responses() { requestApi.mockImplementation(async (path) => path.endsWith('/reauth') ? { reauthToken: 'ephemeral-token' } : path.endsWith('/start') ? enrollment : path.endsWith('/finish') ? { user: { ...user, siteRole: 'super_admin' } } : { invitation }); }
it('accepts with password alone and updates identity without recovery codes', async () => {
  responses(); const storage = vi.spyOn(Storage.prototype, 'setItem'); const changed = vi.fn(); render(<AdminEnrollmentPanel user={user} onUserChange={changed} />);
  await accept(); await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ siteRole: 'super_admin' })));
  expect(requestApi.mock.calls.find(([path]) => path.endsWith('/reauth'))?.[1]?.body).toEqual({ password: 'private-password', action: 'administrator.enroll' });
  expect(requestApi.mock.calls.find(([path]) => path.endsWith('/start'))?.[1]?.body).toEqual({ reauthToken: 'ephemeral-token' });
  expect(requestApi.mock.calls.find(([path]) => path.endsWith('/finish'))?.[1]?.body).toEqual({ enrollmentId: 'enroll1' });
  expect(screen.queryByText(/动态码|恢复码|绑定密钥/)).not.toBeInTheDocument(); expect(storage).not.toHaveBeenCalled();
});
it('allows retry after wrong password without granting permission', async () => {
  responses(); const original = requestApi.getMockImplementation()!; let attempts = 0;
  requestApi.mockImplementation(async (path, options) => { if (path.endsWith('/reauth') && attempts++ === 0) throw new APIError(401, { code: 'REAUTH_FAILED', message: '密码不正确，请重试' }); return original(path, options); });
  const changed = vi.fn(); render(<AdminEnrollmentPanel user={user} onUserChange={changed} />);
  await accept(); await screen.findByText('密码不正确，请重试'); expect(changed).not.toHaveBeenCalled(); expect(screen.getByLabelText('当前密码')).toHaveValue('');
  expect(requestApi.mock.calls.some(([path]) => path.endsWith('/start'))).toBe(false);
  await accept(); await waitFor(() => expect(changed).toHaveBeenCalledOnce());
});
it('aborts late acceptance results when identity changes', async () => {
  responses(); let resolve!: (value: unknown) => void; const late = new Promise((done) => { resolve = done; }); const original = requestApi.getMockImplementation()!;
  requestApi.mockImplementation(async (path, options) => path.endsWith('/finish') ? late : original(path, options));
  const changed = vi.fn(); const view = render(<AdminEnrollmentPanel user={user} onUserChange={changed} />); await accept();
  await waitFor(() => expect(requestApi.mock.calls.some(([path]) => path.endsWith('/finish'))).toBe(true));
  const signal = requestApi.mock.calls.find(([path]) => path.endsWith('/finish'))![1]!.signal!;
  view.rerender(<AdminEnrollmentPanel user={{ ...user, id: 'u2' }} onUserChange={changed} />); expect(signal.aborted).toBe(true);
  await act(async () => { resolve({ user: { ...user, siteRole: 'super_admin' } }); }); expect(changed).not.toHaveBeenCalled();
});
it('does not replay an acceptance whose result is uncertain', async () => {
  responses(); const original = requestApi.getMockImplementation()!;
  requestApi.mockImplementation(async (path, options) => { if (path.endsWith('/finish')) throw new Error('连接中断'); return original(path, options); });
  const changed = vi.fn(); render(<AdminEnrollmentPanel user={user} onUserChange={changed} />); await accept();
  await screen.findByText('接受邀请的结果尚未确认，请重新登录核对当前身份。');
  expect(changed).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: '验证密码并接受邀请' })).not.toBeInTheDocument();
  expect(requestApi.mock.calls.filter(([path]) => path.endsWith('/finish'))).toHaveLength(1);
});
