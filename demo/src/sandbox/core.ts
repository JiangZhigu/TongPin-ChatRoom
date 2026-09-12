import { state, actor, actorId, setIdentity, userById, publicUser, uid, now, save, publish, summary, page, matches, must, DemoError, audit, PASSWORD, FACTOR, type Row } from './state';
import { contact, friendRequest, conversationView, getConversation, canSee, messageView, fileView, fileBlob, storeBlob } from './models';

const day = 86400000;
const recoveryCodes = () => Array.from({ length: 8 }, (_, i) => 'DEMO-' + String(i + 1).padStart(2, '0') + '-RECOVERY-2026');
const failures: Record<string, number> = {};
function validatePassword(value: unknown) {
  if (typeof value !== 'string' || [...value].length < 8 || [...value].length > 128 || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new DemoError(422, 'VALIDATION_ERROR', '密码长度或字符不符合要求。', {
      fieldErrors: { password: '密码应为8–128个字符，不能包含控制字符。' }
    });
  }
}
export let autoReply = true;
export function setAutoReply(value: boolean) { autoReply = value; }
export function sendMessage(cid: string, body: Row, senderId = actorId()!, reply = true): Row {
  const c = getConversation(cid); const view = conversationView(c);
  if (state.policy.maintenance && actor().siteRole !== 'super_admin') throw new DemoError(503, 'MAINTENANCE', '演示站点维护中，暂停新消息。');
  if ([...String(body.text || '')].length > state.policy.message_codepoints || new TextEncoder().encode(String(body.text || '')).length > state.policy.message_bytes) throw new DemoError(422, 'PAYLOAD_TOO_LARGE', '消息超过当前演示站点限制。');
  if (senderId === actorId() && !view.canSend) throw new DemoError(403, view.sendErrorCode, view.sendDisabledReason);
  const existing = body.clientMessageId && state.messages.find(m => m.clientMessageId === body.clientMessageId && m.senderId === senderId);
  if (existing) return { message: messageView(existing), duplicate: true };
  if (!String(body.text || '').trim() && !(body.attachmentIds || []).length && !body.taskCard) throw new DemoError(422, 'VALIDATION_ERROR', '请填写消息或选择附件。');
  const m = { id: uid('m'), conversationId: cid, seq: String(state.messages.filter(m => m.conversationId === cid).length + 1), senderId, clientMessageId: body.clientMessageId || uid('local'), kind: 'user', text: body.text || '', status: 'sent', createdAt: now(), replyToMessageId: body.replyToMessageId || null, mentionedUserIds: body.mentionedUserIds || [], mentionAll: !!body.mentionAll, attachmentIds: body.attachmentIds || [], reactions: [], bookmarkedBy: [], ...(body.taskCard ? { taskCard: body.taskCard } : {}) };
  state.messages.push(m); c.updatedAt = now();
  for (const id of m.attachmentIds) { const file = state.files.find(f => f.id === id); if (file) Object.assign(file, { bound: true, messageId: m.id, conversationId: cid }); }
  publish('message.created', m.id, cid);
  if (autoReply && reply && senderId === actorId() && c.kind === 'direct') {
    const peerId = c.userIds.find((id: string) => id !== senderId);
    setTimeout(() => { if (!canSee(c) || actorId() !== senderId) return; sendMessage(cid, { text: ['收到啦，我先记下来。', '这个想法不错，我们可以继续聊聊。', '看到了！也可以把这条消息转成待办，方便跟进。'][state.messages.length % 3] }, peerId, false); }, 1600);
  }
  return { message: messageView(m), duplicate: false };
}
export async function coreRoute(path: string, method: string, body: Row, q: URLSearchParams, headers: Headers): Promise<any> {
  if (path === '/health/ready') return { status: 'ready', version: '0.1.0-demo', features: { accounts: true } };
  if (path === '/auth/bootstrap') return { accountsEnabled: true, registrationMode: state.policy.registration_mode, csrfToken: 'demo-local-csrf', user: actorId() ? publicUser(actor()) : null, terms: { version: state.policy.terms_version || 'demo-v1', operatorName: state.policy.operator_name, operatorContact: state.policy.operator_contact, development: true, text: '这是完整前端演示。所有身份、聊天、文件、管理操作仅保存在当前浏览器，不会连接真实后台。请只使用演示信息。' } };
  if (path === '/auth/captcha') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="64"><rect width="180" height="64" rx="8" fill="#edf4ff"/><path d="M5 20L175 48M8 48L172 18" stroke="#bbd2f5"/><text x="30" y="44" font-family="monospace" font-size="36" letter-spacing="8" fill="#2864b8">1234</text></svg>';
    const image = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return { id: 'demo-captcha', captchaId: 'demo-captcha', image, imageUrl: image, dataUrl: image, expiresAt: now() + 300000 };
  }
  if (path === '/auth/login' || path === '/auth/register') {
    const username = String(body.username || '').toLowerCase();
    if (path.endsWith('register')) {
      validatePassword(body.password);
      if (state.policy.registration_mode === 'closed') throw new DemoError(403, 'REGISTRATION_CLOSED', '演示站点当前关闭注册，可在站点策略中重新开启。');
      if (state.users.some(u => u.username.toLowerCase() === username)) throw new DemoError(409, 'USERNAME_TAKEN', '这个用户名已被使用。', { fieldErrors: { username: '请换一个用户名。' } });
      if (!/^[a-z][a-z0-9_]{3,23}$/.test(username)) throw new DemoError(422, 'VALIDATION_ERROR', '用户名需以字母开头，长度4–24位。');
      if (String(body.captchaAnswer || body.captcha || '') !== '1234') throw new DemoError(422, 'CAPTCHA_INVALID', '演示验证码为1234。');
      if (state.policy.registration_mode === 'invite-only') { const invite = state.siteInvites.find(i => i.code === body.siteInvite && !i.revokedAt && i.expiresAt > now() && i.used < i.maxUses); if (!invite) throw new DemoError(422, 'SITE_INVITE_INVALID', '请使用演示后台生成的有效站点邀请码。'); invite.used++; }
      const base = state.users[0]; const u = { ...base, id: uid('u'), username, nickname: body.nickname || username, password: body.password, bio: '', siteRole: 'user', avatarUrl: null, createdAt: now(), preferences: { invisible: false, readReceipts: true, doNotDisturb: false }, restrictions: { uploadDisabled: false, groupCreationDisabled: false, reason: '', mutedUntil: null, muteReason: '' } };
      state.users.push(u); state.contacts[u.id] = []; setIdentity(u.id); audit('auth.register', u.id); save(); return { user: publicUser(u), csrfToken: 'demo-local-csrf', expiresAt: now() + day, recoveryCodes: recoveryCodes() };
    }
    const u = state.users.find(u => u.username.toLowerCase() === username);
    if (!u || u.password !== body.password) { failures[username] = (failures[username] || 0) + 1; throw new DemoError(401, failures[username] >= 5 ? 'LOGIN_CAPTCHA_REQUIRED' : 'INVALID_CREDENTIALS', failures[username] >= 5 ? '连续失败5次，请输入演示验证码1234。' : '演示账号或密码不正确。默认密码为DemoPassword2026!'); }
    if (u.status === 'banned') throw new DemoError(403, 'ACCOUNT_BANNED', u.statusReason || '该演示账号已被封禁。');
    if (failures[username] >= 5 && String(body.captchaAnswer || '') !== '1234') throw new DemoError(422, 'LOGIN_CAPTCHA_REQUIRED', '请填写演示验证码1234。');
    if (u.siteRole === 'super_admin' && body.secondFactor !== FACTOR) throw new DemoError(401, 'SECOND_FACTOR_REQUIRED', '演示动态码为123456。');
    failures[username] = 0; u.status = 'active'; setIdentity(u.id); audit('auth.login', u.id); save(); return { user: publicUser(u), csrfToken: 'demo-local-csrf', expiresAt: now() + day };
  }
  if (path === '/auth/recover') { validatePassword(body.password); const u = must(state.users.find(u => u.username === String(body.username || '').toLowerCase())); if (!String(body.recoveryCode || '').startsWith('DEMO-')) throw new DemoError(422, 'RECOVERY_INVALID', '请使用演示恢复码，例如DEMO-01-RECOVERY-2026。'); u.password = body.password; u.status = 'active'; save(); return { recovered: true }; }
  if (path === '/auth/logout') { setIdentity(null); return { loggedOut: true }; }
  const me = actor();
  if (path === '/auth/me') return { user: publicUser(me) };
  if (path === '/auth/ws-ticket') return { ticket: 'demo-local-ticket' };
  if (path === '/auth/reauth') { if (body.password !== me.password) throw new DemoError(401, 'INVALID_PASSWORD', '请输入当前演示密码。默认是DemoPassword2026!'); if (body.secondFactor && body.secondFactor !== FACTOR) throw new DemoError(401, 'INVALID_SECOND_FACTOR', '演示动态码为123456。'); return { reauthToken: 'demo-local-reauth', expiresAt: now() + 300000 }; }
  if (path === '/account/navigation') { if (method !== 'GET') { state.navigation[me.id] = { ...state.navigation[me.id], ...body }; save(); } return { admin: me.siteRole === 'super_admin' ? { href: '/admin' } : null, ...state.navigation[me.id] }; }
  if (path === '/account/profile' || path === '/account/preferences') { if (method !== 'GET') { if (path.endsWith('profile')) { me.nickname = String(body.nickname || me.nickname); me.bio = String(body.bio || ''); } else Object.assign(me.preferences, body); save(); } return { user: publicUser(me) }; }
  if (path === '/me/avatar') { me.avatarAttachmentId = body.attachmentId || null; me.avatarUrl = body.attachmentId ? fileView(must(state.files.find(f => f.id === body.attachmentId))).contentUrl : null; save(); return { user: publicUser(me) }; }
  if (path === '/account/sessions') return page(state.sessions.filter(s => s.userId === me.id && !s.revokedAt).map(s => ({ ...s, current: s.id === 'session_' + me.id })));
  if (path.startsWith('/account/sessions/')) { const s = must(state.sessions.find(s => s.id === path.split('/').at(-1))); s.revokedAt = now(); if (s.id === 'session_' + me.id) setIdentity(null); audit('session.revoke', s.id); save(); return { revoked: true }; }
  if (path === '/account/security-events') return page(state.audit.filter(a => a.actor?.id === me.id).map(a => ({ ...a, device: '演示浏览器' })));
  if (path === '/account/password') { validatePassword(body.password); me.password = body.password; audit('account.password', me.id); save(); setIdentity(null); return { changed: true }; }
  if (path === '/account/recovery-codes') { audit('account.recovery_codes', me.id); save(); return { recoveryCodes: recoveryCodes() }; }
  if (path === '/account/deletion-preview') return { coolingDays: state.policy.deletion_cooling_days, ownedGroups: state.conversations.filter(c => (state.members[c.id] || []).some(m => m.userId === me.id && m.role === 'owner')).map(c => ({ id: c.id, name: c.title, status: c.status })), lastAdministrator: me.siteRole === 'super_admin' && state.users.filter(u => u.siteRole === 'super_admin' && u.status === 'active').length === 1, sharedMessagesRetained: true };
  if (path === '/account/delete') { me.status = 'deleting'; me.deletionAt = now() + state.policy.deletion_cooling_days * day; audit('account.delete', me.id); save(); setIdentity(null); return { deleted: true, recoverBefore: me.deletionAt }; }
  if (path === '/account/admin-enrollment') { const i = state.adminInvitations.find(i => i.userId === me.id && i.status === 'pending'); return { invitation: i ? { ...i, inviter: summary(i.inviterId) } : null }; }
  if (path === '/account/admin-enrollment/start') return { enrollmentId: 'demo-enrollment', secret: 'DEMODEMODEMODEMO2', uri: 'otpauth://totp/TongPinDemo:' + me.username + '?secret=DEMODEMODEMODEMO2&issuer=TongPinDemo', expiresAt: now() + 600000 };
  if (path === '/account/admin-enrollment/finish') { if (body.code !== FACTOR) throw new DemoError(422, 'SECOND_FACTOR_INVALID', '演示动态码为123456。'); me.siteRole = 'super_admin'; state.adminInvitations.filter(i => i.userId === me.id).forEach(i => i.status = 'accepted'); save(); return { user: publicUser(me), recoveryCodes: recoveryCodes() }; }
  if (path === '/sync/snapshot') return { cursor: String(state.cursor), contacts: page((state.contacts[me.id] || []).map(contact)), conversations: page(state.conversations.filter(c => canSee(c)).map(conversationView).sort((a, b) => Number(b.preferences.pinned) - Number(a.preferences.pinned) || b.updatedAt - a.updatedAt)), requests: page(state.requests.filter(r => r.status === 'pending' && (r.senderId === me.id || r.targetId === me.id)).map(friendRequest)), policy: { messageCodepoints: 4000, messageBytes: 16384, outboxCount: 100, outboxDays: 7 } };
  if (path === '/sync') { const events = state.events.filter(e => Number(e.cursor) > Number(q.get('after') || 0) && (!e.recipients || e.recipients.includes(me.id))); return { items: events.map(e => { const c = state.conversations.find(c => c.id === e.conversationId); const m = state.messages.find(m => m.id === e.entityRef); return { ...e, ...(c && canSee(c) && e.type !== 'access.revoked' ? { conversation: conversationView(c) } : {}), ...(m && c && canSee(c) ? { message: messageView(m) } : {}) }; }), cursor: String(state.cursor), highWatermark: String(state.cursor), hasMore: false }; }
  if (path === '/friends') return page((state.contacts[me.id] || []).map(contact), q);
  if (path === '/users/search') return page(state.users.filter(u => matches(u, q.get('q') || '')).map(u => contact(u.id)), q);
  if (path === '/blocks') return page((state.blocks[me.id] || []).map(contact), q);
  const friend = path.match(/^\/(friends|blocks)\/([^/]+)(?:\/preferences)?$/);
  if (friend) { const id = friend[2]; must(userById(id)); if (friend[1] === 'blocks') { state.blocks[me.id] ??= []; state.blocks[me.id] = method === 'DELETE' ? state.blocks[me.id].filter(x => x !== id) : [...new Set([...state.blocks[me.id], id])]; } else if (path.endsWith('/preferences')) state.contactPreferences[me.id + ':' + id] = { ...state.contactPreferences[me.id + ':' + id], ...body }; else { state.contacts[me.id] = (state.contacts[me.id] || []).filter(x => x !== id); state.contacts[id] = (state.contacts[id] || []).filter(x => x !== me.id); } publish('contacts.changed', id); return { updated: true, contact: contact(id) }; }
  if (path === '/friend-requests') { if (method === 'GET') return page(state.requests.filter(r => r.status === 'pending' && (r.senderId === me.id || r.targetId === me.id)).map(friendRequest), q); const target = must(userById(body.targetUserId)); const r = { id: uid('friend'), senderId: me.id, targetId: target.id, note: body.note || '', status: 'pending', createdAt: now() }; state.requests.push(r); state.notifications.unshift({ id: uid('n'), userId: target.id, type: 'friend.requested', entityRef: r.id, text: me.nickname + '向你发送了好友申请', createdAt: now(), readBy: [] }); publish('contacts.changed', r.id); return friendRequest(r); }
  const request = path.match(/^\/friend-requests\/([^/]+)\/(accept|reject|cancel)$/);
  if (request) { const r = must(state.requests.find(r => r.id === request[1])); r.status = ({ accept: 'accepted', reject: 'rejected', cancel: 'cancelled' } as Row)[request[2]]; if (request[2] === 'accept') { for (const [a, b] of [[r.senderId, r.targetId], [r.targetId, r.senderId]]) state.contacts[a] = [...new Set([...(state.contacts[a] || []), b])]; } publish('contacts.changed', r.id); return friendRequest(r); }
  if (path === '/conversations/direct') { const id = body.friendUserId; let c = state.conversations.find(c => c.kind === 'direct' && c.userIds.includes(me.id) && c.userIds.includes(id)); if (!c) { c = { id: uid('dm'), kind: 'direct', title: must(summary(id)).nickname, description: '', userIds: [me.id, id], status: 'active', version: 1, preferencesByUser: {}, readByUser: {}, createdAt: now(), updatedAt: now() }; state.conversations.push(c); save(); } return conversationView(c); }
  if (path === '/conversations') return page(state.conversations.filter(c => canSee(c)).map(conversationView), q);
  const conv = path.match(/^\/conversations\/([^/]+)(?:\/(messages|read|typing|preferences))?$/);
  if (conv) {
    const c = getConversation(conv[1]); const view = conversationView(c);
    if (!conv[2]) return view;
    if (conv[2] === 'messages') { if (method === 'POST') return sendMessage(c.id, body); let rows = state.messages.filter(m => m.conversationId === c.id); if (q.has('beforeSeq')) rows = rows.filter(m => Number(m.seq) < Number(q.get('beforeSeq'))); if (q.has('afterSeq')) rows = rows.filter(m => Number(m.seq) > Number(q.get('afterSeq'))); const limit = Number(q.get('limit') || 50); const selected = q.has('afterSeq') ? rows.slice(0, limit) : rows.slice(-limit); return { items: selected.map(messageView), hasMore: rows.length > limit, nextCursor: rows.length > limit ? (q.has('afterSeq') ? selected.at(-1)?.seq : selected[0]?.seq) : null, lastSeq: view.lastSeq, accessKey: view.accessKey }; }
    if (conv[2] === 'read') { c.readByUser[me.id] = body.seq || body.readSeq || view.lastSeq; save(); return { readSeq: String(c.readByUser[me.id]), conversation: conversationView(c) }; }
    if (conv[2] === 'typing') return { items: [] };
    c.preferencesByUser[me.id] = { ...c.preferencesByUser[me.id], ...body }; save(); return conversationView(c);
  }
  if (path === '/messages/search' || path === '/bookmarks') { const rows = state.messages.filter(m => state.conversations.some(c => c.id === m.conversationId && canSee(c)) && m.status === 'sent' && matches(m, q.get('q') || '') && (!q.get('conversationId') || m.conversationId === q.get('conversationId')) && (path !== '/bookmarks' || (m.bookmarkedBy || []).includes(me.id))); return page(rows.map(m => ({ id: m.id, available: true, message: messageView(m), conversation: conversationView(getConversation(m.conversationId)), savedAt: m.createdAt })), q); }
  const msg = path.match(/^\/messages\/([^/]+)(?:\/(context|bookmark|reactions|recall|moderate)(?:\/([^/]+))?)?$/);
  if (msg) {
    const m = must(state.messages.find(m => m.id === msg[1])); const c = getConversation(m.conversationId);
    if (!msg[2]) return { message: messageView(m) };
    if (msg[2] === 'context') return { conversation: conversationView(c), items: state.messages.filter(x => x.conversationId === c.id).map(messageView), targetId: m.id, hasBefore: false, hasAfter: false };
    if (msg[2] === 'bookmark') { m.bookmarkedBy ??= []; m.bookmarkedBy = method === 'DELETE' ? m.bookmarkedBy.filter((x: string) => x !== me.id) : [...new Set([...m.bookmarkedBy, me.id])]; save(); return { bookmarked: method !== 'DELETE' }; }
    if (msg[2] === 'recall') m.status = 'recalled';
    if (msg[2] === 'moderate') { if (me.siteRole !== 'super_admin') throw new DemoError(403, 'FORBIDDEN', '需要演示管理员身份。'); m.status = 'moderated'; m.moderationKind = 'deleted'; m.removedReason = body.reason || ''; audit('message.delete', m.id, body.reason); }
    if (msg[2] === 'reactions') { const key = msg[3] || body.key || body.emojiKey; let r = m.reactions.find((r: Row) => r.key === key); if (!r) { r = { key, userIds: [] }; m.reactions.push(r); } r.userIds = method === 'DELETE' ? r.userIds.filter((x: string) => x !== me.id) : [...new Set([...r.userIds, me.id])]; m.reactions = m.reactions.filter((x: Row) => x.userIds.length); }
    publish('message.updated', m.id, c.id); return { message: messageView(m) };
  }
  if (path === '/notifications') { const rows = state.notifications.filter(n => n.userId === '*' || n.userId === me.id).map(n => ({ ...n, readAt: n.readBy.includes(me.id) ? now() - 1000 : null, ...(n.type === 'friend.requested' ? { request: friendRequest(state.requests.find(r => r.id === n.entityRef)!) } : {}) })); return { ...page(rows, q), unreadCount: rows.filter(n => !n.readAt).length, count: rows.filter(n => !n.readAt).length }; }
  if (path === '/notifications/unread-count') return { count: state.notifications.filter(n => (n.userId === '*' || n.userId === me.id) && !n.readBy.includes(me.id)).length };
  if (/^\/notifications\/[^/]+\/read$/.test(path)) { const n = must(state.notifications.find(n => n.id === path.split('/')[2])); n.readBy = [...new Set([...n.readBy, me.id])]; save(); return { read: true }; }
  if (path.startsWith('/announcements/')) return must(state.announcements.find(a => a.id === path.split('/')[2]));
  if (path === '/reports') { if (method === 'GET') return page(state.reports.filter(r => r.reporterId === me.id), q); const r = { ...body, id: uid('report'), reporterId: me.id, status: 'open', assignedToId: null, feedback: null, version: 1, createdAt: now(), updatedAt: now(), events: [] }; state.reports.unshift(r); save(); return r; }
  if (path === '/files/policy') return { imageLimit: state.policy.image_limit_bytes, fileLimit: state.policy.file_limit_bytes, attachmentCount: state.policy.attachment_count, messageBytes: state.policy.message_attachment_bytes, userQuota: me.quotaBytes ?? state.policy.user_quota_bytes, usedBytes: state.files.filter(f => f.ownerId === me.id).reduce((s, f) => s + f.size, 0), reservedBytes: 0, supportedExtensions: ['txt','pdf','doc','docx','xls','xlsx','zip','png','jpg','jpeg','gif','webp'], scanPolicy: 'closed-test-unscanned', scanner: 'disabled' };
  if (path === '/files') return page(state.files.filter(f => f.bound && f.conversationId && state.conversations.some(c => c.id === f.conversationId && canSee(c)) && (!q.get('conversationId') || f.conversationId === q.get('conversationId')) && (!q.get('kind') || f.kind === q.get('kind')) && matches(f, q.get('q') || '')).map(f => ({ ...fileView(f), conversationTitle: state.conversations.find(c => c.id === f.conversationId)?.title || '', senderName: summary(f.ownerId)?.nickname || '' })), q);
  if (path === '/attachment-uploads') { const old = state.files.find(f => f.clientUploadId === body.clientUploadId && f.ownerId === me.id); if (old) return fileView(old); const f = { ...body, id: uid('file'), kind: String(body.mime).startsWith('image/') ? 'image' : 'file', ownerId: me.id, state: 'reserved', scanStatus: 'not_scanned', governance: 'available', governanceReason: '', createdAt: now(), expiresAt: now() + day, bound: false, version: 1 }; state.files.push(f); save(); return fileView(f); }
  if (path === '/attachments' && method === 'POST') { const f = must(state.files.find(f => f.id === headers.get('X-Upload-Id'))); const blob = body.__blob as Blob; await storeBlob(f.id, blob); f.state = 'ready'; f.size = blob.size; f.scanStatus = 'not_scanned'; save(); return fileView(f); }
  const file = path.match(/^\/attachments\/([^/]+)(?:\/(content|thumbnail|preview|retry|cancel))?$/);
  if (file) { const f = must(state.files.find(f => f.id === file[1])); if (['content','thumbnail','preview'].includes(file[2])) return fileBlob(f.id); if (method === 'DELETE' || file[2] === 'cancel') f.state = 'cancelled'; if (file[2] === 'retry') f.state = 'ready'; save(); return fileView(f); }
  return undefined;
}
