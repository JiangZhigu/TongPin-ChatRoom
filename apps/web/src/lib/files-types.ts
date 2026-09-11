import type { Attachment } from './chat-types';

export type UploadState = 'reserved' | 'uploading' | 'processing' | 'ready' | 'quarantined' | 'rejected' | 'cancelled' | 'expired';
export type UploadPurpose = 'message' | 'user_avatar' | 'group_avatar';
export type UploadRecord = Attachment & { purpose: UploadPurpose; conversationId: string | null; state: UploadState; scanStatus: 'not_scanned' | 'clean' | 'infected' | 'unknown'; errorCode: string | null; error: string | null; createdAt: number; expiresAt: number; bound: boolean };
export type FilePolicy = { imageLimit: number; fileLimit: number; attachmentCount: number; messageBytes: number; userQuota: number; usedBytes: number; reservedBytes: number; supportedExtensions: string[]; scanPolicy: 'strict' | 'closed-test-unscanned'; scanner: 'disabled' | 'configured'; };
export type FileListItem = Attachment & { conversationId: string; conversationTitle: string; messageId: string; senderName: string; createdAt: number };
