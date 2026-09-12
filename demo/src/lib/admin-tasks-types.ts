import type { AdminIdentity, AdminPage } from './admin-types';
export type AdminTaskAction = 'task.delete' | 'task.restore' | 'task.comment.delete' | 'task.group.policy' | 'task_report.close' | 'task_report.reopen';
export type AdminTask = { id: string; groupId: string; title: string; status: 'todo' | 'doing' | 'done'; priority: 'low' | 'normal' | 'high'; dueOn: string | null; deletedAt: number | null; moderatedDeleted: boolean; canRestore: boolean; version: number; createdAt: number };
export type AdminTaskSearch = { reason: string; groupId: string; query?: string; status?: '' | 'todo' | 'doing' | 'done'; deleted?: '' | 'only' | 'all'; after?: string; limit?: number };
export type AdminGroupTasks = AdminPage<AdminTask> & { group: { id: string; name: string; status: string; createPolicy: 'members' | 'managers'; quota: number } };
export type AdminTaskComment = { id: string; text: string; removed: boolean; author: AdminIdentity; createdAt: number };
export type AdminTaskDetail = { task: AdminTask & { description: string; creator: AdminIdentity; assignee: AdminIdentity | null; checks: { id: string; text: string; done: number }[] }; comments: AdminPage<AdminTaskComment> };
export type AdminTaskReport = { id: string; category: 'spam' | 'harassment' | 'illegal' | 'other'; status: 'open' | 'closed'; createdAt: number; closedAt: number | null; version: number };
export type AdminTaskReportDetail = { report: AdminTaskReport & { description: string; feedback: string | null; reporter: AdminIdentity }; submitted: { title: string; scope: 'personal' | 'group'; groupId: string | null; description?: string; comment?: string; commentId?: string }; targetState: { available: boolean; deleted: boolean; moderatedDeleted: boolean; hasComment: boolean; commentRemoved: boolean } };
