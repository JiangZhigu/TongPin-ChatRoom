import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';

export function RecoveryCodesPanel({ codes, onConfirm }: { codes: string[]; onConfirm: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(codes.join('\n')); setCopyStatus('已复制，请粘贴到安全的位置保存。'); }
    catch { setCopyStatus('无法复制，请手动选中恢复码并保存。'); }
  }
  return <section className="recovery-panel" aria-labelledby="recovery-title"><span className="empty-symbol"><KeyRound size={28} aria-hidden="true" /></span><h2 id="recovery-title">保存你的恢复码</h2><p>恢复码只在这里显示一次。离开或刷新页面后无法再次查看；请存放在安全的位置，不要分享给任何人。</p><p className="warning-note">本次使用的那一组恢复码会失效，旧登录会话将全部注销。恢复码丢失后没有自动找回方式。</p><ul className="recovery-code-grid">{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul><button className="secondary-button" onClick={() => void copy()}><Copy size={16} />复制恢复码</button><p role="status" className="field-hint">{copyStatus}</p><label className="checkbox-row"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />我已将恢复码保存到安全的位置</label><button className="primary-button" disabled={!saved} onClick={onConfirm}>已保存，继续<Check size={16} /></button></section>;
}
