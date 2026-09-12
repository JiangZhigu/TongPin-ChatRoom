import type { QueuedMessage } from './chat-types';

const replacementRequired = new Set(['STALE_ACCESS', 'IDEMPOTENCY_CONFLICT', 'OUTBOX_EXPIRED']);
export const blockedOutboxLabel = '等待前一条失败消息处理';
export function canRetryOutbox(item: QueuedMessage) {
  return item.state !== 'sending' && !replacementRequired.has(item.errorCode || '');
}
export function failedOutboxGuidance(item: QueuedMessage) {
  return replacementRequired.has(item.errorCode || '')
    ? '这条消息不能直接重试。请先复制到编辑器保留内容，再停止这条消息的本机重试，让本会话后续消息继续。复制不会发送，原条目也不会自动移除。'
    : '请重试这条消息，或先复制到编辑器保留内容，再停止这条消息的本机重试，让本会话后续消息继续。';
}
// Mirror the visible queue order without mutating it or deciding delivery policy.
export function failedOutboxHeads(items: QueuedMessage[]) {
  const heads = new Map<string, QueuedMessage>();
  for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key))) {
    if (!heads.has(item.conversationId)) heads.set(item.conversationId, item);
  }
  return new Map([...heads].filter(([, item]) => item.state === 'failed'));
}
export function isWaitingOnFailedHead(item: QueuedMessage, heads: Map<string, QueuedMessage>) {
  const head = heads.get(item.conversationId);
  return item.state === 'queued' && !!head && head.key !== item.key;
}
