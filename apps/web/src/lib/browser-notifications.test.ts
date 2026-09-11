// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNotificationStatus, closeBrowserNotifications, disableBrowserNotifications, enableBrowserNotifications, showBrowserNotification } from './browser-notifications';
import { emojiKey, emojiVariants, filterEmoji, loadEmojiData, recentEmoji, rememberEmoji } from './emoji';

const issued: BrowserNotice[] = [];
class BrowserNotice {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => { BrowserNotice.permission = 'granted'; return 'granted'; });
  close = vi.fn(); onclose: (() => void) | null = null; onclick: (() => void) | null = null;
  constructor(public title: string, public options: NotificationOptions) { issued.push(this); }
}
beforeEach(() => { issued.length = 0; localStorage.clear(); vi.stubGlobal('Notification', BrowserNotice); BrowserNotice.permission = 'default'; BrowserNotice.requestPermission.mockClear(); disableBrowserNotifications('notice-a'); disableBrowserNotifications('notice-b'); });
afterEach(() => { closeBrowserNotifications('notice-a'); closeBrowserNotifications('notice-b'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('browser notification explicit opt-in and bounded lifetime', () => {
  it('never asks permission from status or incoming messages and requires each identity opt-in', async () => {
    expect(browserNotificationStatus('notice-a').enabled).toBe(false);
    expect(showBrowserNotification('notice-a', { tag: 'room', title: '同频', body: '新消息' })).toBe(false);
    expect(BrowserNotice.requestPermission).not.toHaveBeenCalled();
    expect((await enableBrowserNotifications('notice-a')).enabled).toBe(true);
    expect(BrowserNotice.requestPermission).toHaveBeenCalledTimes(1);
    expect(browserNotificationStatus('notice-b').enabled).toBe(false);
    expect(showBrowserNotification('notice-a', { tag: 'room', title: '同频', body: '新消息' })).toBe(true);
    expect(issued[0].options.tag).toBe('tongpin:notice-a:room');
  });
  it('handles denied and unavailable APIs without breaking messages', async () => {
    BrowserNotice.requestPermission.mockImplementationOnce(async () => { BrowserNotice.permission = 'denied'; return 'denied'; });
    expect((await enableBrowserNotifications('notice-a')).enabled).toBe(false);
    expect(issued).toEqual([]);
    vi.stubGlobal('Notification', undefined);
    expect(browserNotificationStatus('notice-a')).toEqual({ supported: false, permission: 'unsupported', enabled: false });
    expect(showBrowserNotification('notice-a', { tag: 'room', title: '同频', body: '新消息' })).toBe(false);
  });
  it('keeps explicit consent in memory when storage fails and closes only the stopped identity', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('storage blocked'); });
    await enableBrowserNotifications('notice-a'); await enableBrowserNotifications('notice-b');
    expect(browserNotificationStatus('notice-a').enabled).toBe(true);
    for (let i = 0; i < 24; i++) showBrowserNotification('notice-a', { tag: String(i), title: '同频', body: '通用提醒' });
    showBrowserNotification('notice-b', { tag: 'own', title: '同频', body: '通用提醒' });
    expect(issued.slice(0, 5).every((item) => item.close.mock.calls.length === 1)).toBe(true);
    closeBrowserNotifications('notice-a');
    expect(issued.slice(0, 24).every((item) => item.close.mock.calls.length === 1)).toBe(true);
    expect(issued[24].close).not.toHaveBeenCalled();
    disableBrowserNotifications('notice-b'); expect(issued[24].close).toHaveBeenCalledOnce();
  });
  it('focuses and locates on click then releases the notice', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined); const locate = vi.fn();
    await enableBrowserNotifications('notice-a');
    showBrowserNotification('notice-a', { tag: 'room', title: '同频', body: '通用提醒', onClick: locate });
    issued[0].onclick?.(); expect(focus).toHaveBeenCalledOnce(); expect(locate).toHaveBeenCalledOnce();
    closeBrowserNotifications('notice-a'); expect(issued[0].close).toHaveBeenCalledOnce();
  });
});

describe('full shipped emoji search and per-user optional recents', () => {
  it('searches Chinese and English and only offers existing fully qualified modifier variants', async () => {
    const data = await loadEmojiData(); expect(data.entries).toHaveLength(3944);
    const entry = data.entries.find((row) => row.sequence === '👩🏽‍💻')!;
    expect(emojiKey(entry.sequence)).toBe('1F469-1F3FD-200D-1F4BB');
    expect(filterEmoji(data, '程序员')).toContain(entry);
    expect(filterEmoji(data, 'technologist')).toContain(entry);
    const variants = emojiVariants(data, entry);
    expect(variants).toHaveLength(6); expect(variants.every((row) => data.entries.includes(row))).toBe(true);
    expect(emojiVariants(data, data.entries.find((row) => row.sequence === '😀')!)).toHaveLength(1);
  });
  it('preserves full ZWJ sequences and bounds recents separately for each user', () => {
    rememberEmoji('emoji-a', '👩🏽‍💻'); rememberEmoji('emoji-b', '🇨🇳'); rememberEmoji('emoji-a', '👩🏽‍💻');
    expect(recentEmoji('emoji-a')).toEqual(['👩🏽‍💻']); expect(recentEmoji('emoji-b')).toEqual(['🇨🇳']);
    for (let i = 0; i < 30; i++) rememberEmoji('emoji-a', String(i));
    expect(recentEmoji('emoji-a')).toHaveLength(24);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('storage blocked'); });
    expect(() => rememberEmoji('emoji-a', '❤️')).not.toThrow();
  });
});
