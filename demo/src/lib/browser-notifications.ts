/** The standalone demo never requests OS notification permission. */
export type BrowserNotificationStatus = { supported: boolean; permission: NotificationPermission | 'unsupported'; enabled: boolean };
const enabled = new Set<string>();
const key = (userId: string) => 'tongpin-demo-browser-notifications:' + userId;
export function browserNotificationStatus(userId: string): BrowserNotificationStatus {
  let active = enabled.has(userId);
  try { active ||= localStorage.getItem(key(userId)) === 'enabled'; } catch { /* Memory-only demo. */ }
  return { supported: true, permission: active ? 'granted' : 'default', enabled: active };
}
export async function enableBrowserNotifications(userId: string): Promise<BrowserNotificationStatus> {
  enabled.add(userId); try { localStorage.setItem(key(userId), 'enabled'); } catch { /* Memory-only demo. */ }
  window.dispatchEvent(new CustomEvent('demo:notice', { detail: '已模拟启用通知；演示不会申请系统权限或发送系统通知。' }));
  return browserNotificationStatus(userId);
}
export function closeBrowserNotifications(_userId: string): void { /* No OS notifications are created. */ }
export function disableBrowserNotifications(userId: string): void { enabled.delete(userId); try { localStorage.removeItem(key(userId)); } catch { /* Memory-only demo. */ } }
export function showBrowserNotification(userId: string, options: { tag: string; title: string; body: string; onClick?: () => void }): boolean {
  if (!browserNotificationStatus(userId).enabled) return false;
  window.dispatchEvent(new CustomEvent('demo:notice', { detail: options.title + '：' + options.body }));
  return true;
}
