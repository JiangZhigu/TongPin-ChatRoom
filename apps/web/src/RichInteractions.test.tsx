// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MessageActions } from './MessageActions';
import { MessageSearchPage } from './MessageSearchPage';
import { ReportDialog } from './ReportDialog';
import { ReportsPage } from './ReportsPage';
import { AccountSettings } from './AccountSettings';
import { AccountDeletion } from './AccountDeletion';
import { NotificationsPage } from './NotificationsPage';
import { Composer, emptyComposerContext } from './components/Composer';
import type { Message } from './lib/chat-types';
import type { MessageUpdateToken } from './lib/chat-client';
const defaultUpdateToken: MessageUpdateToken = { generation: 1, contentRevision: 0 };
import type { UserView } from './auth-types';
import { APIError } from './lib/api';
const request = vi.hoisted(() => vi.fn());
vi.mock('./lib/api', async (original) => ({ ...await original<typeof import('./lib/api')>(), api: request }));
const user: UserView = { id: 'self', username: 'self_user', nickname: '本人', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const message: Message = { id: 'm1', conversationId: 'c1', seq: '1', senderId: user.id, sender: user, clientMessageId: null, kind: 'user', text: '可搜索的消息', status: 'sent', createdAt: 1, replyToMessageId: null, reply: null, mentionedUserIds: [], attachments: [], reactions: [], capabilities: { canInteract: true, canRecall: true, canModerate: true } };
const report = { id: 'r1', targetKind: 'message', targetId: 'm1', category: 'spam', description: '', status: 'open', createdAt: 1, updatedAt: 1, feedback: null };
beforeEach(() => { request.mockReset(); HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); }; }); afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
describe('M7-UI rich interactions', () => {
  it('uses complete encoded reaction IDs and applies server response, without optimistic mutation', async () => { const update = vi.fn(); let finish!: (data: unknown) => void; request.mockImplementation(() => new Promise((resolve) => { finish = resolve; })); render(<MessageActions onBeginUpdate={() => defaultUpdateToken} onBookmarked={vi.fn()} message={message} userId={user.id} onUpdated={update} onReply={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '👍' })); expect(request).toHaveBeenCalledWith('/api/v1/messages/m1/reactions/1F44D', { method: 'PUT', body: {} }); expect(update).not.toHaveBeenCalled(); await act(async () => finish({ message: { ...message, reactions: [{ key: '👍', count: 1, mine: true }] } })); expect(update).toHaveBeenCalledWith(expect.objectContaining({ reactions: [{ key: '👍', count: 1, mine: true }] }), defaultUpdateToken); });
  it('requires a reason for moderation and removes all interaction buttons on tombstones', async () => { request.mockResolvedValue({ message: { ...message, status: 'moderated', text: '' } }); const update = vi.fn(); const view = render(<MessageActions onBeginUpdate={() => defaultUpdateToken} onBookmarked={vi.fn()} message={message} userId={user.id} onUpdated={update} onReply={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '管理删除' })); expect(screen.getByRole('button', { name: '确认' })).toBeDisabled(); fireEvent.change(screen.getByLabelText('管理删除原因'), { target: { value: '违反群规则' } }); fireEvent.click(screen.getByRole('button', { name: '确认' })); await waitFor(() => expect(request).toHaveBeenCalledWith('/api/v1/messages/m1/moderate', { method: 'POST', body: { reason: '违反群规则' } })); view.rerender(<MessageActions onBeginUpdate={() => defaultUpdateToken} onBookmarked={vi.fn()} message={{ ...message, status: 'moderated', text: '' }} userId={user.id} onUpdated={update} onReply={vi.fn()} />); expect(screen.queryByRole('button', { name: '引用回复' })).not.toBeInTheDocument(); });
  it('does not offer server-disallowed send actions and reports API rejection', async () => { request.mockRejectedValue(new APIError(403, { message: '当前权限不允许收藏' })); render(<MessageActions onBeginUpdate={() => defaultUpdateToken} onBookmarked={vi.fn()} message={{ ...message, capabilities: { canInteract: false, canRecall: false, canModerate: false } }} userId={user.id} onUpdated={vi.fn()} onReply={vi.fn()} />); expect(screen.queryByRole('button', { name: '引用回复' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '收藏' })); expect(await screen.findByText('当前权限不允许收藏')).toBeInTheDocument(); });
  it('retries an uncertain report with exactly the original UUID and locked payload', async () => { request.mockRejectedValueOnce(new APIError(0, { message: '连接中断' })).mockResolvedValueOnce({ report }); render(<ReportDialog target={{ kind: 'message', id: 'm1', label: '这条消息' }} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText('情况说明'), { target: { value: '说明' } }); fireEvent.click(screen.getByRole('button', { name: '提交举报' })); await screen.findByText('连接中断'); const first = request.mock.calls[0][1].body; expect(first.clientReportId).toMatch(/^[\da-f-]{36}$/); expect(screen.getByLabelText('情况说明')).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '重试同一份举报' })); await screen.findByText(/举报已提交/); expect(request.mock.calls[1][1].body).toEqual(first); });
  it('allows report correction after a definite validation rejection', async () => { request.mockRejectedValueOnce(new APIError(422, { message: '说明不符合要求' })); render(<ReportDialog target={{ kind: 'user', id: 'u1', label: '用户' }} onClose={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '提交举报' })); await screen.findByText('说明不符合要求'); expect(screen.getByLabelText('情况说明')).toBeEnabled(); });
  it('searches escaped terms, paginates stable submitted criteria and jumps to the result ID', async () => { request.mockResolvedValueOnce({ items: [{ id: 'm1', available: true, message, conversation: { id: 'c1', title: '群聊', kind: 'group' } }], nextCursor: 'cursor1' }).mockResolvedValueOnce({ items: [], nextCursor: null }); const jump = vi.fn(async () => undefined); render(<MessageSearchPage conversations={[]} onJump={jump} onClose={vi.fn()} />); fireEvent.change(screen.getByLabelText('消息关键词'), { target: { value: '中文%_' } }); fireEvent.click(screen.getByRole('button', { name: '搜索' })); await screen.findByText('可搜索的消息'); expect(request.mock.calls[0][0]).toContain('q=%E4%B8%AD%E6%96%87%25_'); fireEvent.change(screen.getByLabelText('消息关键词'), { target: { value: '新输入' } }); fireEvent.click(screen.getByRole('button', { name: '加载更多结果' })); await waitFor(() => expect(request).toHaveBeenCalledTimes(2)); expect(request.mock.calls[1][0]).toContain('q=%E4%B8%AD%E6%96%87%25_'); await waitFor(() => expect(screen.getByRole('button', { name: '定位消息' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: '定位消息' })); await waitFor(() => expect(jump).toHaveBeenCalledWith('m1')); });
  it('does not expose unavailable bookmark content and permits removal', async () => { request.mockResolvedValueOnce({ items: [{ id: 'hidden', available: false, message: null, conversation: null }], nextCursor: null }).mockResolvedValueOnce({ bookmarked: false }); render(<MessageSearchPage conversations={[]} onJump={vi.fn()} onClose={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '我的收藏' })); await screen.findByText('消息不可用'); expect(screen.getByRole('button', { name: '定位消息' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '移除收藏' })); await waitFor(() => expect(screen.queryByText('消息不可用')).not.toBeInTheDocument()); expect(request.mock.calls[1]).toEqual(['/api/v1/messages/hidden/bookmark', { method: 'DELETE', body: {} }]); });
  it('shows report feedback and followup page entries', async () => { request.mockResolvedValue({ items: [{ ...report, status: 'resolved', feedback: '已处理相关内容' }], nextCursor: null }); render(<ReportsPage onClose={vi.fn()} />); expect(await screen.findByText('处理反馈：已处理相关内容')).toBeInTheDocument(); });
  it('blocks deletion for owners and the last administrator using live preview', async () => { request.mockResolvedValue({ coolingDays: 30, ownedGroups: [{ id: 'g1', name: '本人群聊', status: 'frozen' }], lastAdministrator: true, sharedMessagesRetained: true }); render(<AccountDeletion user={user} onClose={vi.fn()} onDeleted={vi.fn()} />); await screen.findByText('本人群聊（已冻结）'); expect(screen.getByRole('button', { name: '验证身份并注销账号' })).toBeDisabled(); expect(request).toHaveBeenCalledTimes(1); });
  it('retains local data after a failed delete, then calls local cleanup only after confirmed deletion', async () => { request.mockResolvedValueOnce({ coolingDays: 30, ownedGroups: [], lastAdministrator: false, sharedMessagesRetained: true }).mockResolvedValueOnce({ reauthToken: 'proof1' }).mockRejectedValueOnce(new APIError(409, { message: '服务暂不可用' })).mockResolvedValueOnce({ reauthToken: 'proof2' }).mockResolvedValueOnce({ deleted: true, recoverBefore: 100 }); const deleted = vi.fn(async () => undefined); render(<AccountDeletion user={user} onClose={vi.fn()} onDeleted={deleted} />); const password = await screen.findByLabelText('当前密码'); fireEvent.change(password, { target: { value: 'current-password' } }); fireEvent.change(screen.getByLabelText('输入登录名 self_user 确认注销'), { target: { value: 'self_user' } }); fireEvent.change(screen.getByLabelText('本机内容处理'), { target: { value: 'delete' } }); fireEvent.click(screen.getByRole('button', { name: '验证身份并注销账号' })); await screen.findByText('服务暂不可用'); expect(deleted).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '验证身份并注销账号' })); await waitFor(() => expect(deleted).toHaveBeenCalledWith('delete')); expect(request.mock.calls[1][1].body.action).toBe('account.delete'); });
  it('opens available mentions by ID and leaves inaccessible mentions disabled', async () => { const jump = vi.fn(async () => undefined); const base = { type: 'message.mentioned', entityRef: 'm1', createdAt: 1, readAt: 1, text: '有人提及你' }; render(<NotificationsPage items={[{ ...base, id: 'n1', messageId: 'm1', available: true }, { ...base, id: 'n2', messageId: 'm2', available: false }]} hasMore={false} onLoadMore={vi.fn()} onRefresh={vi.fn()} onOpenRequests={vi.fn()} onOpenMessage={jump} />); const buttons = screen.getAllByRole('button', { name: '查看提及消息' }); expect(buttons[1]).toBeDisabled(); fireEvent.click(buttons[0]); await waitFor(() => expect(jump).toHaveBeenCalledWith('m1')); });
  it('loads paginated members and offers all-member mentions only to managers', async () => { request.mockResolvedValue({ items: [{ user: { id: 'u2', nickname: '群成员', username: 'member' }, role: 'member', periodId: 'p2', joinedAt: 1, mutedUntil: null }], nextCursor: 'next' }); const change = vi.fn(); render(<Composer value="文字" onChange={vi.fn()} onSend={vi.fn()} userId="self" conversationId="c1" groupRole="member" context={emptyComposerContext()} onContextChange={change} />); fireEvent.click(screen.getByRole('button', { name: '@ 提及成员' })); fireEvent.click(await screen.findByRole('button', { name: '群成员 (@member)' })); expect(change).toHaveBeenCalledWith({ replyToMessageId: null, mentionedUserIds: ['u2'], mentionAll: false }); expect(screen.queryByRole('button', { name: '@全体成员' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: '加载更多成员' })).toBeEnabled(); });
});


describe('M7-UI notification consent and deletion shutdown', () => {
  it('requests browser permission only from an explicit click and displays denied fallback', async () => {
    const permission = vi.fn(async () => { Object.defineProperty(FakeNotification, 'permission', { value: 'denied', configurable: true }); return 'denied'; });
    class FakeNotification { static permission = 'default'; static requestPermission = permission; }
    vi.stubGlobal('Notification', FakeNotification); request.mockResolvedValue({ items: [] }); render(<AccountSettings user={user} onUserChange={vi.fn()} onSignedOut={vi.fn()} />);
    expect(permission).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('tab', { name: '浏览器通知' })); fireEvent.click(screen.getByRole('button', { name: '开启浏览器通知' })); await screen.findByText(/浏览器已拒绝通知权限/); expect(permission).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: '开启浏览器通知' })).toBeDisabled();
  });
  it('pauses before reauth, resumes on server failure, and does not repeat server deletion after local cleanup fails', async () => {
    request.mockResolvedValueOnce({ coolingDays: 30, ownedGroups: [], lastAdministrator: false, sharedMessagesRetained: true }).mockRejectedValueOnce(new APIError(422, { message: '验证失败' })).mockResolvedValueOnce({ reauthToken: 'proof' }).mockResolvedValueOnce({ deleted: true, recoverBefore: 100 });
    const pause = vi.fn(async () => undefined); const resume = vi.fn(); const finish = vi.fn().mockRejectedValueOnce(new Error('本机清理失败')).mockResolvedValue(undefined);
    render(<AccountDeletion user={user} onClose={vi.fn()} onDeleted={finish} onBeforeDelete={pause} onDeleteFailed={resume} />); fireEvent.change(await screen.findByLabelText('当前密码'), { target: { value: 'secret' } }); fireEvent.change(screen.getByLabelText('输入登录名 self_user 确认注销'), { target: { value: 'self_user' } }); fireEvent.change(screen.getByLabelText('本机内容处理'), { target: { value: 'delete' } });
    fireEvent.click(screen.getByRole('button', { name: '验证身份并注销账号' })); await screen.findByText('验证失败'); expect(pause).toHaveBeenCalledOnce(); expect(resume).toHaveBeenCalledOnce(); expect(pause.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]);
    fireEvent.click(screen.getByRole('button', { name: '验证身份并注销账号' })); await screen.findByText('本机清理失败'); expect(resume).toHaveBeenCalledOnce(); const calls = request.mock.calls.length; fireEvent.click(screen.getByRole('button', { name: '重试完成本机处理' })); await waitFor(() => expect(finish).toHaveBeenCalledTimes(2)); expect(request).toHaveBeenCalledTimes(calls); expect(pause).toHaveBeenCalledTimes(2);
  });
});

describe('M7-UI deletion receipt recovery', () => {
  async function fillDeletion() { fireEvent.change(await screen.findByLabelText('当前密码'), { target: { value: 'secret' } }); fireEvent.change(screen.getByLabelText('输入登录名 self_user 确认注销'), { target: { value: 'self_user' } }); fireEvent.change(screen.getByLabelText('本机内容处理'), { target: { value: 'delete' } }); fireEvent.click(screen.getByRole('button', { name: '验证身份并注销账号' })); }
  it('retains the original receipt body after an unknown response and cleans local data only after receipt confirmation', async () => {
    request.mockResolvedValueOnce({ coolingDays: 30, ownedGroups: [], lastAdministrator: false, sharedMessagesRetained: true }).mockResolvedValueOnce({ reauthToken: 'original-proof' }).mockRejectedValueOnce(new APIError(0, { message: '响应丢失' })).mockResolvedValueOnce({ deleted: true, recoverBefore: 100 });
    const finish = vi.fn(async () => undefined), pause = vi.fn(async () => undefined), resume = vi.fn(); render(<AccountDeletion user={user} onClose={vi.fn()} onDeleted={finish} onBeforeDelete={pause} onDeleteFailed={resume} />); await fillDeletion(); await screen.findByText('响应丢失'); expect(finish).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(screen.getByLabelText('本机内容处理')).toBeDisabled(); expect(screen.queryByRole('button', { name: '关闭对话框' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '核对注销结果' })); await waitFor(() => expect(finish).toHaveBeenCalledWith('delete')); expect(request.mock.calls[3]).toEqual(request.mock.calls[2]); expect(pause).toHaveBeenCalledOnce(); expect(request.mock.calls.filter(([path]) => path === '/api/v1/auth/reauth')).toHaveLength(1);
  });
  it('preserves data on expired receipt and offers a separate keep-and-login path', async () => {
    request.mockResolvedValueOnce({ coolingDays: 30, ownedGroups: [], lastAdministrator: false, sharedMessagesRetained: true }).mockResolvedValueOnce({ reauthToken: 'proof' }).mockRejectedValueOnce(new APIError(0, { message: '响应未知' })).mockRejectedValueOnce(new APIError(403, { message: '回执失效' }));
    const finish = vi.fn(), preserve = vi.fn(async () => undefined), resume = vi.fn(); render(<AccountDeletion user={user} onClose={vi.fn()} onDeleted={finish} onDeleteFailed={resume} onPreserveAndSignOut={preserve} />); await fillDeletion(); await screen.findByText('响应未知'); fireEvent.click(screen.getByRole('button', { name: '核对注销结果' })); await screen.findByText('回执失效'); expect(finish).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '核对注销结果' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '保留本机内容并返回登录' })); await waitFor(() => expect(preserve).toHaveBeenCalledOnce());
  });
});


describe('M7-FIX-UI message update tokens', () => {
  it.each(['reaction', 'recall', 'moderate'] as const)('captures the original token before %s dispatch and carries it after a tombstone rerender', async (action) => {
    const token = Object.freeze({ generation: 3, contentRevision: 7 }); const newer = Object.freeze({ generation: 4, contentRevision: 9 }); const order: string[] = [];
    const begin = vi.fn<() => MessageUpdateToken>(() => { order.push('begin'); return token; }); const update = vi.fn<(message: Message, token: MessageUpdateToken) => Promise<void>>(async () => undefined); const bookmark = vi.fn(); let finish!: (data: unknown) => void;
    request.mockImplementation(() => { order.push('request'); return new Promise((resolve) => { finish = resolve; }); });
    const view = render(<MessageActions message={message} userId={user.id} onBeginUpdate={begin} onBookmarked={bookmark} onUpdated={update} onReply={vi.fn()} />);
    if (action === 'reaction') fireEvent.click(screen.getByRole('button', { name: '👍' })); else { fireEvent.click(screen.getByRole('button', { name: action === 'recall' ? '撤回' : '管理删除' })); if (action === 'moderate') fireEvent.change(screen.getByLabelText('管理删除原因'), { target: { value: '管理原因' } }); fireEvent.click(screen.getByRole('button', { name: '确认' })); }
    const receipt = { ...message, reactions: [{ key: '👍', count: 1, mine: true }] };
    begin.mockImplementation(() => { order.push('late-begin'); return newer; }); view.rerender(<MessageActions message={{ ...message, status: 'recalled', text: '', attachments: [] }} userId={user.id} onBeginUpdate={begin} onBookmarked={bookmark} onUpdated={update} onReply={vi.fn()} />);
    await act(async () => finish({ message: receipt })); expect(order).toEqual(['begin', 'request']); expect(update).toHaveBeenCalledExactlyOnceWith(receipt, token); expect(update.mock.calls[0][1]).toBe(token); expect(bookmark).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: '收藏' })).not.toBeInTheDocument();
  });
  it.each([false, true])('sends bookmark=%s acknowledgement as an ID/boolean patch only after a tombstone arrives', async (previous) => {
    const token = Object.freeze({ generation: 10, contentRevision: 20 }); const order: string[] = []; const begin = vi.fn<() => MessageUpdateToken>(() => { order.push('begin'); return token; }); const update = vi.fn(); const bookmark = vi.fn(); let finish!: (data: unknown) => void;
    request.mockImplementation(() => { order.push('request'); return new Promise((resolve) => { finish = resolve; }); }); const view = render(<MessageActions message={{ ...message, bookmarked: previous }} userId={user.id} onBeginUpdate={begin} onBookmarked={bookmark} onUpdated={update} onReply={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: previous ? '取消收藏' : '收藏' })); view.rerender(<MessageActions message={{ ...message, status: 'moderated', text: '' }} userId={user.id} onBeginUpdate={begin} onBookmarked={bookmark} onUpdated={update} onReply={vi.fn()} />);
    await act(async () => finish({ bookmarked: !previous })); expect(order).toEqual(['begin', 'request']); expect(bookmark).toHaveBeenCalledExactlyOnceWith(message.id, !previous, token); expect(update).not.toHaveBeenCalled(); expect(request.mock.calls[0][1].method).toBe(previous ? 'DELETE' : 'PUT');
  });
});


describe('direct bookmarks page entry', () => {
  it('loads bookmarks immediately, paginates the bookmark cursor and jumps to the saved message', async () => {
    request.mockResolvedValueOnce({ items: [{ id: 'm1', available: true, message, conversation: { id: 'c1', title: '收藏来源群', kind: 'group' } }], nextCursor: 'bookmark-page-2' }).mockResolvedValueOnce({ items: [], nextCursor: null });
    const jump = vi.fn(async () => undefined);
    render(<MessageSearchPage initialMode="bookmarks" conversations={[]} onJump={jump} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '我的收藏' })).toBeInTheDocument();
    expect(screen.queryByLabelText('消息关键词')).not.toBeInTheDocument();
    await screen.findByText('可搜索的消息');
    expect(request.mock.calls[0][0]).toBe('/api/v1/bookmarks?limit=50');
    fireEvent.click(screen.getByRole('button', { name: '加载更多结果' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][0]).toBe('/api/v1/bookmarks?limit=50&after=bookmark-page-2');
    await waitFor(() => expect(screen.getByRole('button', { name: '定位消息' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '定位消息' }));
    await waitFor(() => expect(jump).toHaveBeenCalledWith('m1'));
  });

  it('aborts the initial bookmarks request on unmount and ignores its late content', async () => {
    let resolve!: (page: unknown) => void; request.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<MessageSearchPage initialMode="bookmarks" conversations={[]} onJump={vi.fn()} onClose={vi.fn()} />);
    const signal = request.mock.calls[0][1].signal as AbortSignal;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => resolve({ items: [{ id: 'm1', available: true, message, conversation: { id: 'c1', title: '收藏来源群', kind: 'group' } }], nextCursor: null }));
    expect(screen.queryByText('可搜索的消息')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
});