import type { AdminGroup, AdminIdentity, AdminPage } from './admin-types';
import type { TaskSnapshot } from './tasks-types';

export type AdminSharedTaskCard = { kind: 'snapshot'; snapshot: TaskSnapshot } | { kind: 'live'; taskId: string; groupId: string } | { kind: 'unavailable' };

export type AdminS2Action = 'message.review' | 'message.hide' | 'message.delete' | 'message.restore' | 'file.quarantine' | 'file.release' | 'file.revoke' | 'user.quota' | 'report.claim' | 'report.reopen' | 'report.reject' | 'report.resolve' | 'settings.update' | 'settings.rollback' | 'site_invite.create' | 'site_invite.revoke';
export type AdminFile = { id: string; name: string; owner: AdminIdentity; conversationId: string | null; messageId: string | null; purpose: 'message' | 'user_avatar' | 'group_avatar'; kind: 'image' | 'file'; mime: string; size: number; sha256: string; state: string; scanStatus: string; governance: 'available' | 'quarantined' | 'revoked'; governanceReason: string; chargedBytes: number; createdAt: number; expiresAt: number; version: number; contentAvailable: boolean; previewAvailable: boolean; cleanupReason: string | null };
export type AdminMessage = { id: string; conversationId: string; seq: string; conversation: { id: string; title: string; kind: 'direct' | 'group'; status: string }; sender: AdminIdentity | null; kind: 'user' | 'system'; text: string | null; taskCard?: AdminSharedTaskCard | null; status: 'sent' | 'recalled' | 'moderated' | 'purged'; moderationKind: 'hidden' | 'deleted' | null; createdAt: number; removedAt: number | null; removedReason: string | null; retained: boolean; canRestore: boolean; attachments: AdminFile[]; replyToMessageId: string | null; reviewedAt: number | null; reviewedBy: AdminIdentity | null; version: number };
export type AdminMessageContext = { message: AdminMessage; items: AdminMessage[]; hasBefore: boolean; hasAfter: boolean };
export type AdminReportSummary = { id: string; reporter: AdminIdentity; targetKind: 'message' | 'user' | 'group'; targetId: string; category: 'spam' | 'harassment' | 'illegal' | 'other'; status: 'open' | 'claimed' | 'resolved' | 'rejected'; assignedTo: AdminIdentity | null; version: number; createdAt: number; updatedAt: number };
export type AdminReport = AdminReportSummary & { description: string; feedback: string | null };
export type AdminReportDetail = { report: AdminReport; events: { id: string; actor: AdminIdentity; action: string; reason: string; createdAt: number }[]; target: AdminMessage | AdminIdentity | AdminGroup | null };
export type PolicyField = { key: string; label: string; group: string; type: 'boolean' | 'integer' | 'string' | 'enum'; min?: number; max?: number; options?: { value: string; label: string }[]; help: string };
export type PolicyValues = Record<string, string | number | boolean>;
export type AdminSettings = { version: number; values: PolicyValues; fields: PolicyField[]; appliedAt: number | null; effect: 'immediate'; environment: string; readOnly: string[] };
export type AdminPolicyVersion = { version: number; actor: AdminIdentity | null; reason: string; createdAt: number; values: PolicyValues };
export type AdminSiteInvite = { id: string; createdBy: AdminIdentity | null; createdAt: number; expiresAt: number; maxUses: number; used: number; revokedAt: number | null; status: 'active' | 'revoked' | 'expired' | 'exhausted' };
export type SensitiveSearch = { reason: string; query?: string; conversationId?: string; fromAt?: number; until?: number; after?: string; limit?: number };
export type ContentSearchInput = SensitiveSearch & { senderId?: string; kind?: '' | 'direct' | 'group'; status?: '' | AdminMessage['status'] };
export type FileSearchInput = SensitiveSearch & { ownerId?: string; kind?: '' | 'image' | 'file'; state?: string; governance?: '' | AdminFile['governance'] };
export type AdminContentPage = AdminPage<AdminMessage>;
