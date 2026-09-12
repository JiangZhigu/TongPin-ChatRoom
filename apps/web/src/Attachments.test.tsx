// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { AttachmentList, LocalAttachmentList } from './AttachmentViews';
import { Composer } from './components/Composer';
import { MessageTimeline } from './components/MessageTimeline';
import { FilesPage } from './FilesPage';
import { AvatarEditor } from './AvatarEditor';
import { ProfileSettings } from './ProfileSettings';
import { GroupManagementPanel } from './GroupManagementPanel';
import type { Attachment, Conversation, LocalAttachment } from './lib/chat-types';
import type { UploadRecord } from './lib/files-types';
import type { UserView } from './auth-types';
import { APIError } from './lib/api';

const calls = vi.hoisted(() => ({ api: vi.fn<(path: string, options?: { body?: unknown; signal?: AbortSignal }) => Promise<unknown>>(), upload: vi.fn<(...args: unknown[]) => Promise<UploadRecord>>() }));
vi.mock('./lib/api', async (original) => ({ ...await original<typeof import('./lib/api')>(), api: calls.api }));
vi.mock('./lib/files', async (original) => ({ ...await original<typeof import('./lib/files')>(), uploadLocalAttachment: calls.upload }));
const local = (name = '实际.txt', mime = 'text/plain'): LocalAttachment => ({ id: name, name, mime, blob: new File(['文件字节'], name, { type: mime }) });
const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({ id: 'attachment-a', name: '说明.txt', size: 128, mime: 'text/plain', kind: 'file', contentUrl: '/api/v1/attachments/attachment-a/content', ...overrides });
const upload = (state: UploadRecord['state'] = 'ready'): UploadRecord => ({ ...attachment({ name: '头像.png', mime: 'image/png', kind: 'image' }), state, purpose: 'user_avatar', conversationId: null, scanStatus: 'not_scanned', error: null, errorCode: null, createdAt: 1, expiresAt: 1000, bound: false });
const user: UserView = { id: 'actor-a', username: 'actor_a', nickname: '本人', avatarUrl: '/api/v1/users/actor-a/avatar?v=1', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const conversation: Conversation = { id: 'group-a', title: '附件群', kind: 'group', description: '', peer: null, role: 'owner', periodId: 'period-a', accessKey: 'access-current', memberCount: 2, lastSeq: '0', readSeq: '0', peerReadSeq: null, unreadCount: 0, lastMessage: null, canSend: true, sendDisabledReason: null, sendErrorCode: null, updatedAt: 1, preferences: { muted: false, pinned: false, archived: false } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  calls.api.mockReset().mockResolvedValue({ items: [], nextCursor: null }); calls.upload.mockReset().mockResolvedValue(upload());
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:unit-test') }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('M6-UI followup MIME and download deadline', () => {
  it.each(['PNG', 'jpg', 'gif'])('accepts an allowed %s avatar with empty browser MIME without inventing a MIME value', (extension) => {
    render(<AvatarEditor actorContext={user.id} label={user.nickname} purpose="user_avatar" onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择个人头像图片'), { target: { files: [new File(['image bytes'], `头像.${extension}`, { type: '' })] } });
    expect(screen.getByRole('button', { name: '保存头像' })).toBeEnabled(); expect(calls.upload).not.toHaveBeenCalled();
  });
  it('rejects a non-image extension even when its browser MIME claims to be an image', () => {
    render(<AvatarEditor actorContext={user.id} label={user.nickname} purpose="user_avatar" onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择个人头像图片'), { target: { files: [new File(['text'], '伪装.txt', { type: 'image/png' })] } });
    expect(screen.getByText('头像仅支持 PNG、JPEG、WebP 或 GIF 图片。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '保存头像' })).not.toBeInTheDocument();
  });
  it.each(['response', 'body'])('times out a hanging %s at the full download deadline, permits retry and ignores the late result', async (stage) => {
    vi.useFakeTimers(); const late = deferred<Blob>(); const blob = new Blob(['actual bytes']);
    const fetchMock = vi.fn().mockImplementationOnce(() => stage === 'response' ? late.promise.then(() => ({ ok: true, blob: async () => blob })) : Promise.resolve({ ok: true, blob: () => late.promise })).mockResolvedValue({ ok: true, blob: async () => blob }); vi.stubGlobal('fetch', fetchMock);
    render(<AttachmentList files={[attachment()]} />); const button = screen.getByRole('button', { name: '下载文件 说明.txt' }); fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(119_999); }); expect(button).toBeDisabled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(screen.getByText('下载超过 120 秒，已停止等待，请重试。')).toBeInTheDocument(); expect(button).toBeEnabled(); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => fireEvent.click(button)); expect(URL.createObjectURL).toHaveBeenCalledTimes(1); expect(button).toBeEnabled();
    await act(async () => late.resolve(blob)); expect(URL.createObjectURL).toHaveBeenCalledTimes(1); expect(screen.queryByText('下载超过 120 秒，已停止等待，请重试。')).not.toBeInTheDocument();
  });
  it('quietly cancels a pending body read and clears its timeout when the component unmounts', async () => {
    vi.useFakeTimers(); const late = deferred<Blob>(); const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => late.promise }); vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<AttachmentList files={[attachment()]} />); await act(async () => fireEvent.click(screen.getByRole('button', { name: '下载文件 说明.txt' })));
    await act(async () => unmount()); expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await act(async () => late.resolve(new Blob(['late bytes']))); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('M6-UI attachment presentation and file controls', () => {
  it('accepts real file selection, clipboard and drag files and preserves IME enter behavior', () => {
    const add = vi.fn(); const send = vi.fn(); const file = new File(['实字节'], '拖入.txt', { type: 'text/plain' });
    render(<Composer value="" onChange={vi.fn()} onSend={send} files={[local()]} onAddFiles={add} />);
    fireEvent.change(screen.getByLabelText('文件附件'), { target: { files: [file] } }); expect(add).toHaveBeenLastCalledWith([file]);
    fireEvent.paste(screen.getByLabelText('消息内容'), { clipboardData: { files: [file] } }); expect(add).toHaveBeenCalledTimes(2);
    fireEvent.drop(screen.getByLabelText('消息内容'), { dataTransfer: { files: [file] } }); expect(add).toHaveBeenCalledTimes(3);
    fireEvent.compositionStart(screen.getByLabelText('消息内容')); fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter', keyCode: 229 }); expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(screen.getByLabelText('消息内容')); fireEvent.keyDown(screen.getByLabelText('消息内容'), { key: 'Enter' }); expect(send).toHaveBeenCalledTimes(1);
  });
  it('revokes local thumbnail object URLs when the file is removed or the view unmounts', () => {
    const { rerender, unmount } = render(<LocalAttachmentList files={[local('图.png', 'image/png')]} />); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    rerender(<LocalAttachmentList files={[]} />); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:unit-test'); unmount();
  });
  it('labels GIF previews as static and only uses server preview URLs for enlarged images', () => {
    render(<AttachmentList files={[attachment({ name: '动图.gif', mime: 'image/gif', kind: 'image', thumbnailUrl: '/safe/thumb', previewUrl: '/safe/preview', frameCount: 3 })]} />);
    expect(screen.getByText(/静态预览，原件保留动画/)).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '预览图片 动图.gif' }));
    const dialog = screen.getByRole('dialog', { name: '动图.gif' }); expect(within(dialog).getByRole('img')).toHaveAttribute('src', '/safe/preview'); expect(screen.getByRole('button', { name: '下载原始动画 动图.gif' })).toBeInTheDocument();
  });
  it('shows an authorization error instead of generating a download when an attachment is no longer accessible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 })); render(<AttachmentList files={[attachment()]} />);
    fireEvent.click(screen.getByRole('button', { name: '下载文件 说明.txt' })); await screen.findByText('文件已不可访问，可能已撤回、删除或失去会话权限。'); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('downloads actual successful response bytes with authentication and releases the URL at unmount', async () => {
    const blob = new Blob(['下载字节']); const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob }); vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<AttachmentList files={[attachment()]} />); fireEvent.click(screen.getByRole('button', { name: '下载文件 说明.txt' }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(blob)); expect(fetchMock).toHaveBeenCalledWith('/api/v1/attachments/attachment-a/content', expect.objectContaining({ credentials: 'same-origin' })); unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:unit-test');
  });
  it('blocks a local copy when the current offline identity check fails', async () => {
    render(<LocalAttachmentList files={[local()]} allowDownload beforeDownload={async () => { throw new Error('本机身份已改变，下载已取消。'); }} />);
    fireEvent.click(screen.getByRole('button', { name: '下载本机副本 实际.txt' })); await screen.findByText('本机身份已改变，下载已取消。'); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('does not show downloadable attachments retained in a recalled message view', () => {
    render(<MessageTimeline messages={[{ id: 'm', author: '好友', own: false, text: '这条消息已撤回', timeLabel: '10:00', tombstone: true, attachments: [attachment()] }]} />);
    expect(screen.queryByRole('button', { name: /下载文件/ })).not.toBeInTheDocument(); expect(screen.getByText('这条消息已撤回')).toBeInTheDocument();
  });
  it('loads file policy, filters and next page using real API contracts without retaining a stale filter response', async () => {
    const first = deferred<unknown>();
    calls.api.mockImplementation(async (path) => path === '/api/v1/files/policy' ? { usedBytes: 100, reservedBytes: 0, userQuota: 1073741824, attachmentCount: 6, messageBytes: 52428800, imageLimit: 10485760, fileLimit: 26214400, supportedExtensions: [], scanPolicy: 'closed-test-unscanned', scanner: 'disabled' } : path.includes('kind=image') ? { items: [{ ...attachment({ id: 'image', name: '筛选后.png' }), conversationTitle: '附件群', senderName: '本人', messageId: 'm2', createdAt: 1 }], nextCursor: 'cursor-next' } : path.includes('after=cursor-next') ? { items: [], nextCursor: null } : first.promise);
    render(<FilesPage conversations={[conversation]} />); await screen.findByText(/not_scanned/); expect(screen.getByText(/上传预留 0 B/)).toBeInTheDocument(); fireEvent.change(screen.getByLabelText('文件类型'), { target: { value: 'image' } }); await screen.findByText('筛选后.png');
    await act(async () => first.resolve({ items: [{ ...attachment({ name: '旧筛选.txt' }), messageId: 'old', createdAt: 1 }], nextCursor: null })); expect(screen.queryByText('旧筛选.txt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更多文件' })); await waitFor(() => expect(calls.api.mock.calls.some(([path]) => path.includes('kind=image') && path.includes('after=cursor-next'))).toBe(true));
  });
});

describe('M6-UI avatar identity and ready binding', () => {
  const props = { actorContext: user.id, label: user.nickname, avatarUrl: user.avatarUrl, purpose: 'user_avatar' as const };
  function selectAvatar() { fireEvent.change(screen.getByLabelText('选择个人头像图片'), { target: { files: [new File(['png bytes'], '头像.png', { type: 'image/png' })] } }); }
  it('uses current user actorContext, waits for actual ready upload, then binds the returned attachment', async () => {
    const result = deferred<UploadRecord>(); calls.upload.mockImplementation(() => result.promise); const save = vi.fn().mockResolvedValue(undefined);
    render(<AvatarEditor {...props} onSave={save} />); selectAvatar(); fireEvent.click(screen.getByRole('button', { name: '保存头像' }));
    expect(calls.upload).toHaveBeenCalledWith(expect.objectContaining({ name: '头像.png' }), expect.objectContaining({ actorContext: user.id, purpose: 'user_avatar' }), expect.anything()); expect(save).not.toHaveBeenCalled();
    await act(async () => result.resolve(upload())); await waitFor(() => expect(save).toHaveBeenCalledWith('attachment-a', expect.any(AbortSignal))); await screen.findByText('头像已保存。');
  });
  it('retains the selected avatar and does not bind a quarantined upload', async () => {
    calls.upload.mockResolvedValue({ ...upload('quarantined'), error: '恶意软件扫描尚未可用' }); const save = vi.fn(); render(<AvatarEditor {...props} onSave={save} />); selectAvatar(); fireEvent.click(screen.getByRole('button', { name: '保存头像' }));
    await screen.findByText('恶意软件扫描尚未可用'); expect(screen.getByText('头像.png')).toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it('aborts a late upload at unmount and never applies it to a later identity', async () => {
    const result = deferred<UploadRecord>(); calls.upload.mockImplementation(() => result.promise); const save = vi.fn(); const { unmount } = render(<AvatarEditor {...props} onSave={save} />); selectAvatar(); fireEvent.click(screen.getByRole('button', { name: '保存头像' }));
    const options = calls.upload.mock.calls[0][2] as { signal: AbortSignal }; unmount(); expect(options.signal.aborted).toBe(true); await act(async () => result.resolve(upload())); expect(save).not.toHaveBeenCalled();
  });
  it('uses the account avatar PUT contract and updates the displayed authenticated user on removal', async () => {
    const changed = vi.fn(); calls.api.mockImplementation(async (path) => path === '/api/v1/me/avatar' ? { user: { ...user, avatarUrl: null } } : { items: [] });
    render(<ProfileSettings user={user} onUserChange={changed} />); fireEvent.click(screen.getByRole('button', { name: '移除头像' }));
    await waitFor(() => expect(calls.api).toHaveBeenCalledWith('/api/v1/me/avatar', expect.objectContaining({ method: 'PUT', body: { attachmentId: null } }))); expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: user.id, avatarUrl: null }));
  });
  it('binds group avatars with the current member actor/access and expected group version', async () => {
    const detail = { conversation: { ...conversation, avatarUrl: '/group/avatar' }, version: 7, settings: { announcement: '', announcementPinned: false, reviewRequired: true, inviteRole: 'managers', everyoneMuted: false, slowSeconds: 0 }, capabilities: { canEdit: true, canInvite: false, canReview: false, canAssignRoles: false, canTransfer: true, canDissolve: true, canLeave: false }, transfer: null };
    calls.api.mockResolvedValue(detail); const refresh = vi.fn().mockResolvedValue(undefined); render(<GroupManagementPanel conversationId={conversation.id} userId={user.id} friends={[]} hasMoreFriends={false} onLoadMoreFriends={vi.fn()} onClose={vi.fn()} onRefresh={refresh} onLeft={vi.fn()} />);
    const input = await screen.findByLabelText('选择群头像图片'); fireEvent.change(input, { target: { files: [new File(['png'], '群头像.png', { type: 'image/png' })] } }); fireEvent.click(screen.getByRole('button', { name: '保存头像' }));
    await waitFor(() => expect(calls.api).toHaveBeenCalledWith('/api/v1/groups/group-a/avatar', expect.objectContaining({ body: { attachmentId: 'attachment-a', expectedVersion: 7 } })));
    expect(calls.upload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorContext: user.id, conversationId: 'group-a', accessKey: 'access-current', purpose: 'group_avatar' }), expect.anything()); expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('shows a group version conflict without automatically resubmitting the avatar mutation', async () => {
    const save = vi.fn().mockRejectedValue(new APIError(409, { message: '群状态已变化，请刷新后重试。', code: 'VERSION_CONFLICT' })); render(<AvatarEditor {...props} purpose="group_avatar" conversationId="group-a" onSave={save} />);
    fireEvent.change(screen.getByLabelText('选择群头像图片'), { target: { files: [new File(['png'], '群.png', { type: 'image/png' })] } }); fireEvent.click(screen.getByRole('button', { name: '保存头像' })); await screen.findByText('群状态已变化，请刷新后重试。'); expect(save).toHaveBeenCalledTimes(1);
  });
});
