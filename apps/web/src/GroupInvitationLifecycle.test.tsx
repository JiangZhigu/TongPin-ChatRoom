// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { setCsrfToken } from './lib/api';
import { dismissInvitation } from './lib/invitation';
import type { ChatState } from './lib/chat-types';
import type { UserView } from './auth-types';

// Preserve actual App, auth form, bootstrap, api and invitation capture; isolate
// only chat transport so assertions concern explicit invitation continuation.
vi.mock('./lib/chat-client', () => ({ ChatClient: class {
  state: ChatState = { phase: 'online', conversations: [], contacts: [], requests: [], notifications: [], notificationCount: 0, selectedId: null, messages: [], historyBefore: null, historyLoading: false, outbox: [], error: null, nextConversations: null, nextContacts: null, nextRequests: null, nextNotifications: null, onlineNotice: null };
  getSnapshot = () => this.state; subscribe = () => () => {}; subscribeTaskEvents = () => () => {}; start = async () => {}; stop = () => {}; updateUser = () => {}; refresh = async () => {};
} }));
const actor: UserView = { id: 'invite-user', username: 'invite_user', nickname: '邀请测试用户', bio: '', siteRole: 'user', status: 'active', createdAt: 1, preferences: { invisible: false, readReceipts: true, doNotDisturb: false } };
const token = 'lifecycle_group_invitation_token_12345678901234567890';
const reply = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) });
beforeEach(() => { dismissInvitation(); setCsrfToken(''); window.history.replaceState({}, '', `/#invite=${token}`); Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } }); });
afterEach(() => { cleanup(); dismissInvitation(); setCsrfToken(''); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

describe('M5-UI actual App invitation continuation', () => {
  it('strips token fragment under StrictMode, keeps invitation across login, and never auto-applies', async () => {
    let loggedIn = false; let captchaRequests = 0; const loginBodies: Record<string, unknown>[] = []; const applications: { url: string; options: RequestInit }[] = []; const previewHeaders: string[] = []; let bootstrapCalls = 0;
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
      expect(url).not.toContain(token); expect(String(options.body || '')).not.toContain(token);
      if (url.endsWith('/bootstrap')) { bootstrapCalls++; return reply({ accountsEnabled: true, registrationMode: 'closed', user: null, csrfToken: 'invite-anon-csrf', terms: { version: 'test', operatorName: 'test', operatorContact: 'test', development: true, text: '测试条款' } }); }
      if (url.endsWith('/captcha')) { captchaRequests++; return reply({ captchaId: 'captcha-invite', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 }); }
      if (url.endsWith('/auth/login')) { loginBodies.push(JSON.parse(options.body as string)); loggedIn = true; return reply({ user: actor, csrfToken: 'invite-auth-csrf', expiresAt: Date.now() + 60000 }); }
      if (url.endsWith('/group-invites/preview')) { previewHeaders.push(new Headers(options.headers).get('X-Group-Invite') || ''); return reply({ inviteId: 'invite-app', conversationId: 'group-app', name: '登录续接测试群', description: '只有公开简介', memberCount: 2, requiresApproval: true, expiresAt: Date.now() + 100000, maxUses: 10, remaining: 10, state: 'available', application: null }); }
      if (url.endsWith('/invite-app/apply')) { expect(loggedIn).toBe(true); applications.push({ url, options }); return reply({ id: 'application-app', conversationId: 'group-app', groupName: '登录续接测试群', inviteId: 'invite-app', user: actor, status: 'pending', currentMember: false, expiresAt: Date.now() + 100000, createdAt: 1 }); }
      throw new Error(`Unexpected UI HTTP request ${url}`);
    }));
    render(<StrictMode><App /></StrictMode>); await screen.findByText('只有公开简介'); expect(window.location.hash).toBe(''); expect(bootstrapCalls).toBe(1); expect(applications).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '登录或注册后继续' })); await screen.findByRole('heading', { name: '欢迎回来' }); expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument(); expect(captchaRequests).toBe(0);
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'invite_user' } }); fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'ui-test-password-only' } }); fireEvent.click(screen.getAllByRole('button', { name: '登录' }).at(-1)!);
    const applyButton = await screen.findByRole('button', { name: '确认申请加入' }); expect(applications).toHaveLength(0); expect(screen.getByText('只有公开简介')).toBeInTheDocument();
    expect(loginBodies).toEqual([{ username: 'invite_user', password: 'ui-test-password-only', remember: false }]); expect(captchaRequests).toBe(0);
    fireEvent.click(applyButton); await screen.findByText('等待管理员审核。'); expect(applications).toHaveLength(1); expect(new Headers(applications[0].options.headers).get('X-Group-Invite')).toBe(token); expect(new Headers(applications[0].options.headers).get('X-CSRF-Token')).toBe('invite-auth-csrf'); expect(previewHeaders.every((value) => value === token)).toBe(true); expect(localWrite.mock.calls.some((args) => args.some((value) => String(value).includes(token)))).toBe(false); expect(screen.queryByRole('button', { name: '打开群聊' })).not.toBeInTheDocument();
  });
});

describe('M5-UI hashchange invitation entry', () => {
  it('captures same-document invitation navigation after login and does not reopen dismissed tokens', async () => {
    window.history.replaceState({}, '', '/'); const freshToken = 'hash_navigation_invitation_token_12345678901234567890'; const headers: string[] = []; const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
      expect(url).not.toContain(freshToken); if (options.method === 'POST') writes.push(url);
      if (url.endsWith('/bootstrap')) return reply({ accountsEnabled: true, registrationMode: 'closed', user: actor, csrfToken: 'hash-auth-csrf', terms: { version: 'test', operatorName: 'test', operatorContact: 'test', development: true, text: '测试条款' } });
      if (url.endsWith('/group-invites/preview')) { headers.push(new Headers(options.headers).get('X-Group-Invite') || ''); return reply({ inviteId: 'hash-invite', conversationId: 'hash-group', name: '片段导航群', description: '新邀请的公开简介', memberCount: 2, requiresApproval: true, expiresAt: Date.now() + 100000, maxUses: 10, remaining: 10, state: 'available', application: null }); }
      throw new Error(`Unexpected hashchange UI HTTP request ${url}`);
    }));
    render(<StrictMode><App /></StrictMode>); await screen.findByRole('heading', { name: '欢迎来到同频' }); expect(screen.queryByRole('dialog', { name: '加入群聊' })).not.toBeInTheDocument();
    await act(async () => { window.history.pushState({}, '', `/#invite=${freshToken}`); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await screen.findByText('新邀请的公开简介'); expect(window.location.hash).toBe(''); expect(headers.every((value) => value === freshToken)).toBe(true); expect(headers.length).toBeGreaterThan(0); expect(writes).toHaveLength(0); expect(screen.getByRole('button', { name: '确认申请加入' })).toBeEnabled();
    fireEvent.click(within(screen.getByRole('dialog', { name: '加入群聊' })).getByRole('button', { name: '关闭对话框' })); const previewsBefore = headers.length;
    await act(async () => { window.history.pushState({}, '', '/#unrelated'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.queryByRole('dialog', { name: '加入群聊' })).not.toBeInTheDocument(); expect(headers).toHaveLength(previewsBefore); expect(writes).toHaveLength(0);
  });
});
