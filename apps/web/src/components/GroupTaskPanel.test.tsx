// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TaskClient } from '../lib/tasks-client';
import type { GroupTaskSettings, Task, TaskPage, TaskQuery, TaskState } from '../lib/tasks-types';
import { GroupTaskPanel } from './GroupTaskPanel';

const person = { id: 'u1', username: 'alice', nickname: '小林', avatarUrl: null };
const task: Task = {
  id: 't1', scope: 'group', groupId: 'g1', groupName: '设计组', ownerId: null,
  creator: person, assignee: person, title: '核对上线清单', description: '群内任务内容',
  priority: 'normal', status: 'todo', dueOn: '2026-09-15', dueTimezone: 'Asia/Shanghai',
  overdue: false, completedAt: null, createdAt: 1, updatedAt: 2, deletedAt: null,
  version: 1, etag: '"v1"', checkItems: [], source: null,
  capabilities: { edit: true, progress: true, assign: true, claim: false, release: false,
    checkStructure: true, checkToggle: true, remove: true, restore: false, comment: true,
    share: true, copyToGroup: false, writeReason: null },
  followed: false, bookmarked: false, listId: null, tagIds: [],
  reminder: { rule: 'none', time: '09:00' }, viewerId: 'u1',
};

function fixture({ online = true, canCreate = true, value = task }: { online?: boolean; canCreate?: boolean; value?: Task } = {}) {
  let state: TaskState = { revision: 0, listRevision: 0, entities: { [value.id]: value }, invalid: {},
    online, enabled: true, enhanced: true, error: null };
  const listeners = new Set<() => void>();
  const settings: GroupTaskSettings = { groupId: 'g1', createPolicy: 'members', canManage: false,
    canCreate, etag: 'g-v1', count: 3, quota: 500, writeReason: canCreate ? null : '仅管理员可创建群待办。' };
  const mock = {
    userId: 'u1',
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getSnapshot: () => state,
    list: vi.fn(async (query: TaskQuery): Promise<TaskPage> => ({ items: query.status === 'done' ? [] : [value],
      total: query.status === 'done' ? 2 : 1, actorId: 'u1', nextCursor: null })),
    groupSettings: vi.fn(async () => settings),
  };
  const callbacks = { onOpenTask: vi.fn(), onViewAll: vi.fn(), onCreate: vi.fn() };
  const props = { client: mock as unknown as TaskClient, groupId: 'g1', ...callbacks };
  return { mock, props, callbacks, set: (patch: Partial<TaskState>) => {
    state = { ...state, ...patch, revision: state.revision + 1 };
    listeners.forEach((fn) => fn());
  } };
}

afterEach(cleanup);

describe('group task panel authorized summaries', () => {
  it('opens the real task and group workspace, and delegates creation when permitted', async () => {
    const f = fixture(); render(<GroupTaskPanel {...f.props} />);
    const open = await screen.findByRole('button', { name: /核对上线清单.*小林/ });
    expect(screen.getByText('2 / 3 已完成')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '本群任务完成比例' })).toHaveAttribute('value', '2');
    fireEvent.click(open);
    expect(f.callbacks.onOpenTask).toHaveBeenCalledWith('t1');
    fireEvent.click(screen.getByRole('button', { name: /查看全部/ }));
    expect(f.callbacks.onViewAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '创建群待办' }));
    expect(f.callbacks.onCreate).toHaveBeenCalledTimes(1);
  });

  it('hides the old task title as soon as its entity becomes invalid', async () => {
    const f = fixture(); render(<GroupTaskPanel {...f.props} />);
    await screen.findByText(task.title);
    act(() => f.set({ invalid: { t1: true } }));
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /标记完成/ })).not.toBeInTheDocument();
    expect(screen.getByText('暂时没有未完成的待办。')).toBeInTheDocument();
  });

  it('does not restore a removed group task after access is revoked and reload fails', async () => {
    const f = fixture(); render(<GroupTaskPanel {...f.props} />);
    await screen.findByText(task.title);
    f.mock.list.mockRejectedValue(new Error('当前用户已退出群聊'));
    f.mock.groupSettings.mockRejectedValue(new Error('群访问权限已失效'));
    act(() => f.set({ entities: {}, invalid: { t1: true }, listRevision: 1 }));
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    await screen.findByText('暂时无法读取群待办。');
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建群待办' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '创建群待办' }));
    expect(f.callbacks.onCreate).not.toHaveBeenCalled();
  });

  it('clears the previous group summary while a different group is loading', async () => {
    const f = fixture(); const view = render(<GroupTaskPanel {...f.props} />);
    await screen.findByText(task.title);
    f.mock.list.mockImplementation(() => new Promise<TaskPage>(() => {}));
    view.rerender(<GroupTaskPanel {...f.props} groupId="g2" />);
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    expect(screen.queryByText('2 / 3 已完成')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建群待办' })).toBeDisabled();
  });

  it('disables creation and removes the cached summary when connectivity is lost', async () => {
    const f = fixture(); render(<GroupTaskPanel {...f.props} />);
    await screen.findByText(task.title);
    act(() => f.set({ online: false }));
    expect(screen.getByText('连接恢复后同步群待办。')).toBeInTheDocument();
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: '创建群待办' });
    expect(create).toBeDisabled(); fireEvent.click(create);
    expect(f.callbacks.onCreate).not.toHaveBeenCalled();
  });

  it('shows a read-only task but refuses creation when the group disallows it', async () => {
    const f = fixture({ canCreate: false, value: { ...task, capabilities: { ...task.capabilities, progress: false, writeReason: '当前只能查看' } } });
    render(<GroupTaskPanel {...f.props} />);
    await screen.findByText(task.title);
    expect(screen.getByText('仅管理员可创建群待办。')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: '创建群待办' });
    expect(create).toBeDisabled(); fireEvent.click(create);
    expect(f.callbacks.onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `标记完成：${task.title}` })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /核对上线清单.*小林/ }));
    expect(f.callbacks.onOpenTask).toHaveBeenCalledWith('t1');
  });

  it.each([
    { name: 'another viewer', value: { ...task, viewerId: 'u2' } },
    { name: 'another group', value: { ...task, groupId: 'g2' } },
  ])('never renders a cached entity belonging to $name', async ({ value }) => {
    const f = fixture({ value }); render(<GroupTaskPanel {...f.props} />);
    await screen.findByText('暂时没有未完成的待办。');
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
  });
});