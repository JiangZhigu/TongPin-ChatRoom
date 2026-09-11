import { useEffect, useState, type FormEvent } from 'react';
import { LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, APIError } from './lib/api';
import type { UserView } from './auth-types';
import { FormField } from './components/FormField';
import { Modal } from './components/Modal';
import { RecoveryCodesPanel } from './components/RecoveryCodesPanel';

interface SessionView { id: string; device: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }
interface SecurityEventView { id: string; action: string; createdAt: number; device: string; result: string }
type SensitiveAction = { kind: 'revoke'; session: SessionView } | { kind: 'password'; password: string } | { kind: 'codes' };
const formatTime = (time: number) => new Date(time).toLocaleString('zh-CN');
const messageOf = (cause: unknown) => {
  if (cause instanceof APIError) return [cause.message, ...Object.values(cause.fieldErrors || {}), cause.retryAfterMs ? `请在 ${Math.ceil(cause.retryAfterMs / 1000)} 秒后重试。` : ''].filter(Boolean).join(' ');
  return cause instanceof Error ? cause.message : '操作失败，请重试。';
};

export function AccountSettings({ user, onUserChange, onSignedOut }: { user: UserView; onUserChange: (user: UserView) => void; onSignedOut: () => void }) {
  const [nickname, setNickname] = useState(user.nickname); const [bio, setBio] = useState(user.bio);
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<SessionView[] | null>(null); const [sessionsError, setSessionsError] = useState('');
  const [events, setEvents] = useState<SecurityEventView[] | null>(null); const [eventsError, setEventsError] = useState('');
  const [reload, setReload] = useState(0); const [pending, setPending] = useState<SensitiveAction | null>(null);
  const [reauthPassword, setReauthPassword] = useState(''); const [factor, setFactor] = useState('');
  const [reauthError, setReauthError] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setSessions(null); setEvents(null); setSessionsError(''); setEventsError('');
    void api<{ items: SessionView[] }>('/api/v1/account/sessions', { signal: controller.signal }).then((data) => setSessions(data.items)).catch((cause) => { if (!controller.signal.aborted) setSessionsError(messageOf(cause)); });
    void api<{ items: SecurityEventView[] }>('/api/v1/account/security-events', { signal: controller.signal }).then((data) => setEvents(data.items)).catch((cause) => { if (!controller.signal.aborted) setEventsError(messageOf(cause)); });
    return () => controller.abort();
  }, [reload]);
  function captureError(cause: unknown) { setError(messageOf(cause)); if (cause instanceof APIError) setFields(cause.fieldErrors || {}); }
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice(''); setFields({});
    try { const data = await api<{ user: UserView }>('/api/v1/account/profile', { method: 'PATCH', body: { nickname, bio } }); onUserChange(data.user); setNickname(data.user.nickname); setBio(data.user.bio); setNotice('个人资料已保存。'); }
    catch (cause) { captureError(cause); } finally { setBusy(false); }
  }
  async function changePreference(key: keyof UserView['preferences'], value: boolean) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { const data = await api<{ user: UserView }>('/api/v1/account/preferences', { method: 'PATCH', body: { [key]: value } }); onUserChange(data.user); setNotice('偏好设置已保存。'); }
    catch (cause) { captureError(cause); } finally { setBusy(false); }
  }
  async function logout() {
    if (busy) return; setBusy(true); setError('');
    try { await api('/api/v1/auth/logout', { method: 'POST', body: {} }); onSignedOut(); }
    catch (cause) { captureError(cause); } finally { setBusy(false); }
  }
  function begin(action: SensitiveAction) { setPending(action); setReauthPassword(''); setFactor(''); setReauthError(''); }
  async function confirmAction(event: FormEvent) {
    event.preventDefault(); if (!pending || busy) return; setBusy(true); setReauthError(''); setNotice('');
    const action = pending.kind === 'revoke' ? `revoke_session:${pending.session.id}` : pending.kind === 'password' ? 'change_password' : 'recovery_codes';
    try {
      const { reauthToken } = await api<{ reauthToken: string }>('/api/v1/auth/reauth', { method: 'POST', body: { password: reauthPassword, action, ...(factor ? { secondFactor: factor } : {}) } });
      if (pending.kind === 'revoke') { await api(`/api/v1/account/sessions/${encodeURIComponent(pending.session.id)}`, { method: 'DELETE', body: { reauthToken } }); if (pending.session.current) onSignedOut(); else { setReload((value) => value + 1); setNotice('该设备会话已撤销。'); } }
      else if (pending.kind === 'password') { await api('/api/v1/account/password', { method: 'POST', body: { password: pending.password, reauthToken } }); onSignedOut(); }
      else { const data = await api<{ recoveryCodes: string[] }>('/api/v1/account/recovery-codes', { method: 'POST', body: { reauthToken } }); setCodes(data.recoveryCodes); setReload((value) => value + 1); }
      setPending(null); setReauthPassword(''); setFactor(''); setPassword(''); setConfirmation('');
    } catch (cause) { setReauthError(messageOf(cause)); }
    finally { setBusy(false); }
  }
  if (codes) return <Modal open title="新恢复码已生成" dismissible={false} onClose={() => undefined}><RecoveryCodesPanel codes={codes} onConfirm={() => { setCodes(null); setNotice('新恢复码已生成，旧恢复码已全部失效。'); }} /></Modal>;
  return <div className="account-settings"><header className="settings-heading"><div><h1>账号设置</h1><p>管理你的个人资料与账号安全。</p></div><button className="secondary-button" onClick={() => void logout()} disabled={busy}><LogOut size={16} />退出登录</button></header>{error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status" className="success-note">{notice}</p>}<section className="settings-card"><h2>个人资料</h2><p className="field-hint">用户名：{user.username}</p><form onSubmit={(event) => void saveProfile(event)}><fieldset disabled={busy}><FormField label="昵称" value={nickname} onChange={(e) => setNickname(e.target.value)} required error={fields.nickname} /><label className="form-field bio-field">个人简介<textarea value={bio} onChange={(e) => setBio(e.target.value)} aria-invalid={!!fields.bio} /></label>{fields.bio && <p className="field-error">{fields.bio}</p>}<button className="primary-button">保存资料</button></fieldset></form></section><section className="settings-card"><h2>隐私与通知偏好</h2><p className="field-hint">偏好保存到账号；相关聊天功能开放后生效。</p>{([{ key: 'invisible', label: '隐身状态', help: '不向其他用户展示在线状态。' }, { key: 'readReceipts', label: '阅读回执', help: '允许向私聊对方展示真实阅读进度。' }, { key: 'doNotDisturb', label: '消息免打扰', help: '减少消息提醒。' }] as const).map(({ key, label, help }) => <label className="preference-row" key={key}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={user.preferences[key]} disabled={busy} onChange={(e) => void changePreference(key, e.target.checked)} /></label>)}</section><section className="settings-card"><div className="card-heading"><h2>登录设备</h2><button className="icon-button" aria-label="刷新设备和安全记录" disabled={busy} onClick={() => setReload((value) => value + 1)}><RefreshCw size={18} /></button></div><p className="field-hint">撤销设备需要再次验证身份，该设备将需要重新登录。</p>{sessionsError ? <p className="form-error" role="alert">{sessionsError}</p> : sessions === null ? <p role="status">正在加载设备…</p> : sessions.length === 0 ? <p className="field-hint">暂无可显示的登录设备。</p> : <ul className="security-list">{sessions.map((session) => <li key={session.id}><div><strong>{session.device || '未知设备'}</strong>{session.current && <span className="current-device">当前设备</span>}<small>登录：{formatTime(session.createdAt)}</small><small>最近活动：{formatTime(session.lastSeenAt)}</small></div><button className="text-button danger-text" disabled={busy} onClick={() => begin({ kind: 'revoke', session })}>撤销{session.current ? '当前会话' : '会话'}</button></li>)}</ul>}</section><section className="settings-card"><h2>修改密码</h2><p className="warning-note">修改后所有设备都会退出登录，包括当前设备。</p><form onSubmit={(event) => { event.preventDefault(); if (password !== confirmation) { setError('两次输入的新密码不一致。'); return; } begin({ kind: 'password', password }); }}><fieldset disabled={busy}><FormField label="新密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required hint="15–128 个字符，支持空格与中文。" /><FormField label="确认新密码" type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required /><button className="secondary-button">验证身份并修改密码</button></fieldset></form></section><section className="settings-card"><h2>账号恢复码</h2><p>重新生成后，原来保存的全部账号恢复码立即失效。新恢复码只显示一次。</p><button className="secondary-button" disabled={busy} onClick={() => begin({ kind: 'codes' })}><ShieldCheck size={17} />验证身份并重新生成</button></section><section className="settings-card"><h2>近期安全记录</h2>{eventsError ? <p className="form-error" role="alert">{eventsError}</p> : events === null ? <p role="status">正在加载记录…</p> : events.length === 0 ? <p className="field-hint">暂无可显示的安全记录。</p> : <ul className="security-list">{events.map((item) => <li key={item.id}><div><strong>{item.action}</strong><small>{item.device || '未知设备'} · {formatTime(item.createdAt)}</small></div><span>{item.result}</span></li>)}</ul>}</section><Modal open={!!pending} title="再次验证身份" dismissible={!busy} onClose={() => { if (!busy) { setPending(null); setReauthPassword(''); setFactor(''); } }}><p>{pending?.kind === 'password' ? '确认修改密码后，全部设备会话将被注销。' : pending?.kind === 'revoke' ? `即将撤销「${pending.session.device || '未知设备'}」的会话。` : '确认后将生成新恢复码，旧恢复码立即失效。'}</p><form onSubmit={(event) => void confirmAction(event)}><fieldset disabled={busy}><FormField label="当前密码" type="password" value={reauthPassword} onChange={(e) => setReauthPassword(e.target.value)} autoComplete="current-password" required /><FormField label="动态码或第二因素恢复码（管理员必填）" value={factor} onChange={(e) => setFactor(e.target.value)} autoComplete="off" /></fieldset>{reauthError && <p className="form-error" role="alert">{reauthError}</p>}<button className="primary-button" disabled={busy}>{busy ? '正在验证并处理…' : '确认并继续'}</button></form></Modal></div>;
}
