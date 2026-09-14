import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { messageSoundSettings, messageSoundsSupported, previewMessageSound, setMessageSoundSettings } from '../lib/message-sounds';

export function MessageSoundSettings({ userId }: { userId: string }) {
  const [settings, setSettings] = useState(() => messageSoundSettings(userId));
  const [notice, setNotice] = useState('');
  const revision = useRef(0);
  const supported = messageSoundsSupported();
  useEffect(() => {
    const update = () => { revision.current++; setSettings(messageSoundSettings(userId)); setNotice(''); };
    update(); window.addEventListener('storage', update); window.addEventListener('tongpin:message-sounds-changed', update);
    return () => { revision.current++; window.removeEventListener('storage', update); window.removeEventListener('tongpin:message-sounds-changed', update); };
  }, [userId]);
  return <section className="settings-card message-sound-settings">
    <h2>消息提示音</h2>
    <p className="field-hint">收到新消息时播放轻柔提示音。免打扰、会话静音和仅提醒提及的设置优先；连续消息会合并响铃。</p>
    <label className="preference-row"><span><strong>播放消息提示音</strong><small>默认开启，仅保存到本机浏览器的当前账号。</small></span><input type="checkbox" aria-label="播放消息提示音" checked={settings.enabled} disabled={!supported} onChange={(event) => setSettings(setMessageSoundSettings(userId, { enabled: event.target.checked }))} /></label>
    <label className="message-sound-volume">提示音音量 · {Math.round(settings.volume * 100)}%<input type="range" min="0" max="100" step="5" aria-label="提示音音量" disabled={!supported || !settings.enabled} value={Math.round(settings.volume * 100)} onChange={(event) => setSettings(setMessageSoundSettings(userId, { volume: Number(event.target.value) / 100 }))} /></label>
    <button className="secondary-button" type="button" disabled={!supported || !settings.volume} onClick={() => { setNotice(''); const attempt = ++revision.current; void previewMessageSound(userId).then((played) => { if (revision.current === attempt) setNotice(played ? '提示音已播放。' : '暂时无法播放，请检查浏览器的网站声音权限。'); }); }}><Volume2 size={17} />试听提示音</button>
    {!supported && <p className="field-hint">当前浏览器不支持提示音，消息接收不受影响。</p>}
    {notice && <p role="status" className="field-hint">{notice}</p>}
  </section>;
}
