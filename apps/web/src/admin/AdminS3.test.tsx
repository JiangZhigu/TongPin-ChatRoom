// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api, apiBlob, APIError } from '../lib/api';
import type { UserView } from '../auth-types';
import type { AdminOperation } from '../lib/admin-s3-types';
import { AdminContext } from './AdminShared';
import { AdminShell } from './AdminShell';
import { AnnouncementsPage } from './AnnouncementsPage';
import { AuditPage } from './AuditPage';
import { ExportForm, OperationDownload, OperationsPage } from './OperationsPage';
import { AdminActionDialog } from './AdminActionDialog';

vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn(), apiBlob: vi.fn() }));
const requestApi = vi.mocked(api); const requestBlob = vi.mocked(apiBlob);
const user: UserView = { id: 'admin', username: 'admin', nickname: '管理员', bio: '', siteRole: 'super_admin', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const operation: AdminOperation = { id: 'op-one', kind: 'backup.create', status: 'running', creator: user, createdAt: 1, updatedAt: 2, expiresAt: null, progress: 3, total: 10, bytes: 20, message: '正在逐文件校验', errorCode: null, result: {}, jobId: 'job-one', requestId: 'request-one', canCancel: true, canRetry: false, canDownload: false, sha256: null, backupClass: null };
const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, total: items.length, nextCursor });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; }
function context() { return { openAction: vi.fn(), deny: vi.fn(), navigate: vi.fn(), revision: 0 }; }
beforeEach(() => { requestApi.mockReset(); requestBlob.mockReset(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-test') }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

describe('S3 command parameters and actual receipts', () => {
  it('snapshots explicit account recipients and clears unrelated audience fields', async () => {
    requestApi.mockResolvedValue(page([])); const value = context(); render(<AdminContext.Provider value={value}><AnnouncementsPage params={new URLSearchParams()} /></AdminContext.Provider>);
    fireEvent.change(screen.getByLabelText('公告标题'), { target: { value: '维护公告' } }); fireEvent.change(screen.getByLabelText('公告正文'), { target: { value: '今晚维护，请保存草稿。' } }); fireEvent.change(screen.getByLabelText('发送对象'), { target: { value: 'users' } }); fireEvent.change(screen.getByLabelText('账号 ID 名单'), { target: { value: 'u1,u2 u1' } }); fireEvent.click(screen.getByRole('button', { name: '预览公告发送' }));
    expect(value.openAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'announcement.create', parameters: { kind: 'announcement', title: '维护公告', body: '今晚维护，请保存草稿。', audience: 'users', userIds: ['u1', 'u2'], groupId: '', publishAt: null } }));
    fireEvent.change(screen.getByLabelText('发送对象'), { target: { value: 'group' } }); fireEvent.change(screen.getByLabelText('群 ID'), { target: { value: 'g1' } }); fireEvent.click(screen.getByRole('button', { name: '预览公告发送' })); expect(value.openAction).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ audience: 'group', userIds: [], groupId: 'g1' }) }));
    fireEvent.click(screen.getByLabelText('定时发布')); fireEvent.change(screen.getByLabelText('计划发布时间'), { target: { value: '2000-01-01T12:00' } }); fireEvent.click(screen.getByRole('button', { name: '预览公告发送' })); expect(screen.getByRole('alert')).toHaveTextContent('未来 30 天'); expect(value.openAction).toHaveBeenCalledTimes(2);
  });
  it('passes typed export budgets and private filters without persisting them', () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const value = context(); render(<AdminContext.Provider value={value}><ExportForm /></AdminContext.Provider>);
    fireEvent.change(screen.getByLabelText('正文搜索词'), { target: { value: 'private-filter' } }); fireEvent.click(screen.getByLabelText('包含原文件')); fireEvent.click(screen.getByRole('button', { name: '预览创建导出任务' })); expect(value.openAction).toHaveBeenCalledWith(expect.objectContaining({ parameters: { kind: 'content', filters: { query: 'private-filter' }, maxRows: 1000, maxBytes: 104857600, includeFiles: true } })); expect(window.location.href).not.toContain('private-filter'); expect(storage).not.toHaveBeenCalled();
  });
  it('shows the actual last-admin refusal before reauthentication', async () => {
    requestApi.mockImplementation(async (path) => { if (path.includes('/administrators')) return { administrators: page([{ user, status: 'active', usable: true, hasSecondFactor: true, sessionCount: 1, lastSeenAt: 1, version: 1 }]), invitations: [] }; if (path.endsWith('/preview')) throw new APIError(409, { code: 'LAST_ADMIN', message: '最后一位可用管理员不能撤权' }); throw new Error(path); }); window.history.replaceState({}, '', '/admin/administrators'); render(<AdminShell user={user} onSignOut={vi.fn()} signOutBusy={false} signOutError="" />);
    fireEvent.click(await screen.findByRole('button', { name: '撤销管理权限' })); fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '核实管理员调整' } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); await screen.findByText('最后一位可用管理员不能撤权'); expect(requestApi.mock.calls.some(([path]) => path.endsWith('/reauth'))).toBe(false); expect(screen.getByRole('link', { name: '1 个设备会话' })).toHaveAttribute('href', '/admin/sessions?userId=admin');
  });
  it('distinguishes accepted task from a completed command receipt', async () => {
    requestApi.mockImplementation(async (path) => { if (path.endsWith('/preview')) return { operationId: 'cmd', targetCount: 1, targets: [], impacts: ['创建持久任务'], reason: '执行备份', expiresAt: Date.now() + 60000 }; if (path.endsWith('/reauth')) return { reauthToken: 'token' }; return { operationId: 'cmd', status: 'completed', total: 1, succeeded: 1, failed: 0, pending: 0, items: [], secretAvailable: false }; });
    render(<AdminActionDialog request={{ action: 'backup.create', targetIds: ['instance'], labels: ['实例'], parameters: {} }} onClose={vi.fn()} onChanged={vi.fn()} />); fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '执行备份' } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); await screen.findByRole('heading', { name: '服务端操作预览' }); fireEvent.change(screen.getByLabelText('管理员当前密码'), { target: { value: 'secret' } }); fireEvent.click(screen.getByRole('button', { name: '验证身份并执行' })); await screen.findByText(/此处是命令处理回执/); expect(screen.queryByText('备份已完成')).not.toBeInTheDocument();
  });
  it('filters audit requests and paginates using the server cursor', async () => {
    requestApi.mockResolvedValue(page([], 'opaque-next')); render(<AuditPage />); await screen.findByRole('button', { name: '下一页记录' }); fireEvent.change(screen.getByLabelText('发起账号 ID'), { target: { value: 'a/b' } }); fireEvent.change(screen.getByLabelText('请求 ID'), { target: { value: 'req1' } }); fireEvent.click(screen.getByRole('button', { name: '筛选记录' })); await waitFor(() => expect(requestApi.mock.lastCall?.[0]).toContain('actorId=a%2Fb')); fireEvent.click(await screen.findByRole('button', { name: '下一页记录' })); await waitFor(() => expect(requestApi.mock.lastCall?.[0]).toContain('after=opaque-next')); expect(window.location.search).toBe('');
  });
});

describe('S3 export form contract alignment', () => {
  it.each([
    ['content', { query: '内容', conversationId: 'c1', senderId: 'u1', kind: 'direct', status: 'sent' }],
    ['files', { query: '文件', conversationId: 'c1', ownerId: 'u2', kind: 'file', governance: 'available', state: 'ready' }],
    ['audit', { actorId: 'a1', subjectId: 'u1', action: 'user.ban', result: 'success', requestId: 'r1', jobId: 'j1' }],
  ] as const)('submits only supported %s filters from actual form controls', (kind, expectedFilters) => {
    const value = context(); render(<AdminContext.Provider value={value}><ExportForm /></AdminContext.Provider>);
    fireEvent.change(screen.getByLabelText('导出类型'), { target: { value: kind } });
    const form = screen.getByRole('button', { name: '预览创建导出任务' }).closest('form')!;
    const filterNames = [...new FormData(form).keys()].filter((key) => key.startsWith('filter:')).map((key) => key.slice(7));
    expect(filterNames.sort()).toEqual([...Object.keys(expectedFilters), 'fromAt', 'until'].sort());
    for (const [name, value] of Object.entries(expectedFilters)) fireEvent.change(form.querySelector(`[name="filter:${name}"]`)!, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '预览创建导出任务' }));
    expect(value.openAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'export.create', parameters: { kind, filters: expectedFilters, maxRows: 1000, maxBytes: 104857600, includeFiles: false } }));
  });
  it('removes a checked file option when switching to audit and does not restore it on return', () => {
    const value = context(); render(<AdminContext.Provider value={value}><ExportForm /></AdminContext.Provider>);
    fireEvent.click(screen.getByLabelText('包含原文件'));
    fireEvent.change(screen.getByLabelText('导出类型'), { target: { value: 'audit' } });
    const form = screen.getByRole('button', { name: '预览创建导出任务' }).closest('form')!;
    expect(screen.queryByLabelText('包含原文件')).not.toBeInTheDocument(); expect(new FormData(form).has('includeFiles')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '预览创建导出任务' }));
    expect(value.openAction).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ kind: 'audit', includeFiles: false }) }));
    fireEvent.change(screen.getByLabelText('导出类型'), { target: { value: 'files' } }); expect(screen.getByLabelText('包含原文件')).not.toBeChecked();
    expect(screen.queryByLabelText('内容状态')).not.toBeInTheDocument(); expect(screen.getByLabelText('文件处理状态')).toBeInTheDocument();
  });
  it('blocks a 1023-byte budget and accepts the exact 1024-byte minimum', () => {
    const value = context(); render(<AdminContext.Provider value={value}><ExportForm /></AdminContext.Provider>);
    const input = screen.getByLabelText('最大归档字节数') as HTMLInputElement;
    expect(input).toHaveAttribute('min', '1024'); fireEvent.change(input, { target: { value: '1023' } }); expect(input.validity.rangeUnderflow).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '预览创建导出任务' })); expect(value.openAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1024' } }); expect(input.validity.rangeUnderflow).toBe(false); fireEvent.click(screen.getByRole('button', { name: '预览创建导出任务' }));
    expect(value.openAction).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ maxBytes: 1024 }) }));
  });
});

describe('S3 live tasks and scoped downloads', () => {
  it('waits 5 seconds after completion, avoids overlap, pauses hidden, retains nodes and stale data', async () => {
    vi.useFakeTimers(); const pending = deferred<ReturnType<typeof page<AdminOperation>>>(); let reads = 0;
    requestApi.mockImplementation(async (path) => { if (path.includes('/jobs')) return page([]); reads++; if (reads === 1) return pending.promise; if (reads === 3) throw new APIError(0, { message: '临时断线' }); return page([{ ...operation, progress: 4 }]); });
    render(<OperationsPage />); await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); expect(reads).toBe(1); await act(async () => { pending.resolve(page([operation])); }); const row = screen.getByText('正在逐文件校验').closest('tr');
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); }); expect(reads).toBe(1); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(reads).toBe(2); expect(screen.getByText('正在逐文件校验').closest('tr')).toBe(row);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange')); await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); expect(reads).toBe(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); fireEvent(document, new Event('visibilitychange')); await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(reads).toBe(3); expect(screen.getByRole('alert')).toHaveTextContent('仍显示旧数据，上次成功读取'); expect(screen.getByText('正在逐文件校验').closest('tr')).toBe(row);
  });
  it('clears admin page on expired authority', async () => {
    requestApi.mockRejectedValue(new APIError(403, { code: 'FORBIDDEN', message: '权限失效' })); window.history.replaceState({}, '', '/admin/operations'); render(<AdminShell user={user} onSignOut={vi.fn()} signOutBusy={false} signOutError="" />); await screen.findByRole('heading', { name: '管理权限已失效' }); expect(screen.queryByRole('heading', { name: '受控导出' })).not.toBeInTheDocument();
  });
});

describe('S3 operation download error and timeout boundaries', () => {
  it('reauthenticates backup action with reason, and aborts a late Blob on close', async () => {
    requestApi.mockResolvedValue({ reauthToken: 'private-token' }); const pending = deferred<Blob>(); requestBlob.mockReturnValue(pending.promise); const { unmount } = render(<OperationDownload operation={{ ...operation, status: 'completed', canDownload: true }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('下载理由'), { target: { value: '核实完整备份' } }); fireEvent.change(screen.getByLabelText('下载验证密码'), { target: { value: 'secret' } }); fireEvent.click(screen.getByRole('button', { name: '验证并下载归档' })); await waitFor(() => expect(requestBlob).toHaveBeenCalled()); expect(requestApi.mock.calls[0][1]?.body).toEqual({ password: 'secret', action: 'backup.download:op-one' }); expect(requestBlob.mock.calls[0][1]).toMatchObject({ body: { reason: '核实完整备份', reauthToken: 'private-token' }, timeoutMs: 600000 }); expect(screen.getByText(/最多等待 10 分钟/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: '取消读取并关闭' })).toBeEnabled(); const signal = requestBlob.mock.calls[0][1].signal!; unmount(); expect(signal.aborted).toBe(true); await act(async () => { pending.resolve(new Blob(['late-private'])); }); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it.each([
    [403, 'ARTIFACT_UNAVAILABLE', '归档已到期或不是当前创建会话'],
    [403, 'DOWNLOAD_SESSION_MISMATCH', '仅原会话可下载'],
    [409, 'EXPORT_CHANGED', '导出内容已改变，请重新创建任务'],
  ] as const)('keeps artifact error %s %s local without removing admin access', async (status, code, message) => {
    const value = context(); requestBlob.mockRejectedValue(new APIError(status as number, { code: code as string, message: message as string })); render(<AdminContext.Provider value={value}><OperationDownload operation={{ ...operation, kind: 'export.create', status: 'completed', canDownload: true }} onClose={vi.fn()} /></AdminContext.Provider>); fireEvent.change(screen.getByLabelText('下载理由'), { target: { value: '核实导出结果' } }); fireEvent.click(screen.getByRole('button', { name: '验证并下载归档' })); await screen.findByText(message); expect(value.deny).not.toHaveBeenCalled(); expect(screen.getByRole('dialog', { name: '下载受控导出' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: '验证并下载归档' })).toBeEnabled(); expect(requestApi).not.toHaveBeenCalled(); expect(requestBlob.mock.calls[0][1]).toMatchObject({ timeoutMs: 600000 }); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it.each([[401, 'AUTH_REQUIRED'], [401, 'SESSION_REVOKED'], [403, 'FORBIDDEN']] as const)('denies admin access for true identity error %s %s', async (status, code) => {
    const value = context(); requestBlob.mockRejectedValue(new APIError(status, { code, message: '身份或权限已失效' })); render(<AdminContext.Provider value={value}><OperationDownload operation={{ ...operation, kind: 'export.create', status: 'completed', canDownload: true }} onClose={vi.fn()} /></AdminContext.Provider>); fireEvent.change(screen.getByLabelText('下载理由'), { target: { value: '核实导出结果' } }); fireEvent.click(screen.getByRole('button', { name: '验证并下载归档' })); await waitFor(() => expect(value.deny).toHaveBeenCalledTimes(1)); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('allows reauthentication retry without retaining previous password or factor', async () => {
    const value = context(); requestApi.mockRejectedValueOnce(new APIError(403, { code: 'REAUTH_FAILED', message: '密码错误，请重试' })).mockResolvedValueOnce({ reauthToken: 'new-token' }); requestBlob.mockRejectedValue(new APIError(403, { code: 'ARTIFACT_UNAVAILABLE', message: '归档不可用' })); render(<AdminContext.Provider value={value}><OperationDownload operation={{ ...operation, status: 'completed', canDownload: true }} onClose={vi.fn()} /></AdminContext.Provider>);
    fireEvent.change(screen.getByLabelText('下载理由'), { target: { value: '核实完整备份' } }); fireEvent.change(screen.getByLabelText('下载验证密码'), { target: { value: 'old-password' } }); fireEvent.click(screen.getByRole('button', { name: '验证并下载归档' })); await screen.findByText('密码错误，请重试'); expect(value.deny).not.toHaveBeenCalled(); expect(requestBlob).not.toHaveBeenCalled(); expect(screen.getByLabelText('下载验证密码')).toHaveValue(''); expect(screen.queryByLabelText('下载动态码或第二因素恢复码')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('下载验证密码'), { target: { value: 'new-password' } }); fireEvent.click(screen.getByRole('button', { name: '验证并下载归档' })); await screen.findByText('归档不可用'); expect(requestApi).toHaveBeenCalledTimes(2); expect(requestBlob.mock.calls[0][1]).toMatchObject({ body: { reason: '核实完整备份', reauthToken: 'new-token' }, timeoutMs: 600000 }); expect(value.deny).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('reports browser handoff without claiming saved file completion and revokes the URL on unmount', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); requestBlob.mockResolvedValue(new Blob(['archive'])); const view = render(<OperationDownload operation={{ ...operation, kind: 'export.create', status: 'completed', canDownload: true }} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText('下载理由'), { target: { value: '核实导出结果' } }); fireEvent.click(screen.getByRole('button', { name: '验证并下载归档' })); await screen.findByText('归档已交给浏览器下载，请在浏览器中核对保存结果。'); expect(click).toHaveBeenCalledTimes(1); expect(screen.queryByText(/已保存到本机|保存成功/)).not.toBeInTheDocument(); view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-test');
  });
});
