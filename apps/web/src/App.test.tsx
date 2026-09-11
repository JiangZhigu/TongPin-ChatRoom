// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';
import { ConversationList } from './components/ConversationList';
import { Composer } from './components/Composer';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
function healthyResponse(url: string) {
  const data = url === '/health/ready' ? { status: 'ready', version: '0.1.0', features: { accounts: false } } : { accountsEnabled: false, registrationMode: 'closed' };
  return Promise.resolve({ ok: true, json: async () => ({ data, requestId: 'test-only' }) });
}

describe('real service entry', () => {
  it('shows disabled account capability after checking both endpoints, without credentials or fake chats', async () => {
    const fetchMock = vi.fn(healthyResponse);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('基础服务已连接')).toBeInTheDocument();
    expect(screen.getByText('账号功能尚未启用，暂时无法登录或注册。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('消息记录')).not.toBeInTheDocument();
  });
  it('retries a failed service check and replaces the error only after a successful response', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('暂时无法连接服务')).toBeInTheDocument();
    fetchMock.mockImplementation(healthyResponse);
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(await screen.findByText('基础服务已连接')).toBeInTheDocument();
    expect(screen.queryByText('暂时无法连接服务')).not.toBeInTheDocument();
  });
  it('rejects a malformed successful response instead of presenting the service as ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
    render(<App />);
    expect(await screen.findByText('暂时无法连接服务')).toBeInTheDocument();
  });
  it('keeps the admin route separate and requires a real authenticated session', async () => {
    window.history.replaceState({}, '', '/admin');
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => ({ data: url.endsWith('/bootstrap') ? { accountsEnabled: true, user: null, csrfToken: 'test', registrationMode: 'closed', terms: { version: 'test', text: 'test' } } : { captchaId: 'test', image: 'data:image/png;base64,', expiresAt: Date.now() + 120000 } }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('heading', { name: '登录管理后台' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回同频' })).toHaveAttribute('href', '/');
    expect(screen.getByLabelText('动态码或第二因素恢复码')).toBeInTheDocument();
    expect(screen.queryByText('管理身份已确认')).not.toBeInTheDocument();
  });
});

describe('chat presentation boundaries', () => {
  it('distinguishes an empty conversation list from no search results', () => {
    render(<ConversationList conversations={[]} onSelect={vi.fn()} />);
    expect(screen.getByText('还没有会话')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: '查询' } });
    expect(screen.getByText('没有找到会话')).toBeInTheDocument();
  });
  it('never sends on IME confirmation, Shift+Enter or disabled access, but sends on plain Enter', async () => {
    const send = vi.fn();
    const { rerender } = render(<Composer value="一条待发送消息" onChange={vi.fn()} onSend={send} />);
    const textarea = screen.getByRole('textbox', { name: '消息内容' });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    rerender(<Composer value="一条待发送消息" onChange={vi.fn()} onSend={send} disabledReason="当前无法发送消息" />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(textarea).toBeDisabled();
  });
});
