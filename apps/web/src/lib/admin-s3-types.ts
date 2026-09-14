import type { AdminIdentity, AdminPage } from './admin-types';
import type { UserView } from '../auth-types';

export type AdminS3Action = 'announcement.create' | 'announcement.withdraw' | 'administrator.invite' | 'administrator.cancel' | 'administrator.revoke' | 'administrator.factor_reset' | 'export.create' | 'backup.create' | 'backup.verify' | 'backup.drill' | 'storage.cleanup' | 'operation.cancel' | 'operation.retry' | 'job.retry';

export type AnnouncementParameters = { kind: 'announcement' | 'notification'; title: string; body: string; audience: 'all' | 'users' | 'group'; userIds: string[]; groupId: string; publishAt: number | null };
export type AdminAnnouncement = { id: string; kind: 'announcement' | 'notification'; title: string; body: string; audience: 'all' | 'users' | 'group'; groupId: string | null; creator: AdminIdentity; status: 'scheduled' | 'sending' | 'published' | 'withdrawn' | 'failed'; recipientCount: number; deliveredCount: number; publishAt: number; publishedAt: number | null; withdrawnAt: number | null; createdAt: number; errorCode: string | null; version: number; jobId: string };
export type SystemNotice = { id: string; kind: 'announcement' | 'notification'; title: string; body: string; status: 'published' | 'withdrawn'; publishedAt: number | null };
export type AdminAdministrator = { user: AdminIdentity; status: string; usable: boolean; hasSecondFactor: boolean; sessionCount: number; lastSeenAt: number | null; version: number };
export type AdminAdminInvitation = { id: string; user: AdminIdentity; inviter: AdminIdentity; purpose: 'grant' | 'factor_reset'; status: 'pending' | 'accepted' | 'cancelled' | 'expired'; createdAt: number; expiresAt: number };
export type AdminAdministrators = { administrators: AdminPage<AdminAdministrator>; invitations: AdminAdminInvitation[] };
export type AdminEnrollmentStatus = { invitation: { id: string; purpose: 'grant' | 'factor_reset'; expiresAt: number; inviter: AdminIdentity } | null };
export type AdminEnrollment = { enrollmentId: string; expiresAt: number };
export type AdminEnrollmentResult = { user: UserView };
export type AuditFilters = { actorId?: string; subjectId?: string; action?: string; result?: string; requestId?: string; jobId?: string; fromAt?: number | null; until?: number | null };
export type AdminAuditEvent = { id: string; actor: AdminIdentity | null; subjectId: string | null; action: string; reason: string; result: string; device: string; details: Record<string, unknown>; createdAt: number; requestId: string | null; jobId: string | null };
export type AdminRuntimeLog = { id: string; level: 'warning' | 'error'; code: string; route: string; status: number | null; actorId: string | null; requestId: string | null; jobId: string | null; createdAt: number };
export type ExportFilters = AuditFilters & { query?: string; conversationId?: string; senderId?: string; ownerId?: string; kind?: string; status?: string; governance?: string; state?: string };
export type ExportParameters = { kind: 'content' | 'files' | 'audit'; filters: ExportFilters; maxRows: number; maxBytes: number; includeFiles: boolean };
export type AdminOperation = { id: string; kind: 'export.create' | 'backup.create' | 'backup.verify' | 'backup.drill' | 'storage.cleanup'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; creator: AdminIdentity | null; createdAt: number; updatedAt: number; expiresAt: number | null; progress: number; total: number; bytes: number; message: string; errorCode: string | null; result: Record<string, unknown>; jobId: string; requestId: string; canCancel: boolean; canRetry: boolean; canDownload: boolean; sha256: string | null; backupClass: 'daily' | 'weekly' | null };
export type AdminJob = { id: string; kind: string; entityId: string; status: string; attempts: number; createdAt: number; runAfter: number; leaseUntil: number | null; completedAt: number | null; errorCode: string | null; operationId: string | null; canRetry: boolean; limitation: string | null };
