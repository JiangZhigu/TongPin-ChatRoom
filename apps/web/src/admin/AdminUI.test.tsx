// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { UserView } from '../auth-types';
import type { AdminCommand, AdminCommandInput, AdminGroup, AdminMember, AdminMonitoring, AdminOverview, AdminPage, AdminUser } from '../lib/admin-types';
import { api, APIError } from '../lib/api';
import { AdminActionDialog } from './AdminActionDialog';
import { AdminContext, type ActionRequest } from './AdminShared';
import { AdminShell } from './AdminShell';
import { AccountSettings } from '../AccountSettings';
import { ProfileSettings } from '../ProfileSettings';

vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn() }));
const requestApi = vi.mocked(api);
const actor: UserView = { id: 'admin-one', username: 'admin_one', nickname: '管理一', bio: '', siteRole: 'super_admin', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const user: AdminUser = { id: 'u1', username: 'user_one', nickname: '第一用户', bio: '', siteRole: 'user', status: 'active', createdAt: 1, updatedAt: 2, deletionAt: null, lastSeenAt: null, sessionCount: 3, ownedGroupCount: 2, storageBytes: 1024, quotaBytes: 2097152, mutedUntil: null, statusReason: '', muteReason: '', restrictionReason: '测试限制理由', uploadDisabled: true, groupCreationDisabled: false, mustChangePassword: false, hasSecondFactor: false, version: 1 };
const group: AdminGroup = { id: 'g1', name: '测试群聊', description: '群简介', owner: user, status: 'active', memberCount: 2, createdAt: 1, updatedAt: 2, roleVersion: 1, lastSeq: '4', everyoneMuted: false, reviewRequired: true, inviteRole: 'managers' };
const page = <T,>(items: T[], nextCursor: string | null = null): AdminPage<T> => ({ items, nextCursor, total: items.length + (nextCursor ? 1 : 0) });
const overview: AdminOverview = { window: '24h', from: 0, to: 100, generatedAt: 100, processStartedAt: 50, metrics: [{ key: 'users', label: '注册账号', value: 27, unit: '人', description: '来自真实账号记录', href: '/admin/users' }, { key: 'unknown', label: '等待采样', value: null, unit: '', description: '尚无采样', href: '' }], trends: [{ at: 10, registrations: 3, messages: 11, uploads: 2 }] };
const thresholds = { cpuPercent: 80, memoryMiB: 2048, diskPercent: 90, httpP95Ms: 500, dbWaitMs: 100, failedJobs: 2, pendingJobs: 20 };
const monitoring: AdminMonitoring = { processStartedAt: 50, sampledAt: 100, latest: null, samples: [], storage: { totalBytes: 1000, freeBytes: 400, usedPercent: 60, databaseBytes: 50, walBytes: 20, attachmentBytes: 200, chargedBytes: 150 }, queues: { pending: 2, running: 1, completed: 6, failed: 1, oldestPendingAt: 50 }, alerts: page([]), thresholds, policyVersion: 3 };
const member: AdminMember = { id: 'membership-one', user, role: 'member', joinedAt: 2, visibleFromSeq: '2', mutedUntil: null, writeVersion: 1 };
function command(operationId: string, action: AdminCommand['action'], patch: Partial<AdminCommand> = {}): AdminCommand { return { operationId, action, status: 'completed', total: 1, succeeded: 1, failed: 0, pending: 0, items: [{ id: 'u1', label: '第一用户', status: 'succeeded', code: null, message: null }], createdAt: 2, updatedAt: 3, jobId: null, secretAvailable: false, ...patch }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; }
function mountAction(request: ActionRequest, deny = vi.fn()) { const onChanged = vi.fn(); const view = render(<AdminContext.Provider value={{ navigate: vi.fn(), openAction: vi.fn(), deny, revision: 0 }}><AdminActionDialog request={request} onClose={vi.fn()} onChanged={onChanged} /></AdminContext.Provider>); return { ...view, deny, onChanged }; }
function installCommands(options: { partial?: boolean; unknown?: boolean; secret?: boolean; queued?: boolean } = {}) {
  let saved: AdminCommandInput; const order: string[] = [];
  requestApi.mockImplementation(async (path, init = {}) => {
    order.push(path);
    if (path.endsWith('/preview')) { saved = init.body as AdminCommandInput; return { operationId: saved.operationId, action: saved.action, reason: saved.reason, targetCount: saved.targetIds.length, targets: saved.targetIds.map((id) => ({ id, label: `预览目标 ${id}`, detail: '当前会话将被撤销' })), impacts: ['所有指定目标立即受影响'], expiresAt: Date.now() + 60000, requiresReauthentication: true }; }
    if (path.endsWith('/reauth')) return { reauthToken: 'ephemeral-reauth' };
    if (path.endsWith('/execute')) { if (options.unknown) throw new APIError(0, { code: 'NETWORK_ERROR', message: '连接中断' }); return command(saved!.operationId, saved!.action, options.queued ? { status: 'queued', pending: 1, succeeded: 0 } : { secretAvailable: !!options.secret }); }
    if (path.endsWith('/secret')) return { credential: 'PRIVATE-ONE-TIME-CREDENTIAL', username: 'user_one', expiresAt: Date.now() + 60000 };
    if (path.includes('/commands/')) return command(saved!.operationId, saved!.action, options.partial ? { status: 'partial', total: 2, failed: 1, items: [{ id: 'u1', label: '第一用户', status: 'succeeded', code: null, message: null }, { id: 'u2', label: '第二用户', status: 'failed', code: 'TARGET_CHANGED', message: '目标已经改变' }] } : {});
    if (path.includes('/members')) return page([member]);
    throw new Error(`Unexpected path ${path}`);
  });
  return { order, saved: () => saved! };
}
async function previewAction() { fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '核实后处理测试账号' } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); await screen.findByRole('heading', { name: '服务端操作预览' }); }
async function executeAction() { fireEvent.change(screen.getByLabelText('管理员当前密码'), { target: { value: 'in-memory-admin-password' } }); fireEvent.click(screen.getByRole('button', { name: '验证身份并执行' })); }
function mountShell(path: string) { window.history.replaceState({}, '', path); return render(<AdminShell user={actor} onSignOut={vi.fn()} signOutBusy={false} signOutError="" />); }
beforeEach(() => { requestApi.mockReset(); Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); window.history.replaceState({}, '', '/'); });

describe('M7 ADMIN command safety and normal controls', () => {
  it('previews exact targets before reauth and executes the same operation with normal restriction controls', async () => {
    const commands = installCommands(); mountAction({ action: 'user.restrict', targetIds: ['u1'], labels: ['第一用户'], initial: { uploadDisabled: true, groupCreationDisabled: false } });
    expect(screen.getByLabelText('禁止上传')).toBeChecked(); expect(screen.getByLabelText('禁止创建群聊')).not.toBeChecked(); expect(screen.queryByLabelText('管理员当前密码')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('禁止创建群聊')); await previewAction();
    expect(commands.saved().parameters).toEqual({ uploadDisabled: true, groupCreationDisabled: true }); expect(screen.getByText('预览目标 u1')).toBeInTheDocument(); expect(screen.getByText('所有指定目标立即受影响')).toBeInTheDocument();
    await executeAction(); await screen.findByRole('heading', { name: '执行结果：已完成' });
    expect(commands.order).toEqual(['/api/v1/admin/commands/preview', '/api/v1/auth/reauth', '/api/v1/admin/commands/execute']);
    expect(requestApi.mock.calls[1][1]?.body).toEqual({ password: 'in-memory-admin-password', action: `admin.execute:${commands.saved().operationId}` });
    expect(requestApi.mock.calls[2][1]?.body).toEqual({ operationId: commands.saved().operationId, reauthToken: 'ephemeral-reauth' });
  });
  it('keeps an unknown execution on the original ID and renders partial per-target results without retrying punishment', async () => {
    const commands = installCommands({ unknown: true, partial: true }); mountAction({ action: 'user.ban', targetIds: ['u1', 'u2'], labels: ['第一用户', '第二用户'] }); await previewAction(); await executeAction();
    await screen.findByRole('heading', { name: '执行结果尚未确认' }); expect(screen.queryByRole('button', { name: '验证身份并执行' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '核对同一操作结果' })); await screen.findByRole('heading', { name: '执行结果：部分成功' }); expect(screen.getByText('目标已经改变')).toBeInTheDocument();
    expect(commands.order.at(-1)).toBe(`/api/v1/admin/commands/${commands.saved().operationId}`); expect(commands.order.filter((path) => path.endsWith('/execute'))).toHaveLength(1); expect(commands.order.filter((path) => path.endsWith('/preview'))).toHaveLength(1);
  });
  it('only reveals a reset secret on an explicit click and never persists it', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const commands = installCommands({ secret: true }); const view = mountAction({ action: 'user.password_reset', targetIds: ['u1'], labels: ['第一用户'] });
    await previewAction(); await executeAction(); await screen.findByRole('button', { name: '显示一次性恢复凭据' }); expect(commands.order.some((path) => path.endsWith('/secret'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '显示一次性恢复凭据' })); await screen.findByText('PRIVATE-ONE-TIME-CREDENTIAL'); expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '隐藏凭据' })); expect(screen.queryByText('PRIVATE-ONE-TIME-CREDENTIAL')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '显示一次性恢复凭据' })).not.toBeInTheDocument(); view.unmount();
  });
  it('aborts and discards an old preview when the owning view unmounts', async () => {
    const pending = deferred<unknown>(); requestApi.mockReturnValue(pending.promise); const view = mountAction({ action: 'user.ban', targetIds: ['u1'], labels: ['OLD-PRIVATE-USER'] });
    fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '验证未完成前切换身份' } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); const signal = requestApi.mock.calls[0][1]?.signal; view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve({ targets: [{ id: 'u1', label: 'OLD-PRIVATE-USER' }] }); }); expect(screen.queryByText('OLD-PRIVATE-USER')).not.toBeInTheDocument(); expect(requestApi).toHaveBeenCalledTimes(1);
  });
  it('selects a real member for owner correction and uses the member user ID', async () => {
    const commands = installCommands(); mountAction({ action: 'group.owner.change', targetIds: ['g1'], labels: ['测试群聊'], groupId: 'g1' }); fireEvent.click(await screen.findByRole('radio', { name: /第一用户/ })); await previewAction(); expect(commands.saved().parameters).toEqual({ userId: 'u1' });
  });
  it('requires a new preview and operation ID after an explicit version conflict', async () => {
    const commands = installCommands(); const original = requestApi.getMockImplementation()!;
    requestApi.mockImplementation((path, init) => path.endsWith('/execute') ? Promise.reject(new APIError(409, { code: 'VERSION_CONFLICT', message: '目标版本已变化' })) : original(path, init));
    mountAction({ action: 'user.ban', targetIds: ['u1'], labels: ['第一用户'] }); await previewAction(); const firstId = commands.saved().operationId; await executeAction();
    fireEvent.click(await screen.findByRole('button', { name: '重新预览最新目标' })); expect(screen.queryByLabelText('管理员当前密码')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); await screen.findByRole('heading', { name: '服务端操作预览' }); expect(commands.saved().operationId).not.toBe(firstId);
  });
  it('keeps failed reauthentication in the form without issuing execution or losing the preview', async () => {
    const commands = installCommands(); const original = requestApi.getMockImplementation()!; requestApi.mockImplementation((path, init) => path.endsWith('/reauth') ? Promise.reject(new APIError(401, { code: 'REAUTH_FAILED', message: '密码不正确' })) : original(path, init));
    const view = mountAction({ action: 'user.ban', targetIds: ['u1'], labels: ['第一用户'] }); await previewAction(); await executeAction(); await screen.findByText('密码不正确'); expect(view.deny).not.toHaveBeenCalled(); expect(screen.getByRole('heading', { name: '服务端操作预览' })).toBeInTheDocument(); expect(commands.order.some((path) => path.endsWith('/execute'))).toBe(false); expect(screen.getByLabelText('管理员当前密码')).toHaveValue('');
  });
  it('turns COMMAND_EXISTS on preview into same-ID verification without allowing another preview', async () => {
    let saved: AdminCommandInput | null = null;
    requestApi.mockImplementation(async (path, init) => { if (path.endsWith('/preview')) { saved = init?.body as AdminCommandInput; throw new APIError(409, { code: 'COMMAND_EXISTS', message: '此操作已提交' }); } return command(saved!.operationId, saved!.action); });
    mountAction({ action: 'user.ban', targetIds: ['u1'], labels: ['第一用户'] }); fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '核实违规处理' } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' }));
    fireEvent.click(await screen.findByRole('button', { name: '核对同一操作结果' })); await screen.findByRole('heading', { name: '执行结果：已完成' }); expect(screen.queryByRole('button', { name: '重取同一操作预览' })).not.toBeInTheDocument(); expect(requestApi.mock.calls[1][0]).toBe(`/api/v1/admin/commands/${(saved as unknown as AdminCommandInput).operationId}`);
  });
  it('discards a late secret response after the administrator identity unmounts', async () => {
    installCommands({ secret: true }); const original = requestApi.getMockImplementation()!; const pending = deferred<unknown>(); requestApi.mockImplementation((path, init) => path.endsWith('/secret') ? pending.promise : original(path, init));
    const view = mountAction({ action: 'user.password_reset', targetIds: ['u1'], labels: ['第一用户'] }); await previewAction(); await executeAction(); fireEvent.click(await screen.findByRole('button', { name: '显示一次性恢复凭据' })); const signal = requestApi.mock.calls.at(-1)?.[1]?.signal; view.unmount(); expect(signal?.aborted).toBe(true); await act(async () => { pending.resolve({ credential: 'LATE-PRIVATE-CREDENTIAL', username: 'user_one', expiresAt: Date.now() + 60000 }); }); expect(screen.queryByText('LATE-PRIVATE-CREDENTIAL')).not.toBeInTheDocument();
  });
  it('validates mute duration and sends a timestamp only after valid input', async () => {
    const commands = installCommands(); mountAction({ action: 'user.mute', targetIds: ['u1'], labels: ['第一用户'] }); fireEvent.change(screen.getByLabelText('禁言截止时间'), { target: { value: '2001-01-01T12:00' } }); fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '核实违规后禁言' } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); expect(await screen.findByText('禁言截止时间必须在未来 30 天内。')).toBeInTheDocument(); expect(requestApi).not.toHaveBeenCalled();
    const time = new Date(Date.now() + 86400000); const local = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16); fireEvent.change(screen.getByLabelText('禁言截止时间'), { target: { value: local } }); fireEvent.click(screen.getByRole('button', { name: '预览目标与影响' })); await screen.findByRole('heading', { name: '服务端操作预览' }); expect(commands.saved().parameters).toEqual({ until: new Date(local).getTime() });
  });
  it('suspends queued-command polling while the document is hidden', async () => {
    const commands = installCommands({ queued: true }); mountAction({ action: 'user.ban', targetIds: ['u1'], labels: ['第一用户'] }); await previewAction(); await executeAction(); await screen.findByRole('heading', { name: '执行结果：排队中' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 2100)); }); expect(commands.order.filter((path) => /\/commands\/[^/]+$/.test(path) && !path.endsWith('/execute') && !path.endsWith('/preview'))).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 2100)); }); expect(screen.getByRole('heading', { name: '执行结果：已完成' })).toBeInTheDocument(); expect(commands.order.at(-1)).toBe(`/api/v1/admin/commands/${commands.saved().operationId}`);
  });
});

describe('M7 ADMIN routes and identity data boundaries', () => {
  it('restores URL filters and opaque pagination, and clears selection on route change', async () => {
    requestApi.mockImplementation(async (path) => { if (path.includes('/users')) return page([user], path.includes('after=') ? null : 'opaque/next+'); throw new Error(path); }); mountShell('/admin/users?q=hello&status=active&role=user&sort=oldest');
    await screen.findByText('第一用户 (@user_one)'); expect(screen.getByLabelText('搜索用户名或昵称')).toHaveValue('hello'); expect(screen.getByLabelText('排序')).toHaveValue('oldest');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 user_one' })); expect(screen.getByText('本页已选 1 人')).toBeInTheDocument(); fireEvent.click(screen.getByRole('link', { name: '下一页' })); await screen.findByText('本页已选 0 人'); expect(window.location.search).toContain('after=opaque%2Fnext%2B'); expect(requestApi.mock.calls.at(-1)?.[0]).toContain('sort=oldest');
    fireEvent.change(screen.getByLabelText('搜索用户名或昵称'), { target: { value: 'next query' } }); fireEvent.click(screen.getByRole('button', { name: '应用筛选' })); await waitFor(() => expect(window.location.search).toContain('q=next+query')); expect(window.location.search).not.toContain('after=');
  });
  it('does not substitute zero for a null metric and exposes real trend counts', async () => { requestApi.mockResolvedValue(overview); mountShell('/admin?window=7d'); await screen.findByText('注册账号'); expect(screen.getByText('未知')).toBeInTheDocument(); expect(screen.getByText('27')).toBeInTheDocument(); expect(screen.getByRole('cell', { name: '11' })).toBeInTheDocument(); expect(requestApi.mock.calls[0][0]).toBe('/api/v1/admin/overview?window=7d'); });
  it('removes all admin data on a server permission failure', async () => { requestApi.mockRejectedValue(new APIError(403, { code: 'ADMIN_FORBIDDEN', message: '无管理权限' })); mountShell('/admin/users'); await screen.findByRole('heading', { name: '管理权限已失效' }); expect(screen.queryByRole('navigation', { name: '管理导航' })).not.toBeInTheDocument(); expect(screen.queryByText('第一用户 (@user_one)')).not.toBeInTheDocument(); });
  it('discards an old user-list response after navigating to another route', async () => { const pending = deferred<unknown>(); requestApi.mockImplementation((path) => path.includes('/users') ? pending.promise : Promise.resolve(overview)); mountShell('/admin/users'); const signal = requestApi.mock.calls[0][1]?.signal; fireEvent.click(screen.getByRole('link', { name: '运营概览' })); await screen.findByText('注册账号'); expect(signal?.aborted).toBe(true); await act(async () => { pending.resolve(page([user])); }); expect(screen.queryByText('第一用户 (@user_one)')).not.toBeInTheDocument(); });
  it('shows a route error for unknown admin paths without fetching placeholder data', () => { mountShell('/admin/not-a-real-page'); expect(screen.getByRole('heading', { name: '未找到管理页面' })).toBeInTheDocument(); expect(requestApi).not.toHaveBeenCalled(); });
  it('shows monitor storage and alert recovery with no invented samples', async () => { requestApi.mockImplementation(async (path) => path.includes('/alerts') ? page([{ id: 'a1', rule: 'cpu', title: 'CPU 告警', status: 'resolved', value: 20, threshold: 80, firstSeenAt: 1, lastSeenAt: 2, resolvedAt: 3 }]) : monitoring); mountShell('/admin/monitoring'); await screen.findByText('进程尚无采样，当前运行指标未知。'); expect(await screen.findByText('CPU 告警')).toBeInTheDocument(); expect(screen.getByText('已恢复')).toBeInTheDocument(); expect(screen.getByText('400 B')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '调整阈值' })); expect(screen.getByLabelText('CPU 使用率（%）')).toHaveValue(80); });
  it('shows current sessions and paginates connections independently', async () => { requestApi.mockImplementation(async (path) => path.includes('/connections') ? page([{ id: 'c1', userId: 'u1', sessionId: 's1', connectedAt: 1 }], 'next-c') : page([{ id: 's1', user, device: '本机浏览器', createdAt: 1, lastSeenAt: 2, expiresAt: 3, revokedAt: null, active: true, connectionCount: 1, current: true }])); mountShell('/admin/sessions?userId=u1'); await screen.findByText('当前会话'); const connections = screen.getByRole('region', { name: '实时连接列表' }).parentElement!; fireEvent.click(within(connections).getByRole('link', { name: '下一页' })); expect(window.location.search).toContain('connectionsAfter=next-c'); expect(window.location.search).not.toContain('&after='); });
  it('keeps blocked relations read-only while exposing friendship removal', async () => { requestApi.mockResolvedValue(page([{ id: 'b1', kind: 'block', users: [user], status: 'active', createdAt: 1, updatedAt: 2, conversationId: null, version: 1 }])); const view = mountShell('/admin/relations?kind=block'); await screen.findByText('只读记录'); expect(screen.queryByRole('button', { name: '解除好友关系' })).not.toBeInTheDocument(); view.unmount(); requestApi.mockResolvedValue(page([{ id: 'r1', kind: 'friendship', users: [user], status: 'active', createdAt: 1, updatedAt: 2, conversationId: null, version: 1 }])); mountShell('/admin/relations?kind=friendship'); expect(await screen.findByRole('button', { name: '解除好友关系' })).toBeInTheDocument(); });
  it('fetches group detail, members, invitations and applications through separate cursor paths', async () => { requestApi.mockImplementation(async (path) => { if (path.includes('/members')) return page([member], 'member-next'); if (path.includes('/invites') || path.includes('/applications')) return page([]); return { group, members: page([]), invites: page([]), applications: page([]) }; }); mountShell('/admin/groups/g1?invitesAfter=invite-next&applicationsAfter=application-next'); await screen.findByRole('button', { name: '纠正群主' }); await screen.findByRole('button', { name: '纠正角色' }); expect(requestApi.mock.calls.some(([path]) => path.includes('/invites?after=invite-next'))).toBe(true); expect(requestApi.mock.calls.some(([path]) => path.includes('/applications?after=application-next'))).toBe(true); const members = screen.getByRole('region', { name: '群成员' }).parentElement!; fireEvent.click(within(members).getByRole('link', { name: '下一页' })); expect(window.location.search).toContain('membersAfter=member-next'); expect(window.location.search).toContain('invitesAfter=invite-next'); });
});

describe('M7 ADMIN account restriction refresh', () => {
  const oldRestrictions = { uploadDisabled: true, groupCreationDisabled: true, reason: '旧限制', mutedUntil: null, muteReason: '' };
  const latestRestrictions = { uploadDisabled: false, groupCreationDisabled: false, reason: '管理员已核实解除', mutedUntil: null, muteReason: '' };
  const account: UserView = { ...actor, id: 'current-user', nickname: '打开时昵称', bio: '打开时简介', restrictions: oldRestrictions };
  function settings(value = account) { return <AccountSettings user={value} onUserChange={vi.fn()} onSignedOut={vi.fn()} />; }
  function changed(userId: string) { window.dispatchEvent(new CustomEvent('tongpin:account-changed', { detail: { userId } })); }
  it('reads current restrictions on opening instead of trusting an old bootstrap prop and preserves drafts', async () => {
    const pending = deferred<unknown>(); requestApi.mockImplementation((path) => path === '/api/v1/auth/me' ? pending.promise : Promise.resolve({ items: [] })); render(<>{settings()}<ProfileSettings user={account} onUserChange={vi.fn()} /></>); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' }));
    expect(screen.getByText('正在核对当前账号限制…')).toBeInTheDocument(); fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '正在编辑的昵称' } }); fireEvent.change(screen.getByLabelText('个人简介'), { target: { value: '正在编辑的简介' } });
    await act(async () => { pending.resolve({ user: { ...account, nickname: '服务器的新昵称', bio: '服务器的新简介', restrictions: latestRestrictions } }); });
    expect(screen.getByText('上传：未限制')).toBeInTheDocument(); expect(screen.getByText('限制理由：管理员已核实解除')).toBeInTheDocument(); expect(screen.getByLabelText('昵称')).toHaveValue('正在编辑的昵称'); expect(screen.getByLabelText('个人简介')).toHaveValue('正在编辑的简介');
  });
  it('refreshes on an ID-only matching event and ignores other identities', async () => {
    let response = { ...account }; requestApi.mockImplementation(async (path) => path === '/api/v1/auth/me' ? { user: response } : { items: [] }); render(settings()); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); await waitFor(() => expect(screen.queryByText('正在核对当前账号限制…')).not.toBeInTheDocument());
    await act(async () => changed('unrelated-user')); expect(requestApi.mock.calls.filter(([path]) => path === '/api/v1/auth/me')).toHaveLength(1);
    response = { ...account, restrictions: latestRestrictions }; await act(async () => changed(account.id)); expect(screen.getByText('限制理由：管理员已核实解除')).toBeInTheDocument(); expect(requestApi.mock.calls.filter(([path]) => path === '/api/v1/auth/me')).toHaveLength(2);
  });
  it('refreshes through the existing device/security button and discards an older in-flight result', async () => {
    const first = deferred<unknown>(); const next = deferred<unknown>(); let requests = 0; requestApi.mockImplementation((path) => path === '/api/v1/auth/me' ? (++requests === 1 ? first.promise : next.promise) : Promise.resolve({ items: [] })); render(settings()); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); const firstSignal = requestApi.mock.calls.find(([path]) => path === '/api/v1/auth/me')?.[1]?.signal;
    fireEvent.click(screen.getByRole('tab', { name: '登录设备' })); fireEvent.click(screen.getByRole('button', { name: '刷新设备和安全记录' })); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); expect(firstSignal?.aborted).toBe(true); await act(async () => { next.resolve({ user: { ...account, restrictions: latestRestrictions } }); }); await act(async () => { first.resolve({ user: { ...account, restrictions: { ...oldRestrictions, reason: '迟到旧限制' } } }); });
    expect(screen.getByText('限制理由：管理员已核实解除')).toBeInTheDocument(); expect(screen.queryByText('限制理由：迟到旧限制')).not.toBeInTheDocument(); expect(requests).toBe(2);
  });
  it('rejects a late response across user changes and clears the old restriction presentation immediately', async () => {
    const old = deferred<unknown>(); const next = deferred<unknown>(); let requests = 0; requestApi.mockImplementation((path) => path === '/api/v1/auth/me' ? (++requests === 1 ? old.promise : next.promise) : Promise.resolve({ items: [] })); const view = render(settings()); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); const oldSignal = requestApi.mock.calls.find(([path]) => path === '/api/v1/auth/me')?.[1]?.signal;
    const other = { ...account, id: 'other-user', restrictions: { ...latestRestrictions, reason: '新账号已知状态' } }; view.rerender(settings(other)); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); expect(oldSignal?.aborted).toBe(true); expect(screen.queryByText('限制理由：旧限制')).not.toBeInTheDocument();
    await act(async () => { old.resolve({ user: { ...account, restrictions: { ...oldRestrictions, reason: '旧账号敏感限制' } } }); }); expect(screen.queryByText('限制理由：旧账号敏感限制')).not.toBeInTheDocument();
    await act(async () => { next.resolve({ user: { ...other, restrictions: { ...latestRestrictions, reason: '新账号实时状态' } } }); }); expect(screen.getByText('限制理由：新账号实时状态')).toBeInTheDocument();
  });
  it('cancels on unmount and removes the event subscription', async () => {
    const pending = deferred<unknown>(); requestApi.mockImplementation((path) => path === '/api/v1/auth/me' ? pending.promise : Promise.resolve({ items: [] })); const view = render(settings()); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); const signal = requestApi.mock.calls.find(([path]) => path === '/api/v1/auth/me')?.[1]?.signal; view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { changed(account.id); pending.resolve({ user: { ...account, restrictions: { ...oldRestrictions, reason: '卸载后的限制' } } }); }); expect(requestApi.mock.calls.filter(([path]) => path === '/api/v1/auth/me')).toHaveLength(1); expect(screen.queryByText('限制理由：卸载后的限制')).not.toBeInTheDocument();
  });
  it('labels refresh failure as last-known data and allows explicit retry', async () => {
    let failing = true; requestApi.mockImplementation(async (path) => { if (path !== '/api/v1/auth/me') return { items: [] }; if (failing) throw new APIError(503, { code: 'UNAVAILABLE', message: '服务暂不可用' }); return { user: { ...account, restrictions: latestRestrictions } }; }); render(settings()); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' }));
    expect(await screen.findByText('当前账号限制核对失败：服务暂不可用')).toBeInTheDocument(); expect(screen.getByText('下方如有信息，仅代表上次已知状态。')).toBeInTheDocument(); failing = false; fireEvent.click(screen.getByRole('button', { name: '重新核对账号限制' })); await screen.findByText('限制理由：管理员已核实解除'); expect(screen.queryByText('当前账号限制核对失败：服务暂不可用')).not.toBeInTheDocument();
  });
  it('does not install a successful response belonging to another account', async () => {
    requestApi.mockImplementation(async (path) => path === '/api/v1/auth/me' ? { user: { ...account, id: 'wrong-account', restrictions: { ...latestRestrictions, reason: '不属于当前账号' } } } : { items: [] }); render(settings()); fireEvent.click(screen.getByRole('tab', { name: '账号使用限制' })); await screen.findByText('当前账号限制核对失败：返回账号与当前账号不一致，请重新核对。'); expect(screen.queryByText('限制理由：不属于当前账号')).not.toBeInTheDocument(); expect(screen.getByText('限制理由：旧限制')).toBeInTheDocument();
  });
});

describe('M7 ADMIN final copy and relation search', () => {
  it('distinguishes the five-minute claim window from the server-returned credential expiry', async () => {
    installCommands({ secret: true }); const original = requestApi.getMockImplementation()!; const expiresAt = Date.now() + 3600000;
    requestApi.mockImplementation((path, init) => path.endsWith('/secret') ? Promise.resolve({ credential: 'ONE-HOUR-RESET', username: 'user_one', expiresAt }) : original(path, init));
    mountAction({ action: 'user.password_reset', targetIds: ['u1'], labels: ['第一用户'] }); await previewAction(); await executeAction();
    expect(await screen.findByText('恢复凭据仅可由当前会话在生成后 5 分钟内领取一次；凭据有效期以领取后显示为准。')).toBeInTheDocument(); expect(screen.queryByText('恢复凭据仅可由当前会话读取一次，生成后 5 分钟内有效。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '显示一次性恢复凭据' })); await screen.findByText('ONE-HOUR-RESET'); expect(screen.getByText((text) => text.startsWith(`有效期至 ${new Date(expiresAt).toLocaleString('zh-CN')}。`))).toBeInTheDocument();
  });
  it('translates complete known status values while preserving free-form preview explanations', async () => {
    installCommands(); const original = requestApi.getMockImplementation()!; requestApi.mockImplementation(async (path, init) => {
      const value = await original(path, init);
      if (path.endsWith('/preview')) return { ...(value as object), targets: [{ id: 'u1', label: '单枚举状态', detail: 'active' }, { id: 'u2', label: '自由说明', detail: 'active 状态账号将退出全部设备' }, { id: 'u3', label: '非状态文本', detail: 'constructor' }] };
      return value;
    });
    const view = mountAction({ action: 'user.ban', targetIds: ['u1', 'u2', 'u3'], labels: ['第一用户', '第二用户', '第三用户'] }); await previewAction(); expect(screen.getByText('正常')).toBeInTheDocument(); expect(screen.getByText('active 状态账号将退出全部设备')).toBeInTheDocument(); expect(screen.getByText('constructor')).toBeInTheDocument(); view.unmount();
    requestApi.mockResolvedValue(page([{ id: 'r1', kind: 'request', users: [user], status: 'accepted', createdAt: 1, updatedAt: 2, conversationId: null, version: 1 }])); mountShell('/admin/relations?kind=request'); expect(await screen.findByRole('cell', { name: '已接受' })).toBeInTheDocument(); expect(screen.queryByRole('cell', { name: 'accepted' })).not.toBeInTheDocument();
  });
  it('submits relation search as query, retains it through pagination and restores it after remount', async () => {
    requestApi.mockResolvedValue(page([{ id: 'r1', kind: 'request', users: [user], status: 'accepted', createdAt: 1, updatedAt: 2, conversationId: null, version: 1 }], 'next-relation'));
    const view = mountShell('/admin/relations?kind=request&status=accepted&query=old&after=old-cursor'); await screen.findByRole('cell', { name: '已接受' }); expect(screen.getByLabelText('搜索用户名或昵称')).toHaveValue('old');
    fireEvent.change(screen.getByLabelText('搜索用户名或昵称'), { target: { value: '新的 名称' } }); fireEvent.click(screen.getByRole('button', { name: '应用筛选' })); await waitFor(() => expect(new URLSearchParams(window.location.search).get('query')).toBe('新的 名称')); expect(new URLSearchParams(window.location.search).has('after')).toBe(false);
    await screen.findByRole('cell', { name: '已接受' }); expect(requestApi.mock.calls.at(-1)?.[0]).toContain('query=%E6%96%B0%E7%9A%84+%E5%90%8D%E7%A7%B0'); fireEvent.click(screen.getByRole('link', { name: '下一页' })); expect(new URLSearchParams(window.location.search).get('query')).toBe('新的 名称'); expect(new URLSearchParams(window.location.search).get('after')).toBe('next-relation');
    const url = window.location.pathname + window.location.search; view.unmount(); mountShell(url); expect(screen.getByLabelText('搜索用户名或昵称')).toHaveValue('新的 名称'); await screen.findByRole('cell', { name: '已接受' }); expect(requestApi.mock.calls.at(-1)?.[0]).toContain('after=next-relation');
  });
});

describe('M7 ADMIN monitoring refresh lifecycle', () => {
  const alert = (title: string) => ({ id: 'monitor-alert', rule: 'failedJobs', title, status: 'active' as const, value: 2, threshold: 1, firstSeenAt: 1, lastSeenAt: 2, resolvedAt: null });
  let originalVisibility: PropertyDescriptor | undefined;
  beforeEach(() => { originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState'); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
  afterEach(() => { if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility); else Reflect.deleteProperty(document, 'visibilityState'); });
  function visibility(value: 'hidden' | 'visible') { Object.defineProperty(document, 'visibilityState', { configurable: true, value }); document.dispatchEvent(new Event('visibilitychange')); }
  it('manual refresh must read and display the latest alerts as well as monitoring', async () => {
    let title = '刷新前告警'; requestApi.mockImplementation(async (path) => path.includes('/alerts') ? page([alert(title)]) : { ...monitoring, alerts: page([alert(title)]) }); mountShell('/admin/monitoring'); await screen.findByText('刷新前告警');
    title = '刷新后告警'; await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新监控' })); }); expect(screen.queryByText('刷新后告警')).not.toBeNull(); expect(screen.queryByText('刷新前告警')).toBeNull();
  });
  it('polls every ten seconds only while visible and does not catch up in a burst after hiding', async () => {
    vi.useFakeTimers(); let generation = 0; requestApi.mockImplementation(async (path) => path.includes('/alerts') ? page([alert(`周期告警 ${generation}`)]) : (++generation, monitoring));
    visibility('hidden'); await act(async () => { mountShell('/admin/monitoring'); }); expect(requestApi).not.toHaveBeenCalled(); await act(async () => { visibility('visible'); }); expect(requestApi).toHaveBeenCalledTimes(2); expect(screen.getByText('周期告警 1')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(9999); }); expect(requestApi).toHaveBeenCalledTimes(2); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(requestApi).toHaveBeenCalledTimes(4); expect(screen.getByText('周期告警 2')).toBeInTheDocument();
    await act(async () => { visibility('hidden'); await vi.advanceTimersByTimeAsync(60000); }); expect(requestApi).toHaveBeenCalledTimes(4); await act(async () => { visibility('visible'); await vi.advanceTimersByTimeAsync(9999); }); expect(requestApi).toHaveBeenCalledTimes(4); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(requestApi).toHaveBeenCalledTimes(6);
  });
  it('waits for both slow requests to finish before starting the next ten-second interval', async () => {
    vi.useFakeTimers(); const slowMonitor = deferred<unknown>(); const slowAlerts = deferred<unknown>(); let slow = false;
    requestApi.mockImplementation((path) => slow ? path.includes('/alerts') ? slowAlerts.promise : slowMonitor.promise : Promise.resolve(path.includes('/alerts') ? page([alert('初始告警')]) : monitoring)); await act(async () => { mountShell('/admin/monitoring'); }); slow = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(requestApi).toHaveBeenCalledTimes(4); expect(screen.getByRole('button', { name: '刷新监控' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '刷新监控' })); await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(requestApi).toHaveBeenCalledTimes(4);
    await act(async () => { slowMonitor.resolve({ ...monitoring, policyVersion: 4 }); await vi.advanceTimersByTimeAsync(30000); }); expect(requestApi).toHaveBeenCalledTimes(4); expect(screen.getByRole('button', { name: '刷新监控' })).toBeDisabled();
    await act(async () => { slowAlerts.resolve(page([alert('慢请求完成告警')])); }); expect(screen.getByText('慢请求完成告警')).toBeInTheDocument(); expect(screen.getByRole('button', { name: '刷新监控' })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(9999); }); expect(requestApi).toHaveBeenCalledTimes(4); slow = false; await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(requestApi).toHaveBeenCalledTimes(6);
  });
  it('retains table nodes and scroll offsets while loading and labels failed refreshes with old timestamps', async () => {
    const pendingMonitor = deferred<unknown>(); const pendingAlerts = deferred<unknown>(); const oldSampleAt = Date.UTC(2026, 8, 11, 9, 0); let pending = false;
    requestApi.mockImplementation((path) => pending ? path.includes('/alerts') ? pendingAlerts.promise : pendingMonitor.promise : Promise.resolve(path.includes('/alerts') ? page([alert('保留的告警')]) : { ...monitoring, sampledAt: oldSampleAt })); mountShell('/admin/monitoring'); await screen.findByText('保留的告警');
    const table = screen.getByRole('region', { name: '当前进程采样历史（最近在前）' }); const alerts = screen.getByRole('region', { name: '告警与恢复记录' }); table.scrollTop = 120; table.scrollLeft = 35; alerts.scrollTop = 60; alerts.scrollLeft = 20; pending = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新监控' })); }); expect(screen.getByRole('region', { name: '当前进程采样历史（最近在前）' })).toBe(table); expect(screen.getByText('保留的告警')).toBeInTheDocument(); expect(table.scrollTop).toBe(120);
    await act(async () => { pendingMonitor.resolve(Promise.reject(new APIError(503, { message: '监控服务临时失败' }))); pendingAlerts.resolve(Promise.reject(new APIError(503, { message: '告警服务临时失败' }))); });
    expect(screen.getByText((text) => text.includes('监控刷新失败：监控服务临时失败') && text.includes(`旧样本时间 ${new Date(oldSampleAt).toLocaleString('zh-CN')}`))).toBeInTheDocument(); expect(screen.getByText((text) => text.includes('告警刷新失败：告警服务临时失败') && text.includes('上次成功读取'))).toBeInTheDocument(); expect(screen.getByText('保留的告警')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '告警与恢复记录' })).toBe(alerts); expect([table.scrollTop, table.scrollLeft, alerts.scrollTop, alerts.scrollLeft]).toEqual([120, 35, 60, 20]);
    pending = false; await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新监控' })); }); expect(screen.queryByText((text) => text.includes('监控刷新失败：'))).not.toBeInTheDocument(); expect(screen.getByRole('region', { name: '告警与恢复记录' })).toBe(alerts);
  });
  it('refreshes the current alert cursor rather than substituting monitoring first-page alerts', async () => {
    let version = 1; requestApi.mockImplementation(async (path) => path.includes('/alerts') ? page([alert(`当前页告警 ${version}`)], 'later-cursor') : { ...monitoring, alerts: page([alert('错误的首屏告警')]) }); mountShell('/admin/monitoring?after=opaque%2Fcursor%2B'); await screen.findByText('当前页告警 1'); expect(screen.queryByText('错误的首屏告警')).not.toBeInTheDocument();
    version = 2; await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新监控' })); }); expect(screen.getByText('当前页告警 2')).toBeInTheDocument(); const alertCalls = requestApi.mock.calls.filter(([path]) => path.includes('/alerts')); expect(alertCalls).toHaveLength(2); expect(alertCalls.every(([path]) => path.includes('after=opaque%2Fcursor%2B'))).toBe(true); expect(new URLSearchParams(window.location.search).get('after')).toBe('opaque/cursor+');
  });
  it('aborts both old requests when the identity-keyed shell is replaced and ignores their late receipts', async () => {
    const oldMonitor = deferred<unknown>(); const oldAlerts = deferred<unknown>(); let fresh = false;
    requestApi.mockImplementation((path) => fresh ? Promise.resolve(path.includes('/alerts') ? page([alert('新身份告警')]) : monitoring) : path.includes('/alerts') ? oldAlerts.promise : oldMonitor.promise);
    window.history.replaceState({}, '', '/admin/monitoring'); const view = render(<AdminShell key={actor.id} user={actor} onSignOut={vi.fn()} signOutBusy={false} signOutError="" />); const signals = requestApi.mock.calls.map(([, init]) => init?.signal); fresh = true;
    view.rerender(<AdminShell key="next-admin" user={{ ...actor, id: 'next-admin' }} onSignOut={vi.fn()} signOutBusy={false} signOutError="" />); await screen.findByText('新身份告警'); expect(signals.every((signal) => signal?.aborted)).toBe(true);
    await act(async () => { oldMonitor.resolve({ ...monitoring, policyVersion: 999 }); oldAlerts.resolve(page([alert('旧身份迟到告警')])); }); expect(screen.queryByText('旧身份迟到告警')).not.toBeInTheDocument(); expect(screen.getByText('新身份告警')).toBeInTheDocument(); const currentSignals = requestApi.mock.calls.slice(2).map(([, init]) => init?.signal); view.unmount(); expect(currentSignals.every((signal) => signal?.aborted)).toBe(true);
  });
  it('cancels the companion request and stops polling immediately after a permission failure', async () => {
    vi.useFakeTimers(); const monitorPending = deferred<unknown>(); requestApi.mockImplementation((path) => path.includes('/alerts') ? Promise.reject(new APIError(403, { code: 'ADMIN_REQUIRED', message: '管理权限失效' })) : monitorPending.promise);
    await act(async () => { mountShell('/admin/monitoring'); }); expect(screen.getByRole('heading', { name: '管理权限已失效' })).toBeInTheDocument(); expect(requestApi.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await act(async () => { monitorPending.resolve({ ...monitoring, policyVersion: 999 }); await vi.advanceTimersByTimeAsync(60000); }); expect(requestApi).toHaveBeenCalledTimes(2); expect(screen.queryByRole('heading', { name: '系统监控' })).not.toBeInTheDocument(); expect(screen.queryByText('告警与恢复')).not.toBeInTheDocument();
  });
});
