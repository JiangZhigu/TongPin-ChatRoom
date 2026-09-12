import policyCatalog from '../data/policy.json';
/* Browser-only demo data. No credentials or records are read from the real app. */
export type Row = Record<string, any>;
export type DemoState = {
  schema: number; counter: number; cursor: number; users: Row[]; conversations: Row[];
  messages: Row[]; members: Record<string, Row[]>; groupSettings: Record<string, Row>;
  tasks: Row[]; comments: Record<string, Row[]>; activities: Record<string, Row[]>;
  labels: Row[]; taskPreferences: Record<string, Row>; taskPolicies: Record<string, string>;
  contacts: Record<string, string[]>; contactPreferences: Record<string, Row>; blocks: Record<string, string[]>;
  requests: Row[]; invitations: Row[]; applications: Row[]; transfers: Row[]; notifications: Row[];
  files: Row[]; reports: Row[]; taskReports: Row[]; events: Row[]; audit: Row[];
  commands: Record<string, Row>; operations: Row[]; announcements: Row[]; siteInvites: Row[];
  adminInvitations: Row[]; sessions: Row[]; navigation: Record<string, Row>; policy: Row; policyVersions: Row[];
};
export const STATE_KEY = 'tongpin-demo.state.v1';
export const SESSION_KEY = 'tongpin-demo.identity.v1';
export const PASSWORD = 'DemoPassword2026!';
export const FACTOR = '123456';
export const CAPS = { edit: true, progress: true, assign: true, claim: true, release: true, checkStructure: true, checkToggle: true, remove: true, restore: false, comment: true, share: true, copyToGroup: true, writeReason: null };
export const defaultTaskPreferences = () => ({ assignments: true, comments: true, completed: true, due: true, timezone: 'Asia/Shanghai' });
export const now = () => Date.now();
export const uid = (prefix = 'demo') => prefix + '_' + (++state.counter).toString(36);
const day = 86400000;
const person = (id: string, username: string, nickname: string, bio: string, siteRole = 'user'): Row => ({ id, username, nickname, bio, siteRole, status: 'active', avatarUrl: null, createdAt: now() - 30 * day, updatedAt: now(), password: PASSWORD, preferences: { invisible: false, readReceipts: true, doNotDisturb: false }, restrictions: { uploadDisabled: false, groupCreationDisabled: false, reason: '', mutedUntil: null, muteReason: '' }, version: 1 });
export function freshState(): DemoState {
  const users = [person('u_lin', 'linyuan', '林予安', '把想法变成日常的小作品。'), person('u_chen', 'chenmu', '陈沐', '设计、咖啡和周末的城市散步。'), person('u_zhou', 'zhouke', '周可', '一起把项目做好。'), person('u_xu', 'xuyan', '许言', '分享有趣的发现。'), person('u_admin', 'demo_admin', '演示管理员', '同频演示空间管理者。', 'super_admin'), person('u_admin2', 'demo_operator', '运营管理员', '负责社区内容与协作。', 'super_admin'), person('u_new', 'newfriend', '陆遥', '刚来到同频，期待认识新朋友。')];
  const members: Record<string, Row[]> = {
    g_design: ['u_lin', 'u_chen', 'u_zhou', 'u_xu'].map((id, i) => ({ userId: id, periodId: 'p_design_' + id, role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member', joinedAt: now() - 12 * day, mutedUntil: null })),
    g_weekend: ['u_chen', 'u_lin', 'u_zhou'].map((id, i) => ({ userId: id, periodId: 'p_weekend_' + id, role: i === 0 ? 'owner' : 'member', joinedAt: now() - 9 * day, mutedUntil: null })),
    g_product: ['u_admin', 'u_lin', 'u_chen', 'u_xu'].map((id, i) => ({ userId: id, periodId: 'p_product_' + id, role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member', joinedAt: now() - 8 * day, mutedUntil: null }))
  };
  const conversations: Row[] = [
    { id: 'dm_chen', kind: 'direct', userIds: ['u_lin', 'u_chen'], title: '陈沐', description: '', version: 1 },
    { id: 'g_design', kind: 'group', title: '设计协作小组', description: '灵感、反馈与正在进行的小项目，都放在这里。', version: 1 },
    { id: 'dm_zhou', kind: 'direct', userIds: ['u_lin', 'u_zhou'], title: '周可', description: '', version: 1 },
    { id: 'g_weekend', kind: 'group', title: '周末散步计划', description: '一起发现城市里值得停留的地方。', version: 1 },
    { id: 'g_product', kind: 'group', title: '同频产品讨论', description: '让沟通更轻松，让协作更自然。', version: 1 }
  ].map((c, i) => ({ ...c, status: 'active', createdAt: now() - 12 * day, updatedAt: now() - i * 120000, preferencesByUser: {}, readByUser: {}, avatarUrl: null }));
  const groupSettings = Object.fromEntries(Object.keys(members).map(id => [id, { announcement: id === 'g_design' ? '周五下午一起过一遍新版页面。灵感和问题随时发到群里，也可以转为待办。' : '欢迎分享。请尊重彼此，保持友善。', announcementPinned: true, reviewRequired: false, inviteRole: 'members', everyoneMuted: false, slowSeconds: 0 }]));
  let messageIndex = 0;
  const messages: Row[] = [];
  const add = (cid: string, userId: string, text: string, extra: Row = {}) => {
    const seq = messages.filter(m => m.conversationId === cid).length + 1;
    messages.push({ id: 'm_seed_' + (++messageIndex), conversationId: cid, seq: String(seq), senderId: userId, clientMessageId: null, kind: 'user', text, status: 'sent', createdAt: now() - 65 * 60000 + messageIndex * 90000, replyToMessageId: null, mentionedUserIds: [], mentionAll: false, attachmentIds: [], reactions: [], bookmarkedBy: [], ...extra });
  };
  add('dm_chen', 'u_chen', '早上好！昨天讨论的配色我整理好了。');
  add('dm_chen', 'u_lin', '收到，我也把交互流程补了一版，稍后一起看。');
  add('dm_chen', 'u_chen', '浅蓝色很舒服，感觉更适合日常聊天。 ☁️');
  add('dm_chen', 'u_lin', '是的，希望大家打开就能安心聊两句。', { reactions: [{ key: '👍', userIds: ['u_chen'] }] });
  add('dm_chen', 'u_chen', '这里还可以试试回复、表情反应、收藏和把消息转成待办。');
  add('g_design', 'u_chen', '新版的几个关键页面已经整理进协作清单了。');
  add('g_design', 'u_zhou', '我负责把移动端的交互细节再检查一遍。');
  add('g_design', 'u_lin', '好呀。大家可以直接领取右侧群待办，有问题就在任务里留言。');
  add('g_design', 'u_xu', '导航和文件列表看起来清楚很多 👍', { reactions: [{ key: '👍', userIds: ['u_lin', 'u_chen'] }] });
  add('g_design', 'u_chen', '这是这周的视觉说明，可以下载或者收藏。', { attachmentIds: ['file_guide'] });
  add('dm_zhou', 'u_zhou', '群待办我已经认领了一项，今晚给你反馈。');
  add('dm_zhou', 'u_lin', '辛苦啦，有任何想法直接发过来就好。');
  add('g_weekend', 'u_chen', '周六下午去河边走走吗？天气好的话顺便拍些照片。');
  add('g_weekend', 'u_zhou', '我可以！三点在咖啡店碰面吧。');
  add('g_weekend', 'u_lin', '好，我把路线放到待办里了。');
  add('g_product', 'u_admin', '欢迎来到完整前端演示。所有账号、消息和管理操作都只存在于当前浏览器。');
  add('g_product', 'u_xu', '也可以切换演示身份，体验不同群角色和管理页面。');
  const tasks: Row[] = [
    { id: 't_visual', title: '整理首页视觉规范', description: '统一按钮、留白和浅灰浅蓝的界面层级。\n完成后在群里分享一张效果图。', scope: 'group', groupId: 'g_design', assigneeId: 'u_lin', priority: 'high', status: 'doing', checks: ['检查按钮样式', '整理字号与间距', '补充窄屏示例'] },
    { id: 't_mobile', title: '检查手机端聊天体验', description: '检查320和390宽度下的导航、输入框、群待办入口。', scope: 'group', groupId: 'g_design', assigneeId: 'u_zhou', priority: 'normal', status: 'todo', checks: ['检查导航抽屉', '检查输入与附件', '检查弹窗返回'] },
    { id: 't_feedback', title: '收集本周协作反馈', description: '把成员反馈汇总成下一轮的小改进。', scope: 'group', groupId: 'g_design', assigneeId: null, priority: 'normal', status: 'todo', checks: [] },
    { id: 't_icons', title: '更新常用图标', description: '完成第一版图标一致性整理。', scope: 'group', groupId: 'g_design', assigneeId: 'u_chen', priority: 'low', status: 'done', checks: ['整理列表', '同步样式'] },
    { id: 't_notes', title: '整理今天的灵感笔记', description: '记录想法，选出最值得继续尝试的一个。', scope: 'personal', groupId: null, assigneeId: null, priority: 'normal', status: 'todo', checks: ['整理草稿', '选出重点'] },
    { id: 't_read', title: '读完收藏的设计文章', description: '给自己留半小时，慢慢读。', scope: 'personal', groupId: null, assigneeId: null, priority: 'low', status: 'doing', checks: [] },
    { id: 't_walk', title: '确认周末散步路线', description: '咖啡店 → 河边步道 → 书店。', scope: 'group', groupId: 'g_weekend', assigneeId: 'u_lin', priority: 'normal', status: 'todo', checks: ['查集合地点', '确认同行成员'] }
  ].map((t, i) => ({ ...t, ownerId: t.scope === 'personal' ? 'u_lin' : null, creatorId: 'u_lin', dueOn: new Date(now() + (i % 3 + 1) * day).toISOString().slice(0, 10), dueTimezone: 'Asia/Shanghai', completedAt: t.status === 'done' ? now() - day : null, createdAt: now() - (i + 1) * day, updatedAt: now() - i * 60000, deletedAt: null, version: 1, checkItems: t.checks.map((text, j) => ({ id: 'check_' + i + '_' + j, text, done: t.status === 'done' || i === 0 && j === 0, position: j })), source: null, followedBy: ['u_lin'], bookmarkedBy: i === 0 ? ['u_lin'] : [], listId: t.scope === 'personal' ? 'list_work' : null, tagIds: i < 2 ? ['tag_design'] : [], reminders: {} }));
  const files = [{ id: 'file_guide', name: '同频演示使用说明.txt', mime: 'text/plain', kind: 'file', size: 210, purpose: 'message', conversationId: 'g_design', ownerId: 'u_chen', messageId: 'm_seed_10', state: 'ready', scanStatus: 'clean', governance: 'available', governanceReason: '', createdAt: now() - 3600000, expiresAt: now() + 30 * day, bound: true, version: 1, seedText: '同频 · 完整前端演示\n\n这是一个独立演示附件。\n聊天、群组、待办、账号设置及管理后台均在浏览器中模拟。\n点击右下角“演示控制”可以切换身份或重置数据。\n所有内容均为演示数据。\n' }];
  const notices = [{ id: 'announcement_welcome', kind: 'announcement', title: '欢迎来到同频演示空间', body: '所有页面均复用当前成品前端。你可以发送消息、管理群组、创建待办、修改资料，并体验完整管理后台。\n数据只保存在本浏览器，不会发送到真实后台。', audience: 'all', groupId: null, creator: users[4], status: 'published', recipientCount: 7, deliveredCount: 7, publishAt: now() - day, publishedAt: now() - day, withdrawnAt: null, createdAt: now() - day, errorCode: null, version: 1, jobId: 'job_welcome' }];
  return { schema: 1, counter: 1000, cursor: 0, users, conversations, messages, members, groupSettings, tasks,
    comments: { t_visual: [{ id: 'comment_seed', text: '留白看起来很好，建议按钮高度也一起统一。', authorId: 'u_chen', createdAt: now() - 3600000, removed: false }] }, activities: {}, labels: [{ id: 'list_work', name: '日常安排', kind: 'list', ownerId: 'u_lin' }, { id: 'tag_design', name: '设计', kind: 'tag', ownerId: 'u_lin' }], taskPreferences: {}, taskPolicies: {},
    contacts: { u_lin: ['u_chen', 'u_zhou', 'u_xu', 'u_admin'], u_chen: ['u_lin', 'u_zhou', 'u_xu'], u_zhou: ['u_lin', 'u_chen'], u_xu: ['u_lin', 'u_chen'], u_admin: ['u_lin', 'u_admin2'], u_admin2: ['u_admin'] }, contactPreferences: {}, blocks: {},
    requests: [{ id: 'request_new', senderId: 'u_new', targetId: 'u_lin', note: '你好，想和你交流设计与协作。', status: 'pending', createdAt: now() - 1800000 }], invitations: [], applications: [], transfers: [],
    notifications: [{ id: 'n_welcome', userId: '*', type: 'system.notice', entityRef: 'announcement_welcome', text: '欢迎来到同频演示空间', createdAt: now() - 3600000, readBy: [] }, { id: 'n_task', userId: 'u_lin', type: 'task.assigned', entityRef: 't_visual', taskId: 't_visual', available: true, text: '你有一项进行中的群待办：整理首页视觉规范', createdAt: now() - 1800000, readBy: [] }, { id: 'n_friend', userId: 'u_lin', type: 'friend.requested', entityRef: 'request_new', text: '陆遥向你发送了好友申请', createdAt: now() - 1200000, readBy: [] }],
    files, reports: [{ id: 'report_seed', reporterId: 'u_lin', targetKind: 'message', targetId: 'm_seed_11', category: 'other', description: '这是一条用于演示举报处理流程的示例工单。', status: 'open', assignedToId: null, feedback: null, version: 1, createdAt: now() - day, updatedAt: now() - day, events: [] }], taskReports: [], events: [], audit: [], commands: {}, operations: [], announcements: notices, siteInvites: [], adminInvitations: [],
    sessions: users.flatMap(u => [{ id: 'session_' + u.id, userId: u.id, device: '当前演示浏览器', createdAt: now() - day, lastSeenAt: now(), expiresAt: now() + 7 * day, revokedAt: null }, { id: 'session_mobile_' + u.id, userId: u.id, device: '演示手机 · 移动浏览器', createdAt: now() - 2 * day, lastSeenAt: now() - 3600000, expiresAt: now() + 7 * day, revokedAt: null }]), navigation: {},
    policy: { ...policyCatalog.defaults, version: 1, registration_mode: 'open', maintenance: false, operator_name: '同频演示空间', operator_contact: '演示环境 · 不收集真实信息', message_limit: 4000, user_quota: 536870912, group_limit: 200, owned_group_limit: 20, feature_tasks: true, feature_task_enhanced: true, announcement: '' }, policyVersions: [] };
}
function load(): DemoState { try { const data = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); if (data?.schema === 1) { data.policy = { ...policyCatalog.defaults, ...data.policy }; return data; } } catch { /* private/blocked storage falls back to this session */ } return freshState(); }
export let state = load();
export let storageWarning = '';
export let offline = false;
let identity: string | null;
try { const saved = sessionStorage.getItem(SESSION_KEY); identity = saved === 'signed-out' ? null : saved && state.users.some(u => u.id === saved) ? saved : 'u_lin'; } catch { identity = 'u_lin'; }
export const actorId = () => identity;
export const userById = (id: string | null | undefined) => state.users.find(u => u.id === id) || null;
export function actor(): Row { const u = userById(identity); if (!u) throw new DemoError(401, 'AUTH_REQUIRED', '请先登录演示账号。'); return u; }
export function setIdentity(id: string | null) { identity = id; try { sessionStorage.setItem(SESSION_KEY, id || 'signed-out'); } catch { /* tab-local fallback remains */ } }
export function save() { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); storageWarning = ''; } catch { storageWarning = '浏览器存储不可用或空间不足，当前变更仅保留在此页面。'; } window.dispatchEvent(new Event('demo:state')); }
export function resetState() { state = freshState(); setIdentity('u_lin'); offline = false; save(); }
export function setOffline(value: boolean) { offline = value; window.dispatchEvent(new Event(value ? 'offline' : 'online')); window.dispatchEvent(new Event('demo:state')); }
export class DemoError extends Error { constructor(public status: number, public code: string, message: string, public extras: Row = {}) { super(message); } }
export const bus = new EventTarget();
let channel: BroadcastChannel | null = null;
try { channel = new BroadcastChannel('tongpin-demo.events.v1'); channel.onmessage = () => { state = load(); bus.dispatchEvent(new Event('sync')); window.dispatchEvent(new Event('demo:state')); }; } catch { /* single-tab still works */ }
export function publish(type: string, entityRef: string, conversationId: string | null = null, recipients?: string[]) {
  const cursor = String(++state.cursor);
  state.events.push({ v: 1, eventId: 'event_' + cursor, cursor, type, entityRef, conversationId, occurredAt: now(), recipients });
  state.events = state.events.slice(-1000); save();
  setTimeout(() => { bus.dispatchEvent(new Event('sync')); channel?.postMessage({ cursor }); }, 60);
}
export function audit(action: string, subjectId: string | null, reason = '', details: Row = {}) { state.audit.unshift({ id: uid('audit'), actor: summary(actorId()), subjectId, action, reason: reason || '演示操作', result: 'success', device: '浏览器内演示', details, createdAt: now(), requestId: uid('request'), jobId: null }); state.audit = state.audit.slice(0, 500); }
export const publicUser = (u: Row) => ({ ...u, password: undefined });
export const summary = (id: string | null | undefined): Row | null => { const u = userById(id); return u ? { id: u.id, username: u.username, nickname: u.nickname, avatarUrl: u.avatarUrl } : null; };
export function page(items: Row[], params: URLSearchParams | Row = {}) { const get = (key: string) => params instanceof URLSearchParams ? params.get(key) : params[key]; const offset = Math.max(0, Number(get('after') || 0) || 0); const limit = Math.max(1, Math.min(100, Number(get('limit') || 50))); return { items: items.slice(offset, offset + limit), total: items.length, nextCursor: offset + limit < items.length ? String(offset + limit) : null }; }
export function matches(item: Row, query: string) { return !query || JSON.stringify(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()); }
export function must<T>(value: T | null | undefined, message = '该演示内容已不存在，请刷新列表。'): T { if (!value) throw new DemoError(404, 'RESOURCE_UNAVAILABLE', message); return value; }
