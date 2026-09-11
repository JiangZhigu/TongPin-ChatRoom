export interface UserView {
  id: string; username: string; nickname: string; bio: string; siteRole: 'user' | 'super_admin'; status: string; createdAt: number;
  preferences: { invisible: boolean; readReceipts: boolean; doNotDisturb: boolean };
}
export interface BootstrapView {
  accountsEnabled: boolean; registrationMode: 'closed' | 'invite-only' | 'open'; csrfToken: string; user: UserView | null;
  terms: { version: string; operatorName: string; operatorContact: string; development: boolean; text: string };
}
export interface AuthResult { user: UserView; csrfToken: string; expiresAt: number; recoveryCodes?: string[] }
