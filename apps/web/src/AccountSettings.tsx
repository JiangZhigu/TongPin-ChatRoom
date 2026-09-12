import { AdminEnrollmentPanel } from './AdminEnrollmentPanel';
import { AccountDeletion } from './AccountDeletion';
import { browserNotificationStatus, enableBrowserNotifications, disableBrowserNotifications } from './lib/browser-notifications';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, APIError } from './lib/api';
import type { UserView } from './auth-types';
import { FormField } from './components/FormField';
import { Modal } from './components/Modal';
import { RecoveryCodesPanel } from './components/RecoveryCodesPanel';
import './styles-account-dialog.css';

type SettingsSection = 'privacy' | 'notifications' | 'restrictions' | 'enrollment' | 'sessions' | 'password' | 'recovery' | 'events' | 'reports' | 'deletion';

interface SessionView { id: string; device: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }
interface SecurityEventView { id: string; action: string; createdAt: number; device: string; result: string }
type SensitiveAction = { kind: 'revoke'; session: SessionView } | { kind: 'password'; password: string } | { kind: 'codes' };
const formatTime = (time: number) => new Date(time).toLocaleString('zh-CN');
const messageOf = (cause: unknown) => {
  if (cause instanceof APIError) return [cause.message, ...Object.values(cause.fieldErrors || {}), cause.retryAfterMs ? `请在 ${Math.ceil(cause.retryAfterMs / 1000)} 秒后重试。` : ''].filter(Boolean).join(' ');
  return cause instanceof Error ? cause.message : '操作失败，请重试。';
};

export function AccountSettings({ user, onUserChange, onSignedOut, onLogout, onOpenReports, onDeleted, onBeforeDelete, onDeleteFailed, onPreserveAndSignOut, onGetLocalSummary, embedded = false, onBusyChange }: { embedded?: boolean; onBusyChange?: (busy: boolean) => void; user: UserView; onUserChange: (user: UserView) => void; onSignedOut: () => void; onLogout?: () => Promise<void>; onOpenReports?: () => void; onDeleted?: (choice: 'keep' | 'delete') => Promise<void>; onBeforeDelete?: () => Promise<void>; onDeleteFailed?: () => void; onPreserveAndSignOut?: () => Promise<void>; onGetLocalSummary?: () => Promise<{ pending: number; drafts: number; taskDrafts: number }> }) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('privacy');
  const [enrollmentBusy, setEnrollmentBusy] = useState(false);
  const navigationId = useId();
  const [deletionOpen, setDeletionOpen] = useState(false); const [notificationStatus, setNotificationStatus] = useState(() => browserNotificationStatus(user.id)); const [notificationBusy, setNotificationBusy] = useState(false);
  useEffect(() => setNotificationStatus(browserNotificationStatus(user.id)), [user.id]);
  const logoutButton = useRef<HTMLButtonElement>(null);
  const cancelledLogoutUser = useRef<string | null>(null);
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => {
    if (busy) return;
    const cancelledUser = cancelledLogoutUser.current;
    cancelledLogoutUser.current = null;
    const trigger = logoutButton.current;
    const active = document.activeElement;
    // Restore only after React has re-enabled the trigger; no delayed task can cross identities.
    if (cancelledUser === user.id && trigger?.isConnected && !trigger.disabled && !Array.from(document.querySelectorAll('dialog[open]')).some((dialog) => !dialog.contains(trigger))
      && (active === document.body || active === trigger || active === trigger.closest('dialog[open]') || (active instanceof HTMLElement && active.closest('dialog:not([open])')))) trigger.focus();
  }, [busy, user.id]);
  const [sessions, setSessions] = useState<SessionView[] | null>(null); const [sessionsError, setSessionsError] = useState('');
  const [events, setEvents] = useState<SecurityEventView[] | null>(null); const [eventsError, setEventsError] = useState('');
  const [reload, setReload] = useState(0); const [pending, setPending] = useState<SensitiveAction | null>(null);
  const currentIdentity = useRef(user.id); currentIdentity.current = user.id;
  const [verifiedRestrictions, setVerifiedRestrictions] = useState<{ userId: string; value: UserView['restrictions'] } | null>(null);
  const [accountCheck, setAccountCheck] = useState<{ userId: string; pending: boolean; error: string }>({ userId: user.id, pending: true, error: '' });
  const restrictions = verifiedRestrictions?.userId === user.id ? verifiedRestrictions.value : user.restrictions;
  useEffect(() => {
    const userId = user.id; let active = true; let revision = 0; let controller: AbortController | null = null;
    function verifyAccount() {
      controller?.abort(); const request = new AbortController(); controller = request; const requestRevision = ++revision;
      const current = () => active && !request.signal.aborted && requestRevision === revision && currentIdentity.current === userId;
      setAccountCheck({ userId, pending: true, error: '' });
      void api<{ user: UserView }>('/api/v1/auth/me', { signal: request.signal }).then((data) => {
        if (!current()) return;
        if (!data.user || data.user.id !== userId) throw new Error('返回账号与当前账号不一致，请重新核对。');
        // Refresh only server restrictions; profile edits are handled in the separate profile dialog.
        setVerifiedRestrictions({ userId, value: data.user.restrictions });
        setAccountCheck({ userId, pending: false, error: '' });
      }).catch((cause) => { if (current()) setAccountCheck({ userId, pending: false, error: messageOf(cause) }); });
    }
    function accountChanged(event: Event) { if (event instanceof CustomEvent && event.detail?.userId === userId) verifyAccount(); }
    window.addEventListener('tongpin:account-changed', accountChanged); verifyAccount();
    return () => { active = false; revision++; controller?.abort(); window.removeEventListener('tongpin:account-changed', accountChanged); };
  }, [user.id, reload]);
  const [reauthPassword, setReauthPassword] = useState(''); const [factor, setFactor] = useState('');
  const [reauthError, setReauthError] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setSessions(null); setEvents(null); setSessionsError(''); setEventsError('');
    void api<{ items: SessionView[] }>('/api/v1/account/sessions', { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setSessions(data.items); }).catch((cause) => { if (!controller.signal.aborted) setSessionsError(messageOf(cause)); });
    void api<{ items: SecurityEventView[] }>('/api/v1/account/security-events', { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setEvents(data.items); }).catch((cause) => { if (!controller.signal.aborted) setEventsError(messageOf(cause)); });
    return () => controller.abort();
  }, [reload, user.id]);
  function captureError(cause: unknown) { setError(messageOf(cause)); }
  async function changePreference(key: keyof UserView['preferences'], value: boolean) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { const data = await api<{ user: UserView }>('/api/v1/account/preferences', { method: 'PATCH', body: { [key]: value } }); onUserChange(data.user); setNotice('偏好设置已保存。'); }
    catch (cause) { captureError(cause); } finally { setBusy(false); }
  }
  async function logout() {
    if (busy) return; setBusy(true); setError('');
    try { if (onLogout) await onLogout(); else await api('/api/v1/auth/logout', { method: 'POST', body: {} }); onSignedOut(); }
    catch (cause) { if (cause instanceof Error && cause.name === 'LogoutCancelled') cancelledLogoutUser.current = user.id; else captureError(cause); } finally { setBusy(false); }
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
  const interactionBusy = busy || notificationBusy || enrollmentBusy || deletionOpen || !!pending || !!codes;
  useEffect(() => { onBusyChange?.(interactionBusy); return () => onBusyChange?.(false); }, [interactionBusy, onBusyChange]);
  const recoveryDialog = codes ? <Modal open title="新恢复码已生成" dismissible={false} onClose={() => undefined}><RecoveryCodesPanel codes={codes} onConfirm={() => { setCodes(null); setNotice('新恢复码已生成，旧恢复码已全部失效。'); }} /></Modal> : null;

  const panels: Record<SettingsSection, ReactNode> = {
    restrictions: <section className="settings-card"><h2>账号使用限制</h2><p>以下限制由站点管理设置，实际操作以服务器校验为准。</p>{(accountCheck.userId !== user.id || accountCheck.pending) && <p role="status">正在核对当前账号限制…</p>}{accountCheck.userId === user.id && accountCheck.error && <div role="alert" className="form-error"><p>当前账号限制核对失败：{accountCheck.error}</p><p>下方如有信息，仅代表上次已知状态。</p><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>重新核对账号限制</button></div>}{restrictions && <><ul><li>上传：{restrictions.uploadDisabled ? '已限制' : '未限制'}</li><li>创建群聊：{restrictions.groupCreationDisabled ? '已限制' : '未限制'}</li></ul><p>限制理由：{restrictions.reason || '无'}</p><p>全站禁言：{restrictions.mutedUntil === null ? '未禁言' : `至 ${formatTime(restrictions.mutedUntil)}`}</p><p>禁言理由：{restrictions.muteReason || '无'}</p></>}{!restrictions && accountCheck.userId === user.id && !accountCheck.pending && !accountCheck.error && <p>当前账号没有额外限制信息。</p>}</section>,
    privacy: <section className="settings-card"><h2>隐私与通知偏好</h2><p className="field-hint">偏好保存到账号，用于聊天中的在线状态、阅读回执和消息提醒。</p>{([{ key: 'invisible', label: '隐身状态', help: '不向其他用户展示在线状态。' }, { key: 'readReceipts', label: '阅读回执', help: '允许向私聊对方展示真实阅读进度。' }, { key: 'doNotDisturb', label: '消息免打扰', help: '减少消息提醒。' }] as const).map(({ key, label, help }) => <label className="preference-row" key={key}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={user.preferences[key]} disabled={busy} onChange={(e) => void changePreference(key, e.target.checked)} /></label>)}</section>,
    notifications: <section className="settings-card"><h2>浏览器通知</h2><p className="field-hint">只在你点击开启时请求浏览器权限。系统通知不显示消息正文；关闭页面后不保证提醒。账号免打扰仍优先。</p><p role="status">{!notificationStatus.supported ? '当前浏览器不支持系统通知，站内通知仍可用。' : notificationStatus.permission === 'denied' ? '浏览器已拒绝通知权限，请在浏览器网站设置中调整。站内通知不受影响。' : notificationStatus.enabled ? '本账号已开启浏览器通知。' : '本账号尚未开启浏览器通知。'}</p><button className="secondary-button" disabled={notificationBusy || !notificationStatus.supported || notificationStatus.permission === 'denied'} onClick={() => { if (notificationStatus.enabled) { disableBrowserNotifications(user.id); setNotificationStatus(browserNotificationStatus(user.id)); } else { setNotificationBusy(true); void enableBrowserNotifications(user.id).then(setNotificationStatus).catch((cause) => captureError(cause)).finally(() => setNotificationBusy(false)); } }}>{notificationBusy ? '等待浏览器授权…' : notificationStatus.enabled ? '关闭浏览器通知' : '开启浏览器通知'}</button></section>,
    reports: onOpenReports && <section className="settings-card"><h2>举报与反馈</h2><p>查看你提交的举报和管理员处理反馈。</p><button className="secondary-button" onClick={onOpenReports}>我的举报</button></section>,
    deletion: onDeleted && <section className="settings-card"><h2>注销账号</h2><p>先查看实际影响和保留期限，再决定是否验证身份并注销。</p><button className="secondary-button danger-text" disabled={busy} onClick={() => setDeletionOpen(true)}>查看注销影响</button></section>,
    sessions: <section className="settings-card"><div className="card-heading"><h2>登录设备</h2><button className="icon-button" aria-label="刷新设备和安全记录" disabled={busy} onClick={() => setReload((value) => value + 1)}><RefreshCw size={18} /></button></div><p className="field-hint">撤销设备需要再次验证身份，该设备将需要重新登录。</p>{sessionsError ? <p className="form-error" role="alert">{sessionsError}</p> : sessions === null ? <p role="status">正在加载设备…</p> : sessions.length === 0 ? <p className="field-hint">暂无可显示的登录设备。</p> : <ul className="security-list">{sessions.map((session) => <li key={session.id}><div><strong>{session.device || '未知设备'}</strong>{session.current && <span className="current-device">当前设备</span>}<small>登录：{formatTime(session.createdAt)}</small><small>最近活动：{formatTime(session.lastSeenAt)}</small></div><button className="text-button danger-text" disabled={busy} onClick={() => begin({ kind: 'revoke', session })}>撤销{session.current ? '当前会话' : '会话'}</button></li>)}</ul>}</section>,
    password: <section className="settings-card"><h2>修改密码</h2><p className="warning-note">修改后所有设备都会退出登录，包括当前设备。</p><form onSubmit={(event) => { event.preventDefault(); if (password !== confirmation) { setError('两次输入的新密码不一致。'); return; } begin({ kind: 'password', password }); }}><fieldset disabled={busy}><FormField label="新密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required hint="8–128 个字符，支持空格与中文。" /><FormField label="确认新密码" type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required /><button className="secondary-button">验证身份并修改密码</button></fieldset></form></section>,
    recovery: <section className="settings-card"><h2>账号恢复码</h2><p>重新生成后，原来保存的全部账号恢复码立即失效。新恢复码只显示一次。</p><button className="secondary-button" disabled={busy} onClick={() => begin({ kind: 'codes' })}><ShieldCheck size={17} />验证身份并重新生成</button></section>,
    events: <section className="settings-card"><h2>近期安全记录</h2>{eventsError ? <p className="form-error" role="alert">{eventsError}</p> : events === null ? <p role="status">正在加载记录…</p> : events.length === 0 ? <p className="field-hint">暂无可显示的安全记录。</p> : <ul className="security-list">{events.map((item) => <li key={item.id}><div><strong>{item.action}</strong><small>{item.device || '未知设备'} · {formatTime(item.createdAt)}</small></div><span>{item.result}</span></li>)}</ul>}</section>,
    enrollment: <AdminEnrollmentPanel user={user} onUserChange={onUserChange} onBusyChange={setEnrollmentBusy} />,
  };
  const groups: { label: string; items: { id: SettingsSection; label: string }[] }[] = [
    { label: '使用偏好', items: [{ id: 'privacy', label: '隐私与通知偏好' }, { id: 'notifications', label: '浏览器通知' }] },
    { label: '账号与权限', items: [{ id: 'restrictions', label: '账号使用限制' }, ...(user.siteRole !== 'super_admin' || enrollmentBusy ? [{ id: 'enrollment' as const, label: '管理权限邀请与绑定' }] : [])] },
    { label: '安全', items: [{ id: 'sessions', label: '登录设备' }, { id: 'password', label: '修改密码' }, { id: 'recovery', label: '账号恢复码' }, { id: 'events', label: '近期安全记录' }] },
    { label: '帮助与账号', items: [...(onOpenReports ? [{ id: 'reports' as const, label: '举报与反馈' }] : []), ...(onDeleted ? [{ id: 'deletion' as const, label: '注销账号' }] : [])] },
  ];
  const availableGroups = groups.filter((group) => group.items.length > 0);
  const items = availableGroups.flatMap((group) => group.items);
  const selected = items.some((item) => item.id === activeSection) ? activeSection : 'privacy';
  function navigateSettings(event: KeyboardEvent<HTMLElement>) {
    if (interactionBusy || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const index = items.findIndex((item) => item.id === selected);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    const next = items[nextIndex].id;
    event.preventDefault(); setActiveSection(next);
    document.getElementById(`${navigationId}-tab-${next}`)?.focus();
  }
  return <div className="account-settings account-settings-workspace">
<header className="settings-heading">{!embedded && <div><h1>账号设置</h1><p>管理你的使用偏好与账号安全。</p></div>}<button ref={logoutButton} className="secondary-button" onClick={() => void logout()} disabled={interactionBusy}><LogOut size={16} />退出登录</button></header>
    <div className="settings-navigation-layout">
      <aside className="settings-navigation">
        <label className="settings-mobile-picker" htmlFor={`${navigationId}-select`}>设置分类<select id={`${navigationId}-select`} value={selected} disabled={interactionBusy} onChange={(event) => setActiveSection(event.target.value as SettingsSection)}>{availableGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select></label>
        <div role="tablist" aria-label="设置分类" aria-orientation="vertical" className="settings-tablist" onKeyDown={navigateSettings}>
          {availableGroups.map((group, index) => <div className="settings-nav-group" key={group.label} role="group" aria-labelledby={`${navigationId}-group-${index}`}><h2 id={`${navigationId}-group-${index}`}>{group.label}</h2>{group.items.map((item) => <button key={item.id} type="button" role="tab" id={`${navigationId}-tab-${item.id}`} aria-controls={`${navigationId}-panel-${item.id}`} aria-selected={selected === item.id} tabIndex={selected === item.id ? 0 : -1} disabled={interactionBusy} onClick={() => { if (!interactionBusy) setActiveSection(item.id); }}>{item.label}</button>)}</div>)}
        </div>
      </aside>
      <div className="settings-active-content">
        {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status" className="success-note">{notice}</p>}
        {(Object.keys(panels) as SettingsSection[]).map((id) => <section key={id} className="settings-content-panel" role="tabpanel" id={`${navigationId}-panel-${id}`} aria-labelledby={`${navigationId}-tab-${id}`} hidden={selected !== id} inert={selected !== id} tabIndex={0}>{panels[id]}</section>)}
      </div>
    </div>
    {deletionOpen && onDeleted && <AccountDeletion onGetLocalSummary={onGetLocalSummary} user={user} onClose={() => setDeletionOpen(false)} onDeleted={onDeleted} onBeforeDelete={onBeforeDelete} onDeleteFailed={onDeleteFailed} onPreserveAndSignOut={onPreserveAndSignOut} />}
    <Modal open={!!pending} title="再次验证身份" dismissible={!busy} onClose={() => { if (!busy) { setPending(null); setReauthPassword(''); setFactor(''); } }}><p>{pending?.kind === 'password' ? '确认修改密码后，全部设备会话将被注销。' : pending?.kind === 'revoke' ? `即将撤销「${pending.session.device || '未知设备'}」的会话。` : '确认后将生成新恢复码，旧恢复码立即失效。'}</p><form onSubmit={(event) => void confirmAction(event)}><fieldset disabled={busy}><FormField label="当前密码" type="password" value={reauthPassword} onChange={(e) => setReauthPassword(e.target.value)} autoComplete="current-password" required /><FormField label="动态码或第二因素恢复码（管理员必填）" value={factor} onChange={(e) => setFactor(e.target.value)} autoComplete="off" /></fieldset>{reauthError && <p className="form-error" role="alert">{reauthError}</p>}<button className="primary-button" disabled={busy}>{busy ? '正在验证并处理…' : '确认并继续'}</button></form></Modal>
    {recoveryDialog}
  </div>;
}
