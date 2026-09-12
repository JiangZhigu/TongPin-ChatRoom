import { actor, actorId, state, uid, now, save, publish, summary, page, must, matches, defaultTaskPreferences, CAPS, DemoError, type Row } from './state';
import { taskView, taskAccessible, getConversation, canSee } from './models';
import { sendMessage } from './core';

function changed(task: Row, kind = 'task.updated') { task.version++; task.updatedAt = now(); state.activities[task.id] ??= []; state.activities[task.id].unshift({ id: uid('activity'), kind, actor: summary(actorId()), createdAt: now(), text: '更新了待办内容' }); publish(kind, task.id, task.groupId); }
function checkVersion(t: Row, headers: Headers) { const etag = headers.get('If-Match'); if (etag && etag !== taskView(t).etag) throw new DemoError(409, 'VERSION_CONFLICT', '演示任务已更新，请刷新后重新确认。'); }
function create(body: Row): Row {
  if (!String(body.title || '').trim()) throw new DemoError(422, 'VALIDATION_ERROR', '请填写待办标题。');
  if (body.scope === 'group') getConversation(body.groupId);
  const source = body.sourceMessageId ? state.messages.find(m => m.id === body.sourceMessageId) : null;
  const t = { id: uid('t'), ...body, scope: body.scope || 'personal', groupId: body.scope === 'group' ? body.groupId : null, ownerId: body.scope !== 'group' ? actorId() : null, creatorId: actorId(), assigneeId: body.assigneeId || null, title: body.title, description: body.description || '', priority: body.priority || 'normal', status: 'todo', dueOn: body.dueOn || null, dueTimezone: body.dueTimezone || 'Asia/Shanghai', completedAt: null, createdAt: now(), updatedAt: now(), deletedAt: null, version: 1, checkItems: [], source: source ? { available: true, messageId: source.id, conversationId: source.conversationId, text: source.text } : null, followedBy: [actorId()], bookmarkedBy: [], listId: body.listId || null, tagIds: body.tagIds || [], reminders: {} };
  state.tasks.unshift(t); publish('task.created', t.id, t.groupId); return t;
}
export function taskRoute(path: string, method: string, body: Row, q: URLSearchParams, headers: Headers): any {
  if (!path.startsWith('/tasks')) return undefined;
  const me = actor(); const sub = path.slice(6);
  if (sub === '/meta') return { actorId: me.id, enabled: !!state.policy.feature_tasks, enhanced: !!state.policy.feature_task_enhanced, canCreatePersonal: true, writeReason: null, preferences: state.taskPreferences[me.id] || defaultTaskPreferences(), labels: state.labels.filter(l => l.ownerId === me.id), limits: { personal: 1000, group: 1000, checkItems: 50, draftDays: 7, draftCount: 100 } };
  if (sub === '/preferences') { state.taskPreferences[me.id] = { ...defaultTaskPreferences(), ...state.taskPreferences[me.id], ...body }; save(); return state.taskPreferences[me.id]; }
  if (/^\/labels(?:\/[^/]+)?$/.test(sub)) {
    const id = sub.split('/')[2]; if (method === 'DELETE') { state.labels = state.labels.filter(l => l.id !== id); state.tasks.forEach(t => { if (t.listId === id) t.listId = null; t.tagIds = t.tagIds.filter((x: string) => x !== id); }); save(); return { deleted: true }; }
    const l = id ? must(state.labels.find(l => l.id === id)) : { id: uid('label'), ownerId: me.id }; Object.assign(l, body); if (!id) state.labels.push(l); save(); return l;
  }
  const settings = sub.match(/^\/groups\/([^/]+)\/settings$/);
  if (settings) { const c = getConversation(settings[1]); const member = state.members[c.id]?.find(m => m.userId === me.id); if (method !== 'GET') { state.taskPolicies[c.id] = body.createPolicy; publish('task.policy.changed', c.id, c.id); } return { groupId: c.id, createPolicy: state.taskPolicies[c.id] || 'members', etag: '"demo-policy-' + c.version + '"', canManage: ['owner', 'admin'].includes(member?.role), canCreate: (state.taskPolicies[c.id] || 'members') === 'members' || ['owner', 'admin'].includes(member?.role), writeReason: null, count: state.tasks.filter(t => t.groupId === c.id && !t.deletedAt).length, quota: 1000 }; }
  if (sub.startsWith('/cards/')) { const m = state.messages.find(m => m.id === sub.split('/')[2]); if (!m?.taskCard) return { kind: 'unavailable' }; if (m.taskCard.kind === 'snapshot') return m.taskCard; const t = state.tasks.find(t => t.id === m.taskCard.taskId); return t && !t.deletedAt && taskAccessible(t) ? { kind: 'live', task: taskView(t) } : { kind: 'unavailable' }; }
  if (!sub || sub === '/') {
    if (method === 'POST') return { task: taskView(create(body)), duplicate: false };
    const view = q.get('view') || 'mine'; const status = q.get('status') || 'open';
    let rows = state.tasks.filter(taskAccessible).filter(t => q.get('deleted') === 'only' ? !!t.deletedAt : !t.deletedAt);
    if (view === 'mine') rows = rows.filter(t => t.scope === 'personal' || t.assigneeId === me.id);
    if (view === 'personal') rows = rows.filter(t => t.scope === 'personal');
    if (view === 'group') rows = rows.filter(t => t.scope === 'group');
    if (view === 'created') rows = rows.filter(t => t.creatorId === me.id);
    if (view === 'followed') rows = rows.filter(t => t.followedBy.includes(me.id));
    if (view === 'bookmarked') rows = rows.filter(t => t.bookmarkedBy.includes(me.id));
    if (q.get('groupId')) rows = rows.filter(t => t.groupId === q.get('groupId'));
    if (status !== 'all') rows = rows.filter(t => status === 'open' ? t.status !== 'done' : t.status === status);
    if (q.get('priority')) rows = rows.filter(t => t.priority === q.get('priority'));
    if (q.get('assignee') === 'me') rows = rows.filter(t => t.assigneeId === me.id);
    if (q.get('assignee') === 'unassigned') rows = rows.filter(t => !t.assigneeId);
    if (q.get('listId')) rows = rows.filter(t => t.listId === q.get('listId'));
    if (q.get('tagId')) rows = rows.filter(t => t.tagIds.includes(q.get('tagId')));
    if (q.get('due') === 'today') rows = rows.filter(t => t.dueOn === new Date().toISOString().slice(0, 10));
    if (q.get('due') === 'overdue') rows = rows.filter(t => t.dueOn && t.dueOn < new Date().toISOString().slice(0, 10));
    rows = rows.filter(t => matches({ title: t.title, description: t.description }, q.get('q') || ''));
    return { ...page(rows.map(taskView), q), actorId: me.id };
  }
  const match = sub.match(/^\/([^/]+)(?:\/(.*))?$/); if (!match) return undefined;
  const t = must(state.tasks.find(t => t.id === match[1])); if (!taskAccessible(t)) throw new DemoError(403, 'RESOURCE_UNAVAILABLE', '当前身份不能访问这个演示任务。'); const action = match[2] || '';
  if (!action && method === 'GET') return taskView(t);
  if (action === 'activities') return page(state.activities[t.id] || [{ id: 'created_' + t.id, kind: 'task.created', actor: summary(t.creatorId), createdAt: t.createdAt, text: '创建了这项待办' }], q);
  if (action === 'comments' && method === 'GET') return page((state.comments[t.id] || []).map(c => ({ ...c, author: summary(c.authorId), canDelete: c.authorId === me.id || t.creatorId === me.id })), q);
  checkVersion(t, headers);
  if (!action && method === 'PATCH') { if (body.status === 'done' && t.checkItems.some((c: Row) => !c.done) && !body.confirmIncomplete) throw new DemoError(409, 'INCOMPLETE_CHECKS', '仍有未完成检查项，请明确确认后再标为完成。'); Object.assign(t, body); if (body.status) t.completedAt = body.status === 'done' ? now() : null; }
  else if (!action && method === 'DELETE') t.deletedAt = now();
  else if (action === 'restore') t.deletedAt = null;
  else if (action === 'claim') t.assigneeId = me.id;
  else if (action === 'release') t.assigneeId = null;
  else if (action === 'check-items') t.checkItems.push({ id: uid('check'), text: body.text, done: false, position: t.checkItems.length });
  else if (action.startsWith('check-items/')) { const id = action.split('/')[1]; if (method === 'DELETE') t.checkItems = t.checkItems.filter((c: Row) => c.id !== id); else Object.assign(must(t.checkItems.find((c: Row) => c.id === id)), body); }
  else if (action === 'comments') { state.comments[t.id] ??= []; state.comments[t.id].push({ id: uid('comment'), text: body.text, authorId: me.id, createdAt: now(), removed: false }); }
  else if (action.startsWith('comments/')) { const c = must((state.comments[t.id] || []).find(c => c.id === action.split('/')[1])); c.removed = true; c.text = ''; }
  else if (action === 'my-reminder') t.reminders[me.id] = body;
  else if (action === 'my-marks') { for (const [field, list] of [['followed','followedBy'],['bookmarked','bookmarkedBy']]) if (field in body) t[list] = body[field] ? [...new Set([...t[list], me.id])] : t[list].filter((id: string) => id !== me.id); }
  else if (action === 'shares') { const card = body.mode === 'snapshot' ? { kind: 'snapshot', snapshot: { title: t.title, priority: t.priority, dueOn: t.dueOn, dueTimezone: t.dueTimezone, ...(body.includeDescription ? { description: t.description } : {}) } } : { kind: 'live', taskId: t.id }; const result = sendMessage(body.destinationConversationId, { text: '', taskCard: card }); return { messageId: result.message.id, conversationId: body.destinationConversationId, duplicate: false }; }
  else if (action === 'group-copies') { const copy = create({ ...body, scope: 'group', title: body.title || t.title, description: body.description ?? t.description }); return { task: taskView(copy), duplicate: false }; }
  else if (action === 'reports') { const r = { ...body, id: uid('taskreport'), taskId: t.id, reporterId: me.id, status: 'open', createdAt: now(), closedAt: null, version: 1 }; state.taskReports.unshift(r); save(); return r; }
  else throw new DemoError(404, 'DEMO_ROUTE_NOT_FOUND', '未识别的演示待办操作。');
  changed(t, method === 'DELETE' && !action ? 'task.deleted' : action === 'restore' ? 'task.restored' : 'task.updated');
  return { task: taskView(t), duplicate: false };
}
