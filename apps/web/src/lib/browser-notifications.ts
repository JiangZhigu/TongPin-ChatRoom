export type BrowserNotificationStatus = { supported: boolean; permission: NotificationPermission | 'unsupported'; enabled: boolean };
const fallback = new Map<string, boolean>();
const notices = new Map<Notification, string>();
const preferenceKey = (userId: string) => 'tongpin-browser-notifications:' + userId;
function optedIn(userId: string): boolean { if (fallback.has(userId)) return fallback.get(userId)!; try { return localStorage.getItem(preferenceKey(userId)) === 'enabled'; } catch { return false; } }
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => { if (event.key?.startsWith('tongpin-browser-notifications:')) fallback.delete(event.key.slice('tongpin-browser-notifications:'.length)); });
function remember(userId: string, enabled: boolean) {
  fallback.delete(userId); fallback.set(userId, enabled);
  while (fallback.size > 20) fallback.delete(fallback.keys().next().value!);
  try { if (enabled) localStorage.setItem(preferenceKey(userId), 'enabled'); else localStorage.removeItem(preferenceKey(userId)); } catch { /* User consent still applies to this open page when storage is unavailable. */ }
}
export function browserNotificationStatus(userId: string): BrowserNotificationStatus {
  const supported = typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function';
  const permission = supported ? Notification.permission : 'unsupported';
  return { supported, permission, enabled: supported && permission === 'granted' && optedIn(userId) };
}
/** Invoke only from the explicit enable control, never from startup or message delivery. */
export async function enableBrowserNotifications(userId: string): Promise<BrowserNotificationStatus> {
  if (browserNotificationStatus(userId).supported) {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    remember(userId, permission === 'granted');
  }
  return browserNotificationStatus(userId);
}
export function closeBrowserNotifications(userId: string): void {
  for (const [notice, owner] of notices) if (owner === userId) { notice.close(); notices.delete(notice); }
}
export function disableBrowserNotifications(userId: string): void { remember(userId, false); closeBrowserNotifications(userId); }
export function showBrowserNotification(userId: string, options: { tag: string; title: string; body: string; onClick?: () => void }): boolean {
  if (!browserNotificationStatus(userId).enabled) return false;
  try {
    const notice = new Notification(options.title, { tag: 'tongpin:' + userId + ':' + options.tag, body: options.body });
    notices.set(notice, userId);
    while (notices.size > 20) { const oldest = notices.keys().next().value!; oldest.close(); notices.delete(oldest); }
    notice.onclose = () => notices.delete(notice);
    notice.onclick = () => { notice.close(); notices.delete(notice); window.focus(); options.onClick?.(); };
    return true;
  } catch { return false; }
}
