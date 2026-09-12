import { actor, actorId, state, summary, publicUser, must, now, DemoError, type Row, CAPS } from './state';

const urls = new Map<string, string>();
const blobs = new Map<string, Blob>();
let database: Promise<IDBDatabase> | undefined;
function db() { return database ??= new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('tongpin-demo.attachments.v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
export async function storeBlob(id: string, blob: Blob) {
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id)!);
  blobs.set(id, blob); urls.set(id, URL.createObjectURL(blob));
  try { const database = await db(); await new Promise<void>((resolve, reject) => { const tx = database.transaction('files', 'readwrite'); tx.objectStore('files').put(blob, id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  catch { window.dispatchEvent(new CustomEvent('demo:notice', { detail: '附件已在本次演示中保存；浏览器未允许持久存储，刷新后需重新选择附件。' })); }
}
export async function initializeAssets() {
  for (const file of state.files) {
    let blob: Blob | undefined;
    if (file.seedText) blob = new Blob([file.seedText], { type: file.mime });
    else { try { const database = await db(); blob = await new Promise<Blob | undefined>((resolve) => { const request = database.transaction('files').objectStore('files').get(file.id); request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(undefined); }); } catch { /* no persistent attachment */ } }
    if (blob) { blobs.set(file.id, blob); urls.set(file.id, URL.createObjectURL(blob)); file.size = blob.size; }
  }
  for (const user of state.users) user.avatarUrl = user.avatarAttachmentId ? urls.get(user.avatarAttachmentId) || null : null;
  for (const c of state.conversations) c.avatarUrl = c.avatarAttachmentId ? urls.get(c.avatarAttachmentId) || null : null;
}
export function fileBlob(id: string) { return must(blobs.get(id), '这个演示附件未保存在当前浏览器，请重新选择文件。'); }
export function fileView(file: Row): Row { const url = urls.get(file.id) || ''; return { ...file, name: file.name, contentUrl: url, thumbnailUrl: file.kind === 'image' ? url : undefined, previewUrl: file.kind === 'image' ? url : undefined, width: file.width, height: file.height, errorCode: null, error: null }; }
export function contact(id: string): Row {
  const u = must(summary(id)); const me = actorId()!;
  const pending = state.requests.find(r => r.status === 'pending' && ((r.senderId === me && r.targetId === id) || (r.targetId === me && r.senderId === id)));
  return { ...u, relationship: id === me ? 'self' : (state.contacts[me] || []).includes(id) ? 'friend' : pending ? pending.senderId === me ? 'outgoing' : 'incoming' : 'none', requestId: pending?.id || null, online: !state.users.find(u => u.id === id)?.preferences.invisible && id !== 'u_xu', blocked: (state.blocks[me] || []).includes(id), notifyOnline: false, remark: '', ...state.contactPreferences[me + ':' + id] };
}
export function friendRequest(r: Row) { return { ...r, sender: summary(r.senderId), target: summary(r.targetId), direction: r.senderId === actorId() ? 'outgoing' : 'incoming' }; }
export function canSee(c: Row, id = actorId()) { return !!id && c.status !== 'dissolved' && (c.kind === 'direct' ? c.userIds.includes(id) : (state.members[c.id] || []).some(m => m.userId === id)); }
export function getConversation(id: string, admin = false): Row { const c = must(state.conversations.find(c => c.id === id)); if (!admin && !canSee(c)) throw new DemoError(403, 'RESOURCE_UNAVAILABLE', '当前演示身份已无法访问这个会话。'); return c; }
export function messageView(m: Row): Row {
  const source = state.messages.find(s => s.id === m.replyToMessageId);
  const own = m.senderId === actorId();
  return { ...m, sender: summary(m.senderId), text: m.status === 'sent' ? m.text : '', reply: source ? { id: source.id, status: source.status === 'sent' ? 'available' : 'unavailable', text: source.status === 'sent' ? source.text.slice(0, 240) : '', author: summary(source.senderId)?.nickname || '系统' } : null,
    attachments: m.status === 'sent' ? (m.attachmentIds || []).map((id: string) => state.files.find(f => f.id === id)).filter(Boolean).map(fileView) : [],
    reactions: (m.reactions || []).map((r: Row) => ({ key: r.key, count: r.userIds.length, mine: r.userIds.includes(actorId()) })), bookmarked: (m.bookmarkedBy || []).includes(actorId()),
    capabilities: { canInteract: m.status === 'sent', canRecall: own && m.status === 'sent', canModerate: actor().siteRole === 'super_admin' },
    ...(m.taskCard ? { taskCard: m.taskCard.kind === 'live' ? state.tasks.some(t => t.id === m.taskCard.taskId && !t.deletedAt) ? { kind: 'live', task: taskView(state.tasks.find(t => t.id === m.taskCard.taskId)!) } : { kind: 'unavailable' } : m.taskCard } : {}) };
}
export function conversationView(c: Row): Row {
  const me = actorId()!; const member = (state.members[c.id] || []).find(m => m.userId === me); const messages = state.messages.filter(m => m.conversationId === c.id);
  const peerId = c.kind === 'direct' ? c.userIds.find((id: string) => id !== me) : null;
  const readSeq = String(c.readByUser?.[me] || 0); const lastSeq = messages.at(-1)?.seq || '0';
  const blocked = peerId && ((state.blocks[me] || []).includes(peerId) || !(state.contacts[me] || []).includes(peerId));
  const muted = c.status === 'frozen' || actor().restrictions.mutedUntil > now() || !!(member?.mutedUntil > now()) || !!(state.groupSettings[c.id]?.everyoneMuted && member?.role === 'member');
  return { ...c, title: peerId ? summary(peerId)?.nickname || c.title : c.title, peer: peerId ? { ...summary(peerId), online: contact(peerId).online } : null, role: member?.role || 'member', periodId: member?.periodId || null, memberCount: c.kind === 'group' ? (state.members[c.id] || []).length : 2, lastSeq, readSeq, peerReadSeq: c.kind === 'direct' ? lastSeq : null,
    unreadCount: messages.filter(m => Number(m.seq) > Number(readSeq) && m.senderId !== me).length,
    lastMessage: messages.length ? messageView(messages.at(-1)!) : null, canSend: !blocked && !muted, sendDisabledReason: blocked ? '请先恢复好友关系。' : muted ? '当前群聊已冻结或处于禁言状态。' : null, sendErrorCode: blocked ? 'FRIENDSHIP_REQUIRED' : muted ? 'MUTED' : null,
    accessKey: c.id + ':' + (member?.periodId || 'direct') + ':' + c.version, preferences: { muted: false, pinned: c.id === 'g_design', archived: false, onlyMentions: false, ...c.preferencesByUser?.[me] } };
}
export function groupDetail(id: string): Row {
  const conversation = conversationView(getConversation(id)); const manager = ['owner', 'admin'].includes(conversation.role) && conversation.status === 'active'; const owner = conversation.role === 'owner' && manager;
  const transfer = state.transfers.find(t => t.conversationId === id && t.status === 'pending');
  return { conversation, version: conversation.version, settings: state.groupSettings[id], capabilities: { canEdit: manager, canInvite: manager || state.groupSettings[id].inviteRole === 'members', canReview: manager, canAssignRoles: owner, canTransfer: owner, canDissolve: owner, canLeave: !owner }, transfer: transfer ? transferView(transfer) : null };
}
export function memberView(m: Row) { return { ...m, user: summary(m.userId) }; }
export function transferView(t: Row) { return { ...t, from: summary(t.fromId), to: summary(t.toId) }; }
export function inviteView(invite: Row): Row { const c = state.conversations.find(c => c.id === invite.conversationId); return { ...invite, groupName: c?.title || '群聊', creator: summary(invite.creatorId), target: summary(invite.targetId), remaining: Math.max(0, invite.maxUses - invite.used - invite.reserved), state: invite.revokedAt ? 'revoked' : invite.expiresAt < now() ? 'expired' : c?.status === 'dissolved' ? 'unavailable' : invite.used >= invite.maxUses ? 'exhausted' : 'available', canRevoke: ['owner', 'admin'].includes((state.members[c?.id] || []).find(m => m.userId === actorId())?.role) }; }
export function applicationView(a: Row): Row { return { ...a, user: summary(a.userId), groupName: state.conversations.find(c => c.id === a.conversationId)?.title || '群聊', currentMember: (state.members[a.conversationId] || []).some(m => m.userId === a.userId) }; }
export function taskAccessible(t: Row) { return t.scope === 'personal' ? t.ownerId === actorId() : state.conversations.some(c => c.id === t.groupId && canSee(c)); }
export function taskView(t: Row): Row {
  const me = actorId()!; const group = state.conversations.find(c => c.id === t.groupId); const role = (state.members[t.groupId] || []).find(m => m.userId === me)?.role; const manageable = t.scope === 'personal' || ['owner', 'admin'].includes(role) || t.creatorId === me; const canWrite = !t.deletedAt && group?.status !== 'frozen' && !!state.policy.feature_tasks;
  return { ...t, groupName: group?.title || null, creator: summary(t.creatorId), assignee: summary(t.assigneeId), overdue: !!t.dueOn && t.status !== 'done' && t.dueOn < new Date().toISOString().slice(0, 10), etag: '"task:' + t.id + ':' + t.version + '"', viewerId: me,
    capabilities: { ...CAPS, edit: canWrite && manageable, remove: canWrite && manageable, restore: !!t.deletedAt && manageable, progress: canWrite, assign: canWrite && manageable, claim: canWrite && !t.assigneeId, release: canWrite && t.assigneeId === me, checkStructure: canWrite && manageable, checkToggle: canWrite, comment: canWrite, share: !t.deletedAt, writeReason: canWrite ? null : '任务已删除或当前不可编辑。' },
    followed: (t.followedBy || []).includes(me), bookmarked: (t.bookmarkedBy || []).includes(me), reminder: t.reminders?.[me] || { rule: 'none', time: '09:00' } };
}
export function adminUser(u: Row): Row { return { ...publicUser(u), deletionAt: u.deletionAt || null, lastSeenAt: now() - 300000, sessionCount: state.sessions.filter(s => s.userId === u.id && !s.revokedAt).length, ownedGroupCount: Object.values(state.members).filter(ms => ms.some(m => m.userId === u.id && m.role === 'owner')).length, storageBytes: state.files.filter(f => f.ownerId === u.id).reduce((s, f) => s + f.size, 0), quotaBytes: u.quotaBytes ?? state.policy.user_quota_bytes, mutedUntil: u.restrictions.mutedUntil, statusReason: u.statusReason || '', muteReason: u.restrictions.muteReason, restrictionReason: u.restrictions.reason, uploadDisabled: u.restrictions.uploadDisabled, groupCreationDisabled: u.restrictions.groupCreationDisabled, mustChangePassword: !!u.mustChangePassword, hasSecondFactor: u.siteRole === 'super_admin' }; }
export function adminGroup(c: Row): Row { return { id: c.id, name: c.title, description: c.description, owner: summary((state.members[c.id] || []).find(m => m.role === 'owner')?.userId) || summary('u_admin'), status: c.status, memberCount: (state.members[c.id] || []).length, createdAt: c.createdAt, updatedAt: c.updatedAt, roleVersion: c.version, lastSeq: String(state.messages.filter(m => m.conversationId === c.id).length), ...state.groupSettings[c.id] }; }
export function adminFile(f: Row): Row { return { ...f, owner: summary(f.ownerId), messageId: f.messageId || null, conversationId: f.conversationId || null, sha256: f.sha256 || 'DEMO-BROWSER-LOCAL', governance: f.governance || 'available', governanceReason: f.governanceReason || '', chargedBytes: f.size, contentAvailable: f.governance !== 'revoked', previewAvailable: f.kind === 'image', cleanupReason: null }; }
export function adminMessage(m: Row): Row { const c = state.conversations.find(c => c.id === m.conversationId)!; return { ...m, sender: summary(m.senderId), conversation: { id: c.id, title: c.title, kind: c.kind, status: c.status }, text: m.status === 'sent' ? m.text : null, moderationKind: m.moderationKind || null, removedAt: m.removedAt || null, removedReason: m.removedReason || null, retained: true, canRestore: m.status === 'moderated', attachments: (m.attachmentIds || []).map((id: string) => state.files.find(f => f.id === id)).filter(Boolean).map(adminFile), reviewedAt: m.reviewedAt || null, reviewedBy: summary(m.reviewedById), version: m.version || 1 }; }
