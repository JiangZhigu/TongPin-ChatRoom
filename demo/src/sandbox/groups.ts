import { actor, actorId, state, uid, now, save, publish, summary, page, must, DemoError, audit, type Row } from './state';
import { groupDetail, getConversation, memberView, inviteView, applicationView, transferView, conversationView, fileView } from './models';

function updated(cid: string) { const c = getConversation(cid, true); c.version++; c.updatedAt = now(); publish('conversation.updated', cid, cid); }
function addMember(cid: string, id: string) { state.members[cid] ??= []; if (!state.members[cid].some(m => m.userId === id)) state.members[cid].push({ userId: id, periodId: uid('period'), role: 'member', joinedAt: now(), mutedUntil: null }); updated(cid); }
function removeMember(cid: string, id: string) { state.members[cid] = (state.members[cid] || []).filter(m => m.userId !== id); publish('access.revoked', cid, cid, [id]); updated(cid); }
export function groupRoute(path: string, method: string, body: Row, q: URLSearchParams, headers: Headers): any {
  if (!/^\/(groups|group-invites|group-applications)(\/|$)/.test(path)) return undefined;
  if (path === '/group-invites/preview') { const token = headers.get('X-Group-Invite') || body.token || q.get('token'); const i = must(state.invitations.find(i => i.token === token), '演示邀请不存在或已重置。请从群管理创建一个邀请链接。'); const c = getConversation(i.conversationId, true); const member = state.members[c.id]?.some(m => m.userId === actorId()); return { inviteId: i.id, conversationId: c.id, name: c.title, description: c.description, memberCount: state.members[c.id]?.length || 0, requiresApproval: state.groupSettings[c.id].reviewRequired, expiresAt: i.expiresAt, maxUses: i.maxUses, remaining: inviteView(i).remaining, state: member ? 'already_member' : inviteView(i).state, application: state.applications.find(a => a.userId === actorId() && a.inviteId === i.id) || null }; }
  const me = actor();
  if (path === '/groups' && method === 'POST') {
    const c = { id: uid('g'), kind: 'group', title: String(body.name || '').trim() || '新的群聊', description: body.description || '', status: 'active', version: 1, preferencesByUser: {}, readByUser: {}, avatarUrl: null, createdAt: now(), updatedAt: now() };
    state.conversations.unshift(c); state.members[c.id] = [{ userId: me.id, periodId: uid('period'), role: 'owner', joinedAt: now(), mutedUntil: null }];
    for (const id of body.friendUserIds || []) if (id !== me.id) state.members[c.id].push({ userId: id, periodId: uid('period'), role: 'member', joinedAt: now(), mutedUntil: null });
    state.groupSettings[c.id] = { announcement: '', announcementPinned: false, reviewRequired: false, inviteRole: 'members', everyoneMuted: false, slowSeconds: 0 };
    audit('group.create', c.id); publish('conversation.updated', c.id, c.id); return groupDetail(c.id);
  }
  if (path === '/group-invites/mine') return page(state.invitations.filter(i => i.targetId === me.id).map(inviteView), q);
  if (path === '/group-applications/mine') return page(state.applications.filter(a => a.userId === me.id).map(applicationView), q);
  const apply = path.match(/^\/group-invites\/([^/]+)\/apply$/);
  if (apply) { const i = must(state.invitations.find(i => i.id === apply[1])); const current = state.members[i.conversationId]?.some(m => m.userId === me.id); const review = state.groupSettings[i.conversationId].reviewRequired; const a = { id: uid('application'), conversationId: i.conversationId, inviteId: i.id, userId: me.id, status: current ? 'already_member' : review ? 'pending' : 'approved', createdAt: now(), expiresAt: i.expiresAt }; state.applications.push(a); if (!current && !review) { i.used++; addMember(i.conversationId, me.id); } else if (!current) i.reserved++; publish('conversation.updated', i.conversationId, i.conversationId); return applicationView(a); }
  const app = path.match(/^\/group-applications\/([^/]+)\/(approve|reject|cancel)$/);
  if (app) { const a = must(state.applications.find(a => a.id === app[1])); a.status = ({ approve: 'approved', reject: 'rejected', cancel: 'cancelled' } as Row)[app[2]]; const i = state.invitations.find(i => i.id === a.inviteId); if (i) { i.reserved = Math.max(0, i.reserved - 1); if (app[2] === 'approve') i.used++; } if (app[2] === 'approve') addMember(a.conversationId, a.userId); else updated(a.conversationId); return applicationView(a); }
  const match = path.match(/^\/groups\/([^/]+)(?:\/(.*))?$/); if (!match) return undefined;
  const c = getConversation(match[1]); const action = match[2] || ''; const detail = groupDetail(c.id);
  if (body.expectedVersion !== undefined && body.expectedVersion !== c.version) throw new DemoError(409, 'VERSION_CONFLICT', '群状态已改变，请刷新后重新确认。');
  if (!action && method === 'GET') return detail;
  if (!action && method === 'PATCH') { if (!detail.capabilities.canEdit) throw new DemoError(403, 'FORBIDDEN', '当前演示身份不能编辑群资料。'); if (body.name !== undefined) c.title = body.name; if (body.description !== undefined) c.description = body.description; for (const key of Object.keys(state.groupSettings[c.id])) if (key in body) state.groupSettings[c.id][key] = body[key]; audit('group.settings', c.id); updated(c.id); return groupDetail(c.id); }
  if (action === 'avatar') { c.avatarAttachmentId = body.attachmentId; c.avatarUrl = body.attachmentId ? fileView(must(state.files.find(f => f.id === body.attachmentId))).contentUrl : null; updated(c.id); return groupDetail(c.id); }
  if (action === 'members' && method === 'GET') return page((state.members[c.id] || []).map(memberView), q);
  if (action === 'invites' && method === 'GET') return page(state.invitations.filter(i => i.conversationId === c.id).map(inviteView), q);
  if (action === 'applications') return page(state.applications.filter(a => a.conversationId === c.id).map(applicationView), q);
  if (action === 'audit') return page(state.audit.filter(a => a.subjectId === c.id), q);
  if (action === 'invites' && method === 'POST') { const i = { id: uid('invite'), conversationId: c.id, kind: body.kind || 'link', creatorId: me.id, targetId: body.targetUserId || null, maxUses: body.maxUses || 10, used: 0, reserved: 0, expiresAt: now() + (body.expiresHours || 24) * 3600000, createdAt: now(), revokedAt: null, token: 'demo_' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') }; state.invitations.push(i); audit('group.invite.create', c.id); publish('conversation.updated', c.id, c.id); return { invite: inviteView(i), token: i.kind === 'link' ? i.token : null }; }
  if (/^invites\/[^/]+\/revoke$/.test(action)) { const i = must(state.invitations.find(i => i.id === action.split('/')[1])); i.revokedAt = now(); updated(c.id); return inviteView(i); }
  if (action.startsWith('members/')) { const id = action.split('/')[1]; const m = must(state.members[c.id].find(m => m.userId === id)); if (!detail.capabilities.canEdit) throw new DemoError(403, 'FORBIDDEN', '当前演示身份不能管理成员。'); if (action.endsWith('/remove')) removeMember(c.id, id); else { if (body.role) m.role = body.role; if ('mutedUntil' in body) m.mutedUntil = body.mutedUntil; updated(c.id); } audit('group.member.update', c.id); save(); return { updated: true }; }
  if (action === 'leave') { if (detail.conversation.role === 'owner') throw new DemoError(409, 'OWNER_CANNOT_LEAVE', '请先转让群主。'); removeMember(c.id, me.id); return { left: true }; }
  if (action === 'dissolve') { c.status = 'dissolved'; publish('access.revoked', c.id, c.id, (state.members[c.id] || []).map(m => m.userId)); audit('group.dissolve', c.id); save(); return { dissolved: true }; }
  if (action === 'transfers') { const t = { id: uid('transfer'), conversationId: c.id, fromId: me.id, toId: body.targetUserId, targetPeriodId: body.targetPeriodId, status: 'pending', expiresAt: now() + 86400000, createdAt: now() }; state.transfers.push(t); state.notifications.unshift({ id: uid('n'), userId: t.toId, type: 'group.transfer', entityRef: t.id, conversationId: c.id, text: me.nickname + '邀请你接任「' + c.title + '」群主', createdAt: now(), readBy: [] }); updated(c.id); return transferView(t); }
  const transfer = action.match(/^transfers\/([^/]+)\/(accept|reject|cancel)$/);
  if (transfer) { const t = must(state.transfers.find(t => t.id === transfer[1])); t.status = ({ accept: 'accepted', reject: 'rejected', cancel: 'cancelled' } as Row)[transfer[2]]; if (transfer[2] === 'accept') { for (const m of state.members[c.id]) { if (m.userId === t.fromId) m.role = 'member'; if (m.userId === t.toId) m.role = 'owner'; } } updated(c.id); return transferView(t); }
  return undefined;
}
