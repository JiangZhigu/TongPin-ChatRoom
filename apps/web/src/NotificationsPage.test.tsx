// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('task report notification boundaries', () => {
  it('shows closed feedback without task availability and marks it read without opening private or legacy reports', async () => {
    requestApi.mockResolvedValue({}); const openTask = vi.fn(); const openReports = vi.fn(); const refresh = vi.fn().mockResolvedValue(undefined);
    render(<NotificationsPage {...props} items={[{ ...item, type: 'task.report.updated', entityRef: 'report1', text: '你的待办举报已处理：已核实并完成处理。', readAt: null }]} onRefresh={refresh} onOpenTask={openTask} onOpenReports={openReports} />);
    expect(screen.getByText('你的待办举报已处理：已核实并完成处理。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '核对并查看待办' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '查看举报反馈' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '标为已读' })); await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1)); expect(requestApi).toHaveBeenCalledExactlyOnceWith('/api/v1/notifications/n1/read', expect.objectContaining({ method: 'POST', body: {}, signal: expect.any(AbortSignal) })); expect(openTask).not.toHaveBeenCalled(); expect(openReports).not.toHaveBeenCalled(); expect(props.onOpenRequests).not.toHaveBeenCalled();
  });
  it('shows only the server replacement text when task-report feedback has expired', () => {
    const value = { ...item, type: 'task.report.updated', entityRef: 'report1', text: '你的待办举报已处理：仅30天内可读' }; const view = render(<NotificationsPage {...props} items={[value]} />);
    view.rerender(<NotificationsPage {...props} items={[{ ...value, text: '待办举报反馈已过期或不可用', available: false }]} />); expect(screen.getByText('待办举报反馈已过期或不可用')).toBeInTheDocument(); expect(screen.queryByText('你的待办举报已处理：仅30天内可读')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '核对并查看待办' })).not.toBeInTheDocument(); expect(requestApi).not.toHaveBeenCalled();
  });
  it('displays the controlled admin task-report-created text without a private task action', () => {
    render(<NotificationsPage {...props} actorContext="admin1" items={[{ ...item, type: 'task.report.created', entityRef: 'report1', text: '收到新的待办举报，请前往管理后台核对。' }]} onOpenReports={vi.fn()} onOpenTask={vi.fn()} />); expect(screen.getByText('收到新的待办举报，请前往管理后台核对。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '核对并查看待办' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '查看举报反馈' })).not.toBeInTheDocument(); expect(requestApi).not.toHaveBeenCalled();
  });
  it('still hides ordinary task notification text unless both available and taskId are present', () => {
    const openTask = vi.fn(); render(<NotificationsPage {...props} items={[{ ...item, id: 'missing-available', type: 'task.assigned', taskId: 'private1', text: 'PRIVATE-NO-AVAILABILITY' }, { ...item, id: 'missing-id', type: 'task.updated', available: true, text: 'PRIVATE-NO-ID' }, { ...item, id: 'denied', type: 'task.updated', taskId: 'private2', available: false, text: 'PRIVATE-DENIED' }]} onOpenTask={openTask} />);
    for (const text of ['PRIVATE-NO-AVAILABILITY', 'PRIVATE-NO-ID', 'PRIVATE-DENIED']) expect(screen.queryByText(text)).not.toBeInTheDocument(); const actions = screen.getAllByRole('button', { name: '核对并查看待办' }); expect(actions).toHaveLength(3); actions.forEach((button) => { expect(button).toBeDisabled(); fireEvent.click(button); }); expect(openTask).not.toHaveBeenCalled(); expect(requestApi).not.toHaveBeenCalled();
  });
});