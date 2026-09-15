// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CreateGroupDialog } from './CreateGroupDialog';
import { GroupManagementPanel } from './GroupManagementPanel';
import { GroupInviteEntry } from './GroupInviteEntry';
import { GroupInbox } from './GroupInbox';
import { NotificationsPage } from './NotificationsPage';
import { setCsrfToken } from './lib/api';
import type { GroupApplication, GroupDetail, GroupInvite, GroupMember, InvitePreview } from './lib/group-types';
import type { Contact } from './lib/chat-types';

const self = { id: 'owner', username: 'owner_name', nickname: '群主甲' }; const friend: Contact = { id: 'friend', username: 'friend_name', nickname: '好友乙', relationship: 'friend', requestId: null, online: false, blocked: false, notifyOnline: false };
const group = (): GroupDetail => ({ conversation: { id: 'group-1', kind: 'group', title: '定向测试群', description: '群简介', peer: null, role: 'owner', periodId: 'owner-period', memberCount: 3, lastSeq: '0', readSeq: '0', peerReadSeq: null, unreadCount: 0, lastMessage: null, canSend: true, sendDisabledReason: null, sendErrorCode: null, accessKey: 'access', updatedAt: 1, preferences: { muted: false, pinned: false, archived: false } }, version: 7, settings: { announcement: '群公告', announcementPinned: true, reviewRequired: true, inviteRole: 'managers', everyoneMuted: false, slowSeconds: 0 }, capabilities: { canEdit: true, canInvite: true, canReview: true, canAssignRoles: true, canTransfer: true, canDissolve: true, canLeave: false }, transfer: null });
const member = (id = friend.id, role: GroupMember['role'] = 'member'): GroupMember => ({ user: id === friend.id ? friend : { id, username: id, nickname: id }, periodId: `${id}-current-period`, role, joinedAt: 1, mutedUntil: null });
const invite = (): GroupInvite => ({ id: 'invite-1', conversationId: 'group-1', groupName: '定向测试群', kind: 'direct', creator: self, target: friend, maxUses: 1, used: 0, reserved: 0, remaining: 1, expiresAt: Date.now() + 100000, createdAt: 1, state: 'available', canRevoke: true });
const application = (): GroupApplication => ({ id: 'application-1', conversationId: 'group-1', groupName: '定向测试群', inviteId: 'invite-1', user: friend, status: 'pending', currentMember: false, expiresAt: Date.now() + 100000, createdAt: 1 });
const preview = (): InvitePreview => ({ inviteId: 'invite-1', conversationId: 'group-1', name: '定向测试群', description: '公开群简介', memberCount: 3, requiresApproval: true, expiresAt: Date.now() + 100000, maxUses: 10, remaining: 10, state: 'available', application: null });
const token = 'group_invitation_token_for_ui_test_12345678901234567890';
const reply = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) });
const reject = (code: string) => Promise.resolve({ ok: false, status: 409, json: async () => ({ error: { code, message: code } }) });
const body = (options?: RequestInit) => JSON.parse(String(options?.body || '{}'));
let current: GroupDetail; let fetched: ReturnType<typeof vi.fn<(url: string, options?: RequestInit) => Promise<unknown>>>; let updates: { url: string; body: Record<string, unknown> }[];
const groupEvents = new Set<(event: { type: string; conversationId?: string | null }) => void>();
const subscribeGroupEvents = (listener: (event: { type: string; conversationId?: string | null }) => void) => { groupEvents.add(listener); return () => { groupEvents.delete(listener); }; };
function remoteUpdate() { act(() => { for (const listener of groupEvents) listener({ type: "conversation.updated", conversationId: "group-1" }); }); }
function manage() { return render(<GroupManagementPanel subscribeGroupEvents={subscribeGroupEvents} conversationId="group-1" userId="owner" friends={[friend]} hasMoreFriends={false} onLoadMoreFriends={async () => {}} onClose={vi.fn()} onRefresh={async () => {}} onLeft={async () => {}} />); }
beforeEach(() => {
  current = group(); updates = []; setCsrfToken('ui-group-csrf');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  fetched = vi.fn((url: string, options: RequestInit = {}) => {
    if (options.method && options.method !== 'GET') { updates.push({ url, body: body(options) }); expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('ui-group-csrf'); }
    if (url === '/api/v1/groups/group-1') return reply(current);
    if (url.endsWith('/members')) return reply({ items: [member('owner', 'owner'), member('peer-admin', 'admin'), member()], nextCursor: null });
    if (url === '/api/v1/auth/reauth') return reply({ reauthToken: 'scoped-reauth-token' });
    if (url.endsWith('/invites') || url.endsWith('/applications') || url.endsWith('/audit')) return reply({ items: [], nextCursor: null });
    return reply({});
  }); vi.stubGlobal('fetch', fetched);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCsrfToken(''); });

describe('M5-UI group creation and management', () => {
  it('retries an uncertain creation with the same UUID and immutable friend selection', async () => {
    let calls = 0; const payloads: Record<string, unknown>[] = []; const created = vi.fn(async () => {});
    fetched.mockImplementation((url: string, options: RequestInit = {}) => { expect(url).toBe('/api/v1/groups'); payloads.push(body(options)); if (++calls === 1) return Promise.reject(new TypeError('网络中断，结果未知')); return reply(group()); });
    render(<CreateGroupDialog friends={[friend]} hasMore={false} onLoadMore={async () => {}} onClose={vi.fn()} onCreated={created} />);
    fireEvent.change(screen.getByLabelText('群名称'), { target: { value: '新群' } }); fireEvent.click(screen.getByRole('checkbox', { name: /好友乙/ })); fireEvent.click(screen.getByRole('button', { name: '创建群聊' }));
    await screen.findByText('连接暂时中断，操作结果尚未确认。请重新连接并确认结果。'); expect(screen.getByLabelText('群名称')).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '重试并确认创建结果' }));
    await waitFor(() => expect(created).toHaveBeenCalledWith('group-1')); expect(payloads).toHaveLength(2); expect(payloads[0]).toEqual(payloads[1]); expect(payloads[0].friendUserIds).toEqual(['friend']); expect(payloads[0].clientRequestId).toMatch(/^[\da-f-]{36}$/i);
  });
  it('limits admin targets and sends the visible current member period and version', async () => {
    current.conversation.role = 'admin'; current.capabilities.canAssignRoles = false; current.capabilities.canTransfer = false; current.capabilities.canDissolve = false; current.capabilities.canLeave = true;
    manage(); fireEvent.click(await screen.findByRole('button', { name: '成员' })); await screen.findByText('@friend_name');
    const peerRow = screen.getByText('@peer-admin').closest('li')!; expect(within(peerRow).queryByRole('button')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '设为管理员' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '禁言 1 小时' })); await waitFor(() => expect(updates).toHaveLength(1)); expect(updates[0]).toMatchObject({ url: '/api/v1/groups/group-1/members/friend', body: { expectedVersion: 7, periodId: 'friend-current-period' } });
  });
  it('uses expectedVersion for settings and requires explicit refresh after conflict', async () => {
    const baseFetch = fetched.getMockImplementation()!; fetched.mockImplementation((url: string, options: RequestInit = {}) => options.method === 'PATCH' ? (updates.push({ url, body: body(options) }), reject('VERSION_CONFLICT')) : baseFetch(url, options));
    manage(); await screen.findByLabelText('群名称'); fireEvent.change(screen.getByLabelText('慢速模式（秒，0 表示关闭）'), { target: { value: '30' } }); fireEvent.click(screen.getByRole('button', { name: '保存群资料与策略' }));
    await screen.findByText(/群状态已变化/); expect(updates[0].body).toMatchObject({ expectedVersion: 7, slowSeconds: 30 }); expect(screen.getByRole('button', { name: '保存群资料与策略' })).toBeDisabled(); expect(updates).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '刷新群详情' })); await waitFor(() => expect(screen.getByRole('button', { name: '保存群资料与策略' })).toBeEnabled()); expect(updates).toHaveLength(1);
  });
  it('does not expose owner controls to a regular member', async () => {
    current.conversation.role = 'member'; current.capabilities = { canEdit: false, canInvite: false, canReview: false, canAssignRoles: false, canTransfer: false, canDissolve: false, canLeave: true };
    manage(); await screen.findByText('你当前没有编辑群资料的权限。'); expect(screen.queryByRole('button', { name: '入群审核' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '解散群聊' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: '退出群聊' })).toBeEnabled();
  });
  it('scopes reauthentication and ownership transfer to exact target period without optimistic role changes', async () => {
    manage(); fireEvent.click(await screen.findByRole('button', { name: '成员' })); await screen.findByText('@friend_name'); fireEvent.click(within(screen.getByText('@friend_name').closest('li')!).getByRole('button', { name: '转让群主' }));
    const dialog = screen.getByRole('dialog', { name: '转让群主 · 再次验证' }); fireEvent.change(within(dialog).getByLabelText('当前密码'), { target: { value: 'test-only-password' } }); fireEvent.click(within(dialog).getByRole('checkbox')); fireEvent.click(within(dialog).getByRole('button', { name: '确认并继续' }));
    await screen.findByText('转让邀请已发出，受让者接受之前，你仍是群主。'); expect(updates[0]).toEqual({ url: '/api/v1/auth/reauth', body: { password: 'test-only-password', action: 'group_transfer:group-1' } }); expect(updates[1]).toMatchObject({ url: '/api/v1/groups/group-1/transfers', body: { expectedVersion: 7, targetUserId: 'friend', targetPeriodId: 'friend-current-period', reauthToken: 'scoped-reauth-token' } }); expect(current.conversation.role).toBe('owner');
  });
  it('clears sensitive inputs after cancelling dissolution and requires consequence confirmation', async () => {
    manage(); fireEvent.click(await screen.findByRole('button', { name: '解散群聊' })); fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'never-retain' } }); expect(screen.getByRole('button', { name: '确认并继续' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '取消操作' }));
    fireEvent.click(screen.getByRole('button', { name: '解散群聊' })); expect(screen.getByLabelText('当前密码')).toHaveValue(''); expect(screen.getByRole('checkbox', { name: '我已了解并确认上述后果' })).not.toBeChecked(); expect(updates).toHaveLength(0);
  });
  it('does not claim copied link when an idempotent invite response has no token', async () => {
    const baseFetch = fetched.getMockImplementation()!; fetched.mockImplementation((url: string, options: RequestInit = {}) => url.endsWith('/invites') && options.method === 'POST' ? reply({ invite: invite(), token: null }) : baseFetch(url, options));
    manage(); fireEvent.click(await screen.findByRole('button', { name: '邀请' })); fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));
    await screen.findByText('邀请已存在，但重试不能再次获取完整链接。可撤销旧邀请后新建。'); expect(screen.queryByRole('button', { name: '复制邀请链接' })).not.toBeInTheDocument();
  });
  it('saves the draft before leaving and never sends leave if that preservation fails', async () => {
    current.conversation.role = 'member'; current.capabilities.canLeave = true; current.capabilities.canDissolve = false;
    const beforeLeave = vi.fn(async () => { throw new Error('草稿保存失败，请先处理本机存储'); }); const left = vi.fn(async () => {});
    render(<GroupManagementPanel subscribeGroupEvents={subscribeGroupEvents} conversationId="group-1" userId="owner" friends={[]} hasMoreFriends={false} onLoadMoreFriends={async () => {}} onClose={vi.fn()} onRefresh={async () => {}} onLeft={left} onBeforeLeave={beforeLeave} />);
    fireEvent.click(await screen.findByRole('button', { name: '退出群聊' })); fireEvent.click(screen.getByRole('checkbox', { name: '我已了解并确认上述后果' })); fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    await screen.findByText('草稿保存失败，请先处理本机存储'); expect(beforeLeave).toHaveBeenCalledTimes(1); expect(left).not.toHaveBeenCalled(); expect(updates).toHaveLength(0);
  });
  it('requires a removal reason and submits the selected period rather than just user ID', async () => {
    manage(); fireEvent.click(await screen.findByRole('button', { name: '成员' })); await screen.findByText('@friend_name'); fireEvent.click(within(screen.getByText('@friend_name').closest('li')!).getByRole('button', { name: '移出群聊' }));
    fireEvent.change(screen.getByLabelText('移出原因'), { target: { value: '测试移出原因' } }); fireEvent.click(screen.getByRole('checkbox', { name: '我已了解并确认上述后果' })); fireEvent.click(screen.getByRole('button', { name: '确认并继续' })); await waitFor(() => expect(updates).toHaveLength(1)); expect(updates[0]).toMatchObject({ url: '/api/v1/groups/group-1/members/friend/remove', body: { expectedVersion: 7, periodId: 'friend-current-period', reason: '测试移出原因' } });
  });
});

describe('M5-UI invitations and application state', () => {
  it.each(['expired', 'revoked', 'exhausted', 'full', 'pending', 'unavailable'] as const)('does not offer a new application for %s', async (state) => {
    fetched.mockImplementation(() => reply({ ...preview(), state })); render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />); await screen.findByText('公开群简介'); expect(screen.queryByRole('button', { name: '确认申请加入' })).not.toBeInTheDocument(); expect(fetched.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
  it('keeps a stable application UUID across an uncertain response and sends token only in header', async () => {
    const payloads: Record<string, unknown>[] = []; fetched.mockImplementation((url: string, options: RequestInit = {}) => { expect(url).not.toContain(token); expect(new Headers(options.headers).get('X-Group-Invite')).toBe(token); if (options.method === 'POST') { payloads.push(body(options)); return payloads.length === 1 ? Promise.reject(new TypeError('申请结果未知')) : reply(application()); } return reply(preview()); });
    render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByText('连接暂时中断，操作结果尚未确认。请重新连接并确认结果。'); fireEvent.click(screen.getByRole('button', { name: '重试同一次申请' })); await screen.findByText('等待管理员审核。'); expect(payloads[0]).toEqual(payloads[1]); expect(screen.queryByRole('button', { name: '打开群聊' })).not.toBeInTheDocument();
  });
  it('paginates direct invitations and exposes real pending cancellation in application history', async () => {
    fetched.mockImplementation((url: string, options: RequestInit = {}) => { if (options.method === 'POST') { updates.push({ url, body: body(options) }); return reply({ ...application(), status: 'cancelled' }); } if (url.includes('group-applications/mine')) return reply({ items: [application()], nextCursor: null }); if (url.includes('after=')) return reply({ items: [{ ...invite(), id: 'invite-2', groupName: '第二页群' }], nextCursor: null }); return reply({ items: [invite()], nextCursor: 'cursor-one' }); });
    render(<GroupInbox onRefresh={async () => {}} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: '加载更多' })); await screen.findByText('第二页群'); expect(fetched.mock.calls.some(([url]) => url.endsWith('?after=cursor-one'))).toBe(true); fireEvent.click(screen.getByRole('button', { name: '我的入群申请' })); fireEvent.click(await screen.findByRole('button', { name: '取消申请' })); await screen.findByText('申请已取消'); expect(updates[0].url).toBe('/api/v1/group-applications/application-1/cancel');
  });
});

describe('M5-UI browserfix authoritative membership notice', () => {
  it('replaces the old pending notice after refresh confirms membership without returning an application', async () => {
    let approved = false; const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((_url: string, options: RequestInit = {}) => {
      if (options.method === 'POST') { payloads.push(body(options)); return reply(application()); }
      return reply({ ...preview(), state: approved ? 'already_member' : 'available', application: null });
    });
    const openGroup = vi.fn(async () => {}); render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={openGroup} />);
    fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByText('等待管理员审核。'); expect(payloads).toHaveLength(1);
    approved = true; fireEvent.click(screen.getByRole('button', { name: '刷新邀请状态' }));
    await screen.findByRole('status'); expect(screen.getByRole('status')).toHaveTextContent('你已是群成员，可以打开群聊。'); expect(screen.queryByText('等待管理员审核。')).not.toBeInTheDocument(); expect(screen.queryByText(/加入需要管理员审核/)).not.toBeInTheDocument(); expect(screen.getByText('本次入群已确认')).toBeInTheDocument();
    const openButton = screen.getByRole('button', { name: '打开群聊' }); expect(openButton).toBeEnabled(); expect(payloads).toHaveLength(1); fireEvent.click(openButton); await waitFor(() => expect(openGroup).toHaveBeenCalledWith('group-1')); expect(payloads).toHaveLength(1);
  });
});

describe('M5-UI followup contract corrections', () => {
  it.each(['rejected', 'cancelled', 'approved'] as const)('uses authoritative %s on refresh and creates a new request only on explicit reapply', async (status) => {
    const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((_url: string, options: RequestInit = {}) => { if (options.method === 'POST') { payloads.push(body(options)); return reply({ ...application(), status: payloads.length === 1 ? status : 'pending', currentMember: false }); } return reply({ ...preview(), application: payloads.length ? { ...application(), status, currentMember: false } : null }); });
    render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByRole('button', { name: '再次申请加入' }); expect(payloads).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '刷新邀请状态' })); await screen.findByRole('button', { name: '再次申请加入' }); expect(payloads).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '再次申请加入' })); await screen.findByText('等待管理员审核。'); expect(payloads).toHaveLength(2); expect(payloads[0].clientRequestId).not.toBe(payloads[1].clientRequestId);
  });
  it('keeps an uncertain explicit new request UUID even when refresh returns the older terminal application', async () => {
    const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((_url: string, options: RequestInit = {}) => { if (options.method === 'POST') { payloads.push(body(options)); if (payloads.length === 2) return Promise.reject(new TypeError('unknown write')); return reply({ ...application(), status: payloads.length === 1 ? 'cancelled' : 'pending' }); } return reply({ ...preview(), application: payloads.length ? { ...application(), status: 'cancelled' } : null }); });
    render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); fireEvent.click(await screen.findByRole('button', { name: '再次申请加入' })); await screen.findByText('连接暂时中断，操作结果尚未确认。请重新连接并确认结果。');
    fireEvent.click(screen.getByRole('button', { name: '刷新邀请状态' })); const retryButton = await screen.findByRole('button', { name: '重试同一次申请' }); expect(screen.queryByRole('button', { name: '再次申请加入' })).not.toBeInTheDocument(); expect(payloads).toHaveLength(2);
    fireEvent.click(retryButton); await screen.findByText('等待管理员审核。'); expect(payloads).toHaveLength(3); expect(payloads[0].clientRequestId).not.toBe(payloads[1].clientRequestId); expect(payloads[1].clientRequestId).toBe(payloads[2].clientRequestId);
  });
  it('limits removal reason to the API contract maximum of 200 characters', async () => {
    manage(); fireEvent.click(await screen.findByRole('button', { name: '成员' })); await screen.findByText('@friend_name'); fireEvent.click(within(screen.getByText('@friend_name').closest('li')!).getByRole('button', { name: '移出群聊' }));
    expect(screen.getByLabelText('移出原因')).toHaveAttribute('maxlength', '200');
  });
  it('renders known group audit actions in Chinese and gives unknown actions a neutral label', async () => {
    const actions = ['group.create', 'group.settings', 'group.member.update', 'group.member.remove', 'group.leave', 'group.dissolve', 'group.invite.create', 'group.invite.revoke', 'group.application.create', 'group.application.approve', 'group.application.reject', 'group.application.cancel', 'group.transfer.request', 'group.transfer.accept', 'group.transfer.reject', 'group.transfer.cancel', 'group.unknown_future'];
    const baseFetch = fetched.getMockImplementation()!; fetched.mockImplementation((url: string, options: RequestInit = {}) => url.endsWith('/audit') ? reply({ items: actions.map((action, index) => ({ id: `audit-${index}`, action, actor: self, reason: '', createdAt: 1, details: { hiddenTechnicalField: 'never-render' } })), nextCursor: null }) : baseFetch(url, options));
    manage(); fireEvent.click(await screen.findByRole('button', { name: '操作记录' })); await screen.findByText('群状态更新'); for (const label of ['创建群聊', '更新群资料与策略', '更新成员角色或禁言', '移出群成员', '退出群聊', '解散群聊', '创建群邀请', '撤销群邀请', '提交入群申请', '批准入群申请', '拒绝入群申请', '取消入群申请', '发起群主转让', '接受群主转让', '拒绝群主转让', '取消群主转让']) expect(screen.getByText(label)).toBeInTheDocument();
    for (const action of actions) expect(screen.queryByText(action)).not.toBeInTheDocument(); expect(screen.queryByText('never-render')).not.toBeInTheDocument();
  });
  it.each([{ status: 400, code: 'INVALID_INPUT' }, { status: 403, code: 'FORBIDDEN' }, { status: 422, code: 'INVALID_INPUT' }, { status: 409, code: 'ALREADY_MEMBER' }])('unlocks a definitely rejected invitation form after $status/$code', async ({ status, code }) => {
    const requests: Record<string, unknown>[] = []; const baseFetch = fetched.getMockImplementation()!;
    fetched.mockImplementation((url: string, options: RequestInit = {}) => { if (url.endsWith('/invites') && options.method === 'POST') { requests.push(body(options)); return requests.length === 1 ? Promise.resolve({ ok: false, status, json: async () => ({ error: { code, message: '确定未创建，请修正参数' } }) }) : reply({ invite: invite(), token: null }); } return baseFetch(url, options); });
    manage(); fireEvent.click(await screen.findByRole('button', { name: '邀请' })); fireEvent.click(screen.getByRole('button', { name: '创建邀请' })); await screen.findByText('确定未创建，请修正参数'); expect(screen.getByLabelText('邀请名额')).toBeEnabled(); fireEvent.change(screen.getByLabelText('邀请名额'), { target: { value: '12' } }); fireEvent.click(screen.getByRole('button', { name: '创建邀请' })); await screen.findByText('邀请已存在，但重试不能再次获取完整链接。可撤销旧邀请后新建。'); expect(requests).toHaveLength(2); expect(requests[0].clientRequestId).not.toBe(requests[1].clientRequestId); expect(requests[1].maxUses).toBe(12);
  });
  it('keeps an uncertain invitation form locked and retries the same request payload', async () => {
    const requests: Record<string, unknown>[] = []; const baseFetch = fetched.getMockImplementation()!;
    fetched.mockImplementation((url: string, options: RequestInit = {}) => { if (url.endsWith('/invites') && options.method === 'POST') { requests.push(body(options)); return requests.length === 1 ? Promise.reject(new TypeError('unknown invite write')) : reply({ invite: invite(), token: null }); } return baseFetch(url, options); });
    manage(); fireEvent.click(await screen.findByRole('button', { name: '邀请' })); fireEvent.click(screen.getByRole('button', { name: '创建邀请' })); await screen.findByText('连接暂时中断，操作结果尚未确认。请重新连接并确认结果。'); expect(screen.getByLabelText('邀请名额')).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '重试同一次邀请' })); await screen.findByText('邀请已存在，但重试不能再次获取完整链接。可撤销旧邀请后新建。'); expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  });
});

describe('M5-UI-FIX authoritative invitation lifecycle', () => {
  it.each(['rejected', 'cancelled'] as const)('replaces a link pending result with authoritative %s and explicitly reapplies with a new UUID', async (status) => {
    let latest: GroupApplication | null = null; const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((_url: string, options: RequestInit = {}) => { if (options.method === 'POST') { payloads.push(body(options)); latest = { ...application(), id: `application-${payloads.length}` }; return reply(latest); } return reply({ ...preview(), application: latest }); });
    render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByText('等待管理员审核。'); latest = { ...application(), status };
    fireEvent.click(screen.getByRole('button', { name: '刷新邀请状态' })); const again = await screen.findByRole('button', { name: '再次申请加入' }); expect(screen.queryByText('等待管理员审核。')).not.toBeInTheDocument(); expect(payloads).toHaveLength(1);
    fireEvent.click(again); await screen.findByText('等待管理员审核。'); expect(payloads).toHaveLength(2); expect(payloads[1].clientRequestId).not.toBe(payloads[0].clientRequestId);
  });
  it.each(['terminal', 'null'] as const)('clears link member access after leaving when authoritative application becomes %s', async (shape) => {
    let latest: GroupApplication | null = null; let memberNow = false; const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((_url: string, options: RequestInit = {}) => { if (options.method === 'POST') { payloads.push(body(options)); latest = { ...application(), status: 'approved', currentMember: true }; memberNow = true; return reply(latest); } return reply({ ...preview(), state: memberNow ? 'already_member' : 'available', application: latest }); });
    render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByRole('button', { name: '打开群聊' });
    memberNow = false; latest = shape === 'terminal' ? { ...application(), status: 'approved', currentMember: false } : null; fireEvent.click(screen.getByRole('button', { name: '刷新邀请状态' }));
    const again = await screen.findByRole('button', { name: shape === 'terminal' ? '再次申请加入' : '确认申请加入' }); expect(screen.queryByRole('button', { name: '打开群聊' })).not.toBeInTheDocument(); expect(screen.queryByText('你已是群成员，可以打开群聊。')).not.toBeInTheDocument(); expect(payloads).toHaveLength(1);
    fireEvent.click(again); await screen.findByRole('button', { name: '打开群聊' }); expect(payloads).toHaveLength(2); expect(payloads[1].clientRequestId).not.toBe(payloads[0].clientRequestId);
  });
  it('clears a known pending link result on authoritative null without resubmitting until another explicit confirmation', async () => {
    const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((_url: string, options: RequestInit = {}) => { if (options.method === 'POST') { payloads.push(body(options)); return reply(application()); } return reply(preview()); });
    render(<GroupInviteEntry token={token} userId="owner" onClose={vi.fn()} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByText('等待管理员审核。'); fireEvent.click(screen.getByRole('button', { name: '刷新邀请状态' }));
    const confirm = await screen.findByRole('button', { name: '确认申请加入' }); expect(screen.queryByText('等待管理员审核。')).not.toBeInTheDocument(); expect(payloads).toHaveLength(1); fireEvent.click(confirm); await screen.findByText('等待管理员审核。'); expect(payloads[1].clientRequestId).not.toBe(payloads[0].clientRequestId);
  });
  it.each(['cancelled', 'rejected'] as const)('reapplies a direct invitation with a new UUID after %s in the same inbox instance', async (status) => {
    let latest: GroupApplication | null = null; const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((url: string, options: RequestInit = {}) => {
      if (url.endsWith('/apply')) { expect(new Headers(options.headers).has('X-Group-Invite')).toBe(false); payloads.push(body(options)); latest = { ...application(), id: `direct-application-${payloads.length}` }; return reply(latest); }
      if (url.endsWith('/cancel')) { latest = { ...latest!, status: 'cancelled' }; return reply(latest); }
      if (url.endsWith('/group-applications/mine')) return reply({ items: latest ? [latest] : [], nextCursor: null });
      return reply({ items: [{ ...invite(), application: latest }], nextCursor: null });
    });
    render(<GroupInbox onRefresh={async () => {}} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByText('等待管理员审核'); expect(payloads).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '我的入群申请' })); const cancel = await screen.findByRole('button', { name: '取消申请' });
    if (status === 'cancelled') { fireEvent.click(cancel); await waitFor(() => expect(screen.queryByRole('button', { name: '取消申请' })).not.toBeInTheDocument()); }
    else { latest = { ...latest!, status: 'rejected' }; fireEvent.click(screen.getByRole('button', { name: '刷新群邀请与申请' })); await screen.findByText('申请已拒绝'); }
    fireEvent.click(screen.getByRole('button', { name: '收到的群邀请' })); const again = await screen.findByRole('button', { name: '再次申请加入' }); expect(payloads).toHaveLength(1); fireEvent.click(again); await screen.findByText('等待管理员审核'); expect(payloads).toHaveLength(2); expect(payloads[1].clientRequestId).not.toBe(payloads[0].clientRequestId);
  });
  it.each(['null', 'older_terminal'] as const)('keeps an unknown direct application UUID across refresh and both tabs with %s authority', async (shape) => {
    const prior = shape === 'older_terminal' ? { ...application(), status: 'cancelled' as const } : null; let latest: GroupApplication | null = prior; const payloads: Record<string, unknown>[] = [];
    fetched.mockImplementation((url: string, options: RequestInit = {}) => {
      if (url.endsWith('/apply')) { payloads.push(body(options)); if (payloads.length === 1) return Promise.reject(new TypeError('unknown direct write')); latest = { ...application(), id: 'new-direct-application' }; return reply(latest); }
      if (url.endsWith('/group-applications/mine')) return reply({ items: latest ? [latest] : [], nextCursor: null });
      return reply({ items: [{ ...invite(), application: latest }], nextCursor: null });
    });
    render(<GroupInbox onRefresh={async () => {}} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: prior ? '再次申请加入' : '确认申请加入' })); await screen.findByRole('button', { name: '重试同一次申请' });
    fireEvent.click(screen.getByRole('button', { name: '刷新群邀请与申请' })); await screen.findByRole('button', { name: '重试同一次申请' }); fireEvent.click(screen.getByRole('button', { name: '我的入群申请' })); await waitFor(() => expect(screen.queryByText('正在加载…')).not.toBeInTheDocument()); fireEvent.click(screen.getByRole('button', { name: '收到的群邀请' }));
    const retry = await screen.findByRole('button', { name: '重试同一次申请' }); expect(screen.queryByRole('button', { name: '再次申请加入' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '确认申请加入' })).not.toBeInTheDocument(); expect(payloads).toHaveLength(1); fireEvent.click(retry); await screen.findByText('等待管理员审核'); expect(payloads).toHaveLength(2); expect(payloads[0]).toEqual(payloads[1]);
  });
  it('clears an authoritative direct-member state when a later refresh says the member left', async () => {
    let latest: GroupApplication | null = { ...application(), status: 'approved', currentMember: true }; const openGroup = vi.fn(async () => {});
    fetched.mockImplementation(() => reply({ items: [{ ...invite(), state: 'exhausted', application: latest }], nextCursor: null })); render(<GroupInbox onRefresh={async () => {}} onOpenGroup={openGroup} />);
    fireEvent.click(await screen.findByRole('button', { name: '打开群聊' })); await waitFor(() => expect(openGroup).toHaveBeenCalledWith('group-1')); latest = { ...application(), status: 'approved', currentMember: false }; fireEvent.click(screen.getByRole('button', { name: '刷新群邀请与申请' })); await screen.findByText('此前已加入群聊，当前已不在群中'); expect(screen.queryByRole('button', { name: '打开群聊' })).not.toBeInTheDocument();
  });
  it('keeps a confirmed direct POST result newer than its old list if follow-up refresh fails', async () => {
    fetched.mockImplementation((url: string) => url.endsWith('/apply') ? reply(application()) : reply({ items: [{ ...invite(), application: null }], nextCursor: null }));
    render(<GroupInbox onRefresh={async () => { throw new Error('同步失败，申请已确认'); }} onOpenGroup={async () => {}} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByText('同步失败，申请已确认'); expect(screen.getByText('等待管理员审核')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '确认申请加入' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '重试同一次申请' })).not.toBeInTheDocument();
  });
});

describe('M8 group inbox event freshness', () => {
  function events() { const listeners = new Set<(event: { type: string; entityRef: string; conversationId: string | null }) => void>(); return { subscribe: (listener: (event: { type: string; entityRef: string; conversationId: string | null }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, emit: (type: string) => act(() => listeners.forEach((listener) => listener({ type, entityRef: 'group-1', conversationId: 'group-1' }))) }; }
  function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
  it('refreshes the open notification inbox on revocation and hides old joined membership before GET resolves', async () => {
    const stream = events(); let joined = true; const next = pending<Awaited<ReturnType<typeof reply>>>(); fetched.mockImplementation(() => joined ? reply({ items: [{ ...invite(), application: { ...application(), status: 'approved', currentMember: true } }], nextCursor: null }) : next.promise);
    render(<NotificationsPage actorContext="owner" items={[]} hasMore={false} onLoadMore={async () => {}} onRefresh={async () => {}} onOpenRequests={vi.fn()} onOpenGroup={async () => {}} subscribeGroupEvents={stream.subscribe} />); await screen.findByText('当前已加入群聊'); joined = false; stream.emit('access.revoked'); expect(screen.queryByText('当前已加入群聊')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '打开群聊' })).not.toBeInTheDocument();
    await act(async () => next.resolve(await reply({ items: [{ ...invite(), application: { ...application(), status: 'approved', currentMember: false } }], nextCursor: null }))); await screen.findByText('此前已加入群聊，当前已不在群中'); expect(updates).toHaveLength(0);
  });
  it('keeps loaded page depth on authority refresh and ignores unrelated notification rerenders or task events', async () => {
    const stream = events(); let generation = 1; fetched.mockImplementation((url: string) => reply({ items: [{ ...invite(), id: url.includes('?') ? 'second' : 'first', groupName: url.includes('?') ? `第二页${generation}` : `首页${generation}` }], nextCursor: url.includes('?') ? null : `cursor-${generation}` })); const props = { actorContext: 'owner', items: [], hasMore: false, onLoadMore: async () => {}, onRefresh: async () => {}, onOpenRequests: vi.fn(), onOpenGroup: async () => {}, subscribeGroupEvents: stream.subscribe }; const view = render(<NotificationsPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' })); await screen.findByText('第二页1'); const before = fetched.mock.calls.length; view.rerender(<NotificationsPage {...props} items={[{ id: 'ordinary', type: 'friend.accepted', entityRef: 'u2', text: '普通通知', createdAt: 1, readAt: 1 }]} />); stream.emit('task.updated'); await act(async () => {}); expect(fetched).toHaveBeenCalledTimes(before); expect(screen.getByText('第二页1')).toBeInTheDocument();
    generation = 2; stream.emit('conversation.updated'); await screen.findByText('第二页2'); expect(screen.getByText('首页2')).toBeInTheDocument(); expect(fetched.mock.calls.some(([url]) => url.endsWith('?after=cursor-2'))).toBe(true);
  });
  it('preserves an uncertain application UUID through event refresh without replaying the application', async () => {
    const stream = events(); const requests: Record<string, unknown>[] = []; fetched.mockImplementation((url: string, options: RequestInit = {}) => { if (url.endsWith('/apply')) { requests.push(body(options)); if (requests.length === 1) return Promise.reject(new TypeError('unknown application')); return reply(application()); } return reply({ items: [{ ...invite(), application: null }], nextCursor: null }); });
    render(<GroupInbox onRefresh={async () => {}} onOpenGroup={async () => {}} subscribeGroupEvents={stream.subscribe} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await screen.findByRole('button', { name: '重试同一次申请' }); stream.emit('access.revoked'); fireEvent.click(await screen.findByRole('button', { name: '重试同一次申请' })); await waitFor(() => expect(requests).toHaveLength(2)); expect(requests[0]).toEqual(requests[1]);
  });
  it.each(['before_event', 'after_event'] as const)('does not restore an old confirmed membership result received %s', async (timing) => {
    const stream = events(); const result = pending<Awaited<ReturnType<typeof reply>>>(); let changed = false; let writes = 0;
    fetched.mockImplementation((url: string) => { if (url.endsWith('/apply')) { writes++; return timing === 'after_event' ? result.promise : reply({ ...application(), status: 'approved', currentMember: true }); } return reply({ items: [{ ...invite(), ...(changed ? {} : { application: null }) }], nextCursor: null }); });
    render(<GroupInbox onRefresh={async () => { throw new Error('refresh unavailable'); }} onOpenGroup={async () => {}} subscribeGroupEvents={stream.subscribe} />); fireEvent.click(await screen.findByRole('button', { name: '确认申请加入' })); await waitFor(() => expect(writes).toBe(1)); if (timing === 'before_event') await screen.findByText('当前已加入群聊'); changed = true; stream.emit('access.revoked'); await waitFor(() => expect(screen.queryByText('正在加载…')).not.toBeInTheDocument());
    if (timing === 'after_event') { await act(async () => result.resolve(await reply({ ...application(), status: 'approved', currentMember: true }))); await screen.findByText('refresh unavailable'); }
    expect(screen.queryByText('当前已加入群聊')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '打开群聊' })).not.toBeInTheDocument(); expect(writes).toBe(1);
  });
  it('keeps the applications tab and rejects a late pre-revocation page', async () => {
    const stream = events(); const old = pending<Awaited<ReturnType<typeof reply>>>(); let revision = 0; fetched.mockImplementation((url: string) => { if (url.endsWith('/group-invites/mine')) return reply({ items: [], nextCursor: null }); if (url.includes('?')) return old.promise; return reply({ items: [{ ...application(), currentMember: revision === 0, groupName: revision === 0 ? '申请首页旧状态' : '申请首页新状态' }], nextCursor: revision === 0 ? 'old-page' : null }); });
    render(<GroupInbox onRefresh={async () => {}} onOpenGroup={async () => {}} subscribeGroupEvents={stream.subscribe} />); fireEvent.click(screen.getByRole('button', { name: '我的入群申请' })); fireEvent.click(await screen.findByRole('button', { name: '加载更多' })); await waitFor(() => expect(fetched.mock.calls.some(([url]) => url.includes('?after=old-page'))).toBe(true)); revision = 1; stream.emit('access.revoked'); await screen.findByText('申请首页新状态'); await act(async () => old.resolve(await reply({ items: [{ ...application(), id: 'late', groupName: 'LATE-OLD-MEMBER', currentMember: true }], nextCursor: null }))); expect(screen.queryByText('LATE-OLD-MEMBER')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: '我的入群申请' })).toHaveAttribute('aria-pressed', 'true');
  });
});
describe('UX-R04 live group authority', () => {
  it('preserves a draft and requires review before saving against a newer version', async () => {
    const mounted = manage(); await screen.findByLabelText('群名称');
    fireEvent.change(screen.getByLabelText('群名称'), { target: { value: '本地未保存名称' } });
    current = { ...group(), version: 8, conversation: { ...group().conversation, title: '远端名称', memberCount: 2 } };
    remoteUpdate();
    await screen.findByText('最新群名称：远端名称');
    expect(screen.getByLabelText('群名称')).toHaveValue('本地未保存名称');
    expect(screen.getByRole('button', { name: '保存群资料与策略' })).toBeDisabled();
    expect(updates).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '已核对最新资料，继续编辑草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '保存群资料与策略' }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0].body).toMatchObject({ expectedVersion: 8, name: '本地未保存名称' });
    mounted.unmount(); expect(groupEvents.size).toBe(0);
  });
  it('retains a copyable draft but removes edit authority after demotion', async () => {
    manage(); await screen.findByLabelText('群名称');
    fireEvent.change(screen.getByLabelText('群名称'), { target: { value: '保留草稿' } });
    current = group(); current.version = 8; current.conversation.role = 'member';
    current.capabilities = { canEdit: false, canInvite: false, canReview: false, canAssignRoles: false, canTransfer: false, canDissolve: false, canLeave: true };
    remoteUpdate();
    await screen.findByRole('button', { name: '退出群聊' });
    expect((screen.getByLabelText('可复制的未保存草稿') as HTMLTextAreaElement).value).toContain('保留草稿');
    expect(screen.getByRole('button', { name: '保存群资料与策略' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '解散群聊' })).not.toBeInTheDocument();
    expect(updates).toHaveLength(0);
  });
  it('cancels confirmation and never continues a late reauthentication after remote changes', async () => {
    let finish!: (value: unknown) => void;
    const baseFetch = fetched.getMockImplementation()!;
    fetched.mockImplementation((url, options) => url === '/api/v1/auth/reauth' ? new Promise((resolve) => { finish = resolve; }) : baseFetch(url, options));
    manage(); fireEvent.click(await screen.findByRole('button', { name: '解散群聊' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'example-password' } });
    fireEvent.click(screen.getByLabelText('我已了解并确认上述后果'));
    fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    current = { ...group(), version: 8 }; remoteUpdate();
    await act(async () => { finish(await reply({ reauthToken: 'late-token' })); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '解散群聊 · 再次验证' })).not.toBeInTheDocument());
    expect(fetched.mock.calls.some(([url]) => url.endsWith('/dissolve'))).toBe(false);
  });
  it('ignores a late older detail response and hides stale member rows during refresh', async () => {
    manage(); fireEvent.click(await screen.findByRole('button', { name: '成员' })); await screen.findByText('@friend_name');
    let finish!: (value: unknown) => void; const baseFetch = fetched.getMockImplementation()!;
    fetched.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    remoteUpdate();
    expect(screen.queryByText('@friend_name')).not.toBeInTheDocument();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    current = { ...group(), version: 9, conversation: { ...group().conversation, title: '最新群名称' } };
    fetched.mockImplementation(baseFetch); remoteUpdate();
    await screen.findByText('最新群名称');
    await act(async () => { finish(await reply(group())); });
    expect(screen.getByText('最新群名称')).toBeInTheDocument();
    expect(screen.queryByText('定向测试群')).not.toBeInTheDocument();
  });
});
describe('UX-R04 invitation continuity and failed refresh', () => {
  it('keeps the one-time invitation link across unrelated refreshes and clears a revoked invite', async () => {
    let revoked = false; const baseFetch = fetched.getMockImplementation()!;
    fetched.mockImplementation((url, options: RequestInit = {}) => url.endsWith('/invites') ? options.method === 'POST' ? reply({ invite: invite(), token }) : reply({ items: [{ ...invite(), state: revoked ? 'revoked' : 'available' }], nextCursor: null }) : baseFetch(url, options));
    manage(); fireEvent.click(await screen.findByRole('button', { name: '邀请' }));
    fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));
    const link = await screen.findByLabelText('本次生成的邀请链接'); const value = (link as HTMLTextAreaElement).value;
    await waitFor(() => expect(screen.getByRole('button', { name: '创建邀请' })).toBeEnabled());
    current = { ...group(), version: 8 }; remoteUpdate();
    await waitFor(() => expect(screen.getByLabelText('本次生成的邀请链接')).toHaveValue(value));
    revoked = true; current = { ...group(), version: 9 }; remoteUpdate();
    await waitFor(() => expect(screen.getByText(/已撤销/)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByLabelText('本次生成的邀请链接')).not.toBeInTheDocument());
  });
  it('keeps all actions disabled when remote detail revalidation fails', async () => {
    manage(); await screen.findByLabelText('群名称');
    fetched.mockRejectedValueOnce(new Error('远端刷新失败')); remoteUpdate();
    await screen.findByText('远端刷新失败');
    expect(screen.getByRole('button', { name: '保存群资料与策略' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '解散群聊' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '解散群聊' }));
    expect(screen.queryByRole('button', { name: '确认并继续' })).not.toBeInTheDocument();
    expect(updates).toHaveLength(0);
  });
});
