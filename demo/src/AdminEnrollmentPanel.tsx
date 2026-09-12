import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UserView } from './auth-types';
import type { AdminEnrollment, AdminEnrollmentResult, AdminEnrollmentStatus } from './lib/admin-s3-types';
import { api, APIError, onAuthExpired } from './lib/api';

export function AdminEnrollmentPanel({ user, onUserChange, onBusyChange }: { user: UserView; onUserChange: (user: UserView) => void; onBusyChange?: (busy: boolean) => void }) {
  return <Enrollment key={user.id} user={user} onUserChange={onUserChange} onBusyChange={onBusyChange} />;
}
function Enrollment({ user, onUserChange, onBusyChange }: { user: UserView; onUserChange: (user: UserView) => void; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = useState<AdminEnrollmentStatus | null>(null); const [enrollment, setEnrollment] = useState<AdminEnrollment | null>(null); const [result, setResult] = useState<AdminEnrollmentResult | null>(null);
  const [password, setPassword] = useState(''); const [code, setCode] = useState(''); const [saved, setSaved] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0); const [unknown, setUnknown] = useState(false);
  const controller = useRef<AbortController | null>(null); const lock = useRef(false);
  const interactionBusy = busy || !!enrollment || !!result;
  useEffect(() => { onBusyChange?.(interactionBusy); return () => onBusyChange?.(false); }, [interactionBusy, onBusyChange]);
  useEffect(() => {
    const request = new AbortController(); controller.current = request; setStatus(null); setEnrollment(null); setResult(null); setPassword(''); setCode(''); setSaved(false); setError(''); setBusy(false); lock.current = false;
    const unsubscribe = onAuthExpired(() => { request.abort(); setStatus(null); setEnrollment(null); setResult(null); setPassword(''); setCode(''); setError('身份已失效，请重新登录。'); });
    void api<AdminEnrollmentStatus>('/api/v1/account/admin-enrollment', { signal: request.signal }).then((data) => { if (!request.signal.aborted) setStatus(data); }).catch((cause) => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '读取邀请失败。'); });
    return () => { request.abort(); unsubscribe(); };
  }, [attempt]);
  useEffect(() => { if (!enrollment) return; const timer = window.setTimeout(() => { setEnrollment(null); setCode(''); setPassword(''); setError('绑定挑战已到期，请重新验证密码开始绑定。'); }, Math.max(0, enrollment.expiresAt - Date.now())); return () => window.clearTimeout(timer); }, [enrollment]);
  function fail(cause: unknown, signal: AbortSignal) { if (signal.aborted) return; setError(cause instanceof Error ? cause.message : '绑定未完成，请重试。'); if (cause instanceof APIError && (cause.status === 401 || cause.status === 403) && !['REAUTH_FAILED', 'INVALID_PASSWORD', 'INVALID_SECOND_FACTOR'].includes(cause.code)) { setEnrollment(null); setResult(null); setStatus(null); } }
  async function start(event: FormEvent) {
    event.preventDefault(); const request = controller.current; if (!request || request.signal.aborted || lock.current || result) return;
    lock.current = true; setBusy(true); setError(''); setEnrollment(null); setCode(''); setUnknown(false);
    try {
      const { reauthToken } = await api<{ reauthToken: string }>('/api/v1/auth/reauth', { method: 'POST', body: { password, action: 'administrator.enroll' }, signal: request.signal }); if (request.signal.aborted) return; setPassword('');
      const data = await api<AdminEnrollment>('/api/v1/account/admin-enrollment/start', { method: 'POST', body: { reauthToken }, signal: request.signal }); if (!request.signal.aborted && data.expiresAt > Date.now()) setEnrollment(data);
    } catch (cause) { fail(cause, request.signal); } finally { lock.current = false; if (!request.signal.aborted) { setBusy(false); setPassword(''); } }
  }
  async function finish(event: FormEvent) {
    event.preventDefault(); const request = controller.current; if (!request || request.signal.aborted || !enrollment || lock.current || result || unknown) return;
    if (enrollment.expiresAt <= Date.now()) { setEnrollment(null); setCode(''); setError('绑定挑战已到期，请重新开始。'); return; }
    lock.current = true; setBusy(true); setError('');
    try { const data = await api<AdminEnrollmentResult>('/api/v1/account/admin-enrollment/finish', { method: 'POST', body: { enrollmentId: enrollment.enrollmentId, code: code.trim() }, signal: request.signal }); if (!request.signal.aborted) { setEnrollment(null); setResult(data); setCode(''); setSaved(false); } }
    catch (cause) { if (!request.signal.aborted && (!(cause instanceof APIError) || cause.status === 0 || cause.status >= 500)) { setUnknown(true); setEnrollment(null); } fail(cause, request.signal); }
    finally { lock.current = false; if (!request.signal.aborted) { setBusy(false); setCode(''); } }
  }
  if (user.siteRole === 'super_admin' && !result) return null;
  return <section className="settings-card"><h2>管理权限邀请与绑定</h2>{error && <p role="alert" className="form-error">{error}</p>}{!status && !error && <p role="status">正在读取管理邀请…</p>}{status && !status.invitation && !result && <p>当前没有待处理的管理邀请。</p>}
    {result ? <div className="recovery-panel"><h3>保存独立第二因素恢复码</h3><p>服务器已验证 TOTP 并完成绑定。以下 8 组恢复码仅展示一次，用于第二因素，与你的账号密码恢复码相互独立。</p><p>当前已验证会话保留，其他设备授权已撤销。离开或刷新页面后无法再次读取这些恢复码。</p><ul className="recovery-code-grid">{result.recoveryCodes.map((item) => <li key={item}><code>{item}</code></li>)}</ul><label className="checkbox-row"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />我已安全保存全部第二因素恢复码</label><button className="primary-button" disabled={!saved} onClick={() => { const updated = result.user; setResult(null); setSaved(false); setStatus({ invitation: null }); onUserChange(updated); }}>已保存，更新管理身份</button></div> : <>
      {status?.invitation && <><p>邀请者：{status.invitation.inviter.nickname}（@{status.invitation.inviter.username}）</p><p>{status.invitation.purpose === 'factor_reset' ? '重新绑定第二因素' : '授予站点管理权限'} · 邀请到期 {new Date(status.invitation.expiresAt).toLocaleString('zh-CN')}</p>
      {!enrollment && !unknown && <form onSubmit={(event) => void start(event)}><fieldset disabled={busy || status.invitation.expiresAt <= Date.now()}><label className="form-field">绑定验证密码<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-button">{busy ? '正在验证…' : '验证密码并开始绑定'}</button></fieldset></form>}
      {enrollment && <div className="admin-enrollment-secret"><p>在你的验证器中手动添加下列密钥或 URI。秘密只保留在当前页面内存。</p><p>绑定密钥：<code>{enrollment.secret}</code></p><p>验证器 URI：<code>{enrollment.uri}</code></p><p>挑战有效期至 {new Date(enrollment.expiresAt).toLocaleString('zh-CN')}</p><form onSubmit={(event) => void finish(event)}><fieldset disabled={busy}><label className="form-field">验证器当前动态码<input required inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value)} /></label><button className="primary-button">验证动态码并完成绑定</button></fieldset></form><button className="text-button" disabled={busy} onClick={() => { setEnrollment(null); setCode(''); }}>隐藏秘密并重新开始</button></div>}</>}
      {unknown && <p className="warning-note">完成请求的结果尚未确认，恢复码不能重复领取。请重新登录核对当前身份；不要重复提交旧挑战。</p>}
      {!busy && !enrollment && !unknown && <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>刷新管理邀请</button>}
    </>}
  </section>;
}
