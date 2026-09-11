export interface UserView {
  id: string; avatarUrl?: string | null; username: string; nickname: string; bio: string; siteRole: 'user' | 'super_admin'; status: string; createdAt: number;
  preferences: { invisible: boolean; readReceipts: boolean; doNotDisturb: boolean };
  restrictions?: { uploadDisabled: boolean; groupCreationDisabled: boolean; reason: string; mutedUntil: number | null; muteReason: string };
}
export interface BootstrapView {
  accountsEnabled: boolean; registrationMode: 'closed' | 'invite-only' | 'open'; csrfToken: string; user: UserView | null;
  terms: { version: string; operatorName: string; operatorContact: string; development: boolean; text: string };
}
export interface AuthResult { user: UserView; csrfToken: string; expiresAt: number; recoveryCodes?: string[] }
