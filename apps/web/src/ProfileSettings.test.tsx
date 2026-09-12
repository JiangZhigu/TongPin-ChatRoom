// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ProfileSettings } from './ProfileSettings';
import { api, APIError } from './lib/api';
import type { UserView } from './auth-types';

vi.mock('./lib/api', async (original) => ({ ...await original<typeof import('./lib/api')>(), api: vi.fn() }));
const requestApi = vi.mocked(api);
const user: UserView = { id: 'profile-a', username: 'profile_a', nickname: '原昵称', bio: '原简介', avatarUrl: '/api/v1/users/profile-a/avatar', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => requestApi.mockReset());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('saves the edited profile through PATCH with actor context and locks editing until the response', async () => {
  const pending = deferred<{ user: UserView }>(); requestApi.mockReturnValueOnce(pending.promise);
  const changed = vi.fn(); const busy = vi.fn();
  render(<ProfileSettings user={user} onUserChange={changed} onBusyChange={busy} />);
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '新昵称' } });
  fireEvent.change(screen.getByLabelText('个人简介'), { target: { value: '新简介' } });
  fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(requestApi).toHaveBeenCalledExactlyOnceWith('/api/v1/account/profile', expect.objectContaining({ method: 'PATCH', actorContext: user.id, body: { nickname: '新昵称', bio: '新简介' }, signal: expect.any(AbortSignal) }));
  expect(screen.getByLabelText('昵称')).toBeDisabled();
  expect(screen.getByLabelText('个人简介')).toBeDisabled();
  expect(screen.getByRole('button', { name: '选择头像' })).toBeDisabled();
  expect(busy).toHaveBeenLastCalledWith(true);
  expect(changed).not.toHaveBeenCalled();
  const updated = { ...user, nickname: '新昵称', bio: '新简介' };
  await act(async () => pending.resolve({ user: updated }));
  expect(changed).toHaveBeenCalledExactlyOnceWith(updated);
  expect(screen.getByRole('status')).toHaveTextContent('个人资料已保存。');
  expect(screen.getByLabelText('昵称')).toBeEnabled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

it('includes avatar saving in parent busy state and preserves an unsaved nickname draft', async () => {
  const pending = deferred<{ user: UserView }>(); requestApi.mockReturnValueOnce(pending.promise);
  const changed = vi.fn(); const busy = vi.fn();
  render(<ProfileSettings user={user} onUserChange={changed} onBusyChange={busy} />);
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '尚未保存的昵称' } });
  fireEvent.click(screen.getByRole('button', { name: '移除头像' }));
  expect(requestApi).toHaveBeenCalledWith('/api/v1/me/avatar', expect.objectContaining({ method: 'PUT', actorContext: user.id, body: { attachmentId: null } }));
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(true));
  expect(screen.getByRole('button', { name: '保存资料' })).toBeDisabled();
  await act(async () => pending.resolve({ user: { ...user, avatarUrl: null } }));
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: user.id, avatarUrl: null }));
  expect(screen.getByLabelText('昵称')).toHaveValue('尚未保存的昵称');
  expect(screen.getByRole('button', { name: '保存资料' })).toBeEnabled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

it('shows server validation errors without clearing drafts or reporting a successful update', async () => {
  requestApi.mockRejectedValueOnce(new APIError(422, { message: '资料未通过校验', fieldErrors: { nickname: '昵称不可用', bio: '简介过长' } }));
  const changed = vi.fn(); const busy = vi.fn();
  render(<ProfileSettings user={user} onUserChange={changed} onBusyChange={busy} />);
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '保留失败草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('资料未通过校验');
  expect(screen.getByRole('alert')).toHaveTextContent('昵称不可用');
  expect(screen.getByLabelText('昵称')).toHaveValue('保留失败草稿');
  expect(screen.getByLabelText('昵称')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('个人简介')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: '保存资料' })).toBeEnabled();
  expect(changed).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});

describe('late profile responses', () => {
  it.each(['identity change', 'unmount'] as const)('ignores a delayed successful PATCH after %s even if transport resolves after abort', async (reason) => {
    const pending = deferred<{ user: UserView }>(); requestApi.mockReturnValueOnce(pending.promise);
    const oldChanged = vi.fn(); const nextChanged = vi.fn(); const busy = vi.fn();
    const view = render(<ProfileSettings user={user} onUserChange={oldChanged} onBusyChange={busy} />);
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '旧账号未完成保存' } });
    fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
    const signal = requestApi.mock.calls[0][1]?.signal;
    const nextUser = { ...user, id: 'profile-b', username: 'profile_b', nickname: '新账号', bio: '新账号简介' };
    if (reason === 'identity change') view.rerender(<ProfileSettings user={nextUser} onUserChange={nextChanged} onBusyChange={busy} />);
    else view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ user: { ...user, nickname: '旧账号返回值' } }));
    expect(oldChanged).not.toHaveBeenCalled();
    expect(nextChanged).not.toHaveBeenCalled();
    if (reason === 'identity change') {
      expect(screen.getByLabelText('昵称')).toHaveValue('新账号');
      expect(screen.getByLabelText('个人简介')).toHaveValue('新账号简介');
      expect(screen.queryByText('个人资料已保存。')).not.toBeInTheDocument();
    }
    expect(busy).toHaveBeenLastCalledWith(false);
  });
});

it('rejects an API response for a different user without replacing the current profile', async () => {
  requestApi.mockResolvedValueOnce({ user: { ...user, id: 'unexpected-account' } });
  const changed = vi.fn();
  render(<ProfileSettings user={user} onUserChange={changed} />);
  fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('返回账号与当前账号不一致');
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByLabelText('昵称')).toHaveValue(user.nickname);
  expect(screen.getByRole('button', { name: '保存资料' })).toBeEnabled();
});
