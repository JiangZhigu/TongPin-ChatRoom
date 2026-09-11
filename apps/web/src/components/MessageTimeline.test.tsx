// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MessageTimeline } from './MessageTimeline';
afterEach(cleanup);
it('uses the authoritative task card slot without rendering stale message fallback text', () => {
  render(<MessageTimeline messages={[{ id: 'm1', text: 'OLD-PRIVATE-TASK-TITLE', author: '甲', own: false, timeLabel: '09:00', taskCard: <div>待办暂不可用</div> }]} />);
  expect(screen.getByText('待办暂不可用')).toBeInTheDocument(); expect(screen.queryByText('OLD-PRIVATE-TASK-TITLE')).not.toBeInTheDocument();
});
it('does not render a card after its message becomes a tombstone', () => {
  render(<MessageTimeline messages={[{ id: 'm1', text: '这条消息已撤回', author: '甲', own: false, timeLabel: '09:00', tombstone: true, taskCard: <div>旧实时任务正文</div> }]} />);
  expect(screen.getByText('这条消息已撤回')).toBeInTheDocument(); expect(screen.queryByText('旧实时任务正文')).not.toBeInTheDocument();
});