// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OfflineQueuePage } from './OfflineQueuePage';
import type { QueuedMessage } from './lib/chat-types';
const item = (key: string, conversationId: string, createdAt: number, state: QueuedMessage['state'], errorCode: string | null = null): QueuedMessage => ({ key, conversationId, conversationTitle: conversationId, userId: 'u', createdAt, state, errorCode, error: null, expiresAt: 10000, attempts: 0, retryAt: 0, files: [], payload: { clientMessageId: key, text: key, attachmentIds: [], replyToMessageId: null, mentionedUserIds: [], accessKey: 'a' } });
const actions = () => ({ onRetry: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onCopyToDraft: vi.fn(async () => {}) });
afterEach(cleanup);
const card = (name: string) => within(screen.getByText(name, { exact: true }).closest('li')!);
describe('outbox recovery presentation', () => {
  it('labels only queued messages behind their own earliest failed item and updates when it disappears', () => {
    const props = actions(); const failed = item('old', 'A', 1, 'failed', 'STALE_ACCESS'); const next = item('next', 'A', 2, 'queued'); const other = item('other', 'B', 3, 'queued');
    const view = render(<OfflineQueuePage items={[next, other, failed]} {...props} />);
    expect(card('next').getByText('等待前一条失败消息处理')).toBeInTheDocument();
    expect(card('other').getByText('已存本机 · 等待投递')).toBeInTheDocument();
    view.rerender(<OfflineQueuePage items={[next, other]} {...props} />);
    expect(screen.queryByText('等待前一条失败消息处理')).not.toBeInTheDocument();
    expect(card('next').getByText('已存本机 · 等待投递')).toBeInTheDocument();
  });
  it.each(['queued', 'sending'] as const)('does not label a later failure as the head when the earliest is %s', (state) => {
    render(<OfflineQueuePage items={[item('failure', 'A', 2, 'failed'), item('tail', 'A', 3, 'queued'), item('head', 'A', 1, state)]} {...actions()} />);
    expect(screen.queryByText('等待前一条失败消息处理')).not.toBeInTheDocument();
  });
  it('uses the stable key order for equal creation times', () => {
    render(<OfflineQueuePage items={[item('z-tail', 'A', 1, 'queued'), item('a-head', 'A', 1, 'failed')]} {...actions()} />);
    expect(card('z-tail').getByText('等待前一条失败消息处理')).toBeInTheDocument();
  });
  it.each(['STALE_ACCESS', 'IDEMPOTENCY_CONFLICT', 'OUTBOX_EXPIRED'])('offers copy and stop rather than ineffective retry for %s', async (code) => {
    const props = actions(); render(<OfflineQueuePage items={[item('failure', 'A', 1, 'failed', code)]} {...props} />);
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(screen.getByText(/这条消息不能直接重试/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复制到编辑器' }));
    expect(props.onCopyToDraft).toHaveBeenCalledTimes(1); expect(props.onCancel).not.toHaveBeenCalled(); expect(props.onRetry).not.toHaveBeenCalled();
  });
});
