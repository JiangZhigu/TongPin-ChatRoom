// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api } from './lib/api';
import { NotificationsPage } from './NotificationsPage';
vi.mock('./lib/api', async (original) => ({ ...await original<typeof import('./lib/api')>(), api: vi.fn() }));
const requestApi = vi.mocked(api); const item = { id: 'n1', type: 'system.notice', entityRef: 'notice1', createdAt: 1, readAt: 1, text: '维护公告' };
const props = { items: [item], actorContext: 'u1', hasMore: false, onLoadMore: vi.fn(), onRefresh: vi.fn(), onOpenRequests: vi.fn() };
beforeEach(() => { requestApi.mockReset(); props.onOpenRequests.mockReset(); Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); }); afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('reads system notice through recipient API and clears old body before withdrawn refresh', async () => {
  requestApi.mockResolvedValueOnce({ id: 'notice1', kind: 'announcement', title: '系统维护', body: 'PRIVATE-OLD-BODY', status: 'published', publishedAt: 1 }); let resolve!: (value: unknown) => void; requestApi.mockImplementationOnce(() => new Promise((done) => { resolve = done; })); render(<NotificationsPage {...props} />); fireEvent.click(screen.getByRole('button', { name: '查看系统公告' })); await screen.findByText('PRIVATE-OLD-BODY'); expect(requestApi.mock.calls[0][0]).toBe('/api/v1/announcements/notice1'); expect(props.onOpenRequests).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '刷新公告详情' })); expect(screen.queryByText('PRIVATE-OLD-BODY')).not.toBeInTheDocument(); await act(async () => { resolve({ id: 'notice1', kind: 'announcement', title: '系统维护', body: 'MUST-NOT-SHOW', status: 'withdrawn', publishedAt: 1 }); }); expect(screen.getByText('此公告已撤回，正文不再显示。')).toBeInTheDocument(); expect(screen.queryByText('MUST-NOT-SHOW')).not.toBeInTheDocument();
});
it('aborts pending system details on identity change and rejects a late response', async () => {
  let resolve!: (value: unknown) => void; requestApi.mockImplementation(() => new Promise((done) => { resolve = done; })); const view = render(<NotificationsPage {...props} />); fireEvent.click(screen.getByRole('button', { name: '查看系统公告' })); await waitFor(() => expect(requestApi).toHaveBeenCalled()); const signal = requestApi.mock.calls[0][1]!.signal!; view.rerender(<NotificationsPage {...props} actorContext="u2" items={[]} />); expect(signal.aborted).toBe(true); await act(async () => { resolve({ id: 'notice1', kind: 'announcement', title: '旧账号公告', body: 'LATE-PRIVATE-BODY', status: 'published', publishedAt: 1 }); }); expect(screen.queryByText('LATE-PRIVATE-BODY')).not.toBeInTheDocument(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('aborts details when leaving the notification page', async () => {
  requestApi.mockImplementation(() => new Promise(() => {})); const view = render(<NotificationsPage {...props} />); fireEvent.click(screen.getByRole('button', { name: '查看系统公告' })); await waitFor(() => expect(requestApi).toHaveBeenCalled()); const signal = requestApi.mock.calls[0][1]!.signal!; view.unmount(); expect(signal.aborted).toBe(true);
});
