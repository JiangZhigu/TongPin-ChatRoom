// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api } from '../lib/api';
import type { ChatClient } from '../lib/chat-client';
import { AdminEntry } from './AdminEntry';

vi.mock('../lib/api', () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const grant = { admin: { href: '/admin' as const } };
function deferred() {
  let resolve!: (value: typeof grant | { admin: null }) => void;
  const promise = new Promise<typeof grant | { admin: null }>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  type Listener = Parameters<ChatClient['subscribeTaskEvents']>[0];
  const listeners = new Set<Listener>();
  const client: Pick<ChatClient, 'subscribeTaskEvents'> = { subscribeTaskEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  return { client, emit: () => { for (const listener of listeners) listener({ type: 'account.changed', entityRef: 'u1', conversationId: null }); } };
}
const absent = () => expect(screen.queryByRole('link', { name: '管理入口' })).not.toBeInTheDocument();
beforeEach(() => { request.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('server-authorized admin navigation', () => {
  it('stays hidden during loading and only renders the server-provided admin destination', async () => {
    const pending = deferred(); request.mockReturnValueOnce(pending.promise); const f = fixture();
    render(<AdminEntry userId="u1" online client={f.client} />); absent();
    expect(request).toHaveBeenCalledWith('/api/v1/account/navigation', { actorContext: 'u1', signal: expect.any(AbortSignal) });
    await act(async () => pending.resolve(grant));
    expect(screen.getByRole('link', { name: '管理入口' })).toHaveAttribute('href', '/admin');
  });

  it('does not expose an admin entry when the server denies access or the request fails', async () => {
    const f = fixture(); request.mockResolvedValueOnce({ admin: null });
    render(<AdminEntry userId="u1" online client={f.client} />);
    await act(async () => {}); absent();
    request.mockRejectedValueOnce(new Error('permission check unavailable'));
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => {}); absent();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('aborts the old identity request and ignores a late grant after switching accounts', async () => {
    const old = deferred(); const current = deferred(); const f = fixture();
    request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<AdminEntry userId="u1" online client={f.client} />);
    const signal = request.mock.calls[0][1]!.signal!;
    view.rerender(<AdminEntry userId="u2" online client={f.client} />);
    expect(signal.aborted).toBe(true); absent();
    expect(request.mock.calls[1][1]?.actorContext).toBe('u2');
    await act(async () => current.resolve({ admin: null }));
    await act(async () => old.resolve(grant)); absent();
  });

  it('clears a previous grant and aborts pending work while offline, then rechecks on reconnect', async () => {
    const f = fixture(); request.mockResolvedValueOnce(grant);
    const view = render(<AdminEntry userId="u1" online client={f.client} />);
    await screen.findByRole('link', { name: '管理入口' });
    const pending = deferred(); request.mockReturnValueOnce(pending.promise);
    act(() => window.dispatchEvent(new Event('focus'))); absent();
    const signal = request.mock.calls[1][1]!.signal!;
    view.rerender(<AdminEntry userId="u1" online={false} client={f.client} />);
    expect(signal.aborted).toBe(true); absent();
    await act(async () => pending.resolve(grant)); absent();
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce(grant); view.rerender(<AdminEntry userId="u1" online client={f.client} />);
    expect(await screen.findByRole('link', { name: '管理入口' })).toHaveAttribute('href', '/admin');
  });

  it('ignores another user change but clears the grant immediately for a matching account event', async () => {
    const f = fixture(); request.mockResolvedValueOnce(grant);
    render(<AdminEntry userId="u1" online client={f.client} />);
    await screen.findByRole('link', { name: '管理入口' });
    act(() => window.dispatchEvent(new CustomEvent('tongpin:account-changed', { detail: { userId: 'u2' } })));
    expect(request).toHaveBeenCalledTimes(1);
    const pending = deferred(); request.mockReturnValueOnce(pending.promise);
    act(() => window.dispatchEvent(new CustomEvent('tongpin:account-changed', { detail: { userId: 'u1' } })));
    absent(); await act(async () => pending.resolve({ admin: null })); absent();
  });

  it('clears the entry on a subscribed account change and keeps it hidden when revalidation fails', async () => {
    const f = fixture(); request.mockResolvedValueOnce(grant);
    render(<AdminEntry userId="u1" online client={f.client} />);
    await screen.findByRole('link', { name: '管理入口' });
    request.mockRejectedValueOnce(new Error('permission revoked'));
    act(() => f.emit()); absent(); await act(async () => {}); absent();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refreshes on visibility becoming visible and ignores a superseded response', async () => {
    const f = fixture(); request.mockResolvedValueOnce(grant);
    render(<AdminEntry userId="u1" online client={f.client} />);
    await screen.findByRole('link', { name: '管理入口' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(request).toHaveBeenCalledTimes(1);
    const old = deferred(); const newer = deferred(); request.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange'))); absent();
    const signal = request.mock.calls[1][1]!.signal!;
    act(() => window.dispatchEvent(new Event('focus'))); expect(signal.aborted).toBe(true);
    await act(async () => newer.resolve({ admin: null })); await act(async () => old.resolve(grant)); absent();
  });

  it('aborts outstanding checks and removes event subscriptions when unmounted', async () => {
    const f = fixture(); const pending = deferred(); request.mockReturnValueOnce(pending.promise);
    const view = render(<AdminEntry userId="u1" online client={f.client} />);
    const signal = request.mock.calls[0][1]!.signal!; view.unmount(); expect(signal.aborted).toBe(true);
    act(() => { f.emit(); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new CustomEvent('tongpin:account-changed', { detail: { userId: 'u1' } })); });
    await act(async () => pending.resolve(grant));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1)); absent();
  });
});