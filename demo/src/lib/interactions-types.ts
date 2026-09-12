import type { Conversation, Message, Page, UserSummary } from './chat-types';

export type MessageLocation = { conversation: Conversation; items: Message[]; targetId: string; hasBefore: boolean; hasAfter: boolean };
export type LocatedMessage = { id: string; available: boolean; message: Message | null; conversation: { id: string; title: string; kind: 'direct' | 'group' } | null; savedAt?: number };
export type MessageResults = Page<LocatedMessage>;
export type ReportTarget = { kind: 'message' | 'user' | 'group'; id: string; label: string };
export type ReportItem = { id: string; targetKind: ReportTarget['kind']; targetId: string; category: string; description: string; status: 'open' | 'claimed' | 'resolved' | 'rejected'; createdAt: number; updatedAt: number; feedback: string | null };
export type TypingUser = UserSummary & { expiresAt: number };
