import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UserView } from './auth-types';
import type { AdminEnrollment, AdminEnrollmentResult, AdminEnrollmentStatus } from './lib/admin-s3-types';
import { api, APIError, onAuthExpired } from './lib/api';

export function AdminEnrollmentPanel({ user, onUserChange, onBusyChange }: { user: UserView; onUserChange: (user: UserView) => void; onBusyChange?: (busy: boolean) => void }) {
  return <Enrollment key={user.id} user={user} onUserChange={onUserChange} onBusyChange={onBusyChange} />;
}
function Enrollment({ user, onUserChange, onBusyChange }: { user: UserView; onUserChange: (user: UserView) => void; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = useState<AdminEnrollmentStatus | null>(null);
  const [password, setPassword] = useState(''); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0); const [unknown, setUnknown] = useState(false);
  const controller = useRef<AbortController | null>(null); const lock = useRef(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const request = new AbortController(); controller.current = request; setStatus(null); setPassword(''); setError(''); setBusy(false); lock.current = false;
    const unsubscribe = onAuthExpired(() => { request.abort(); setStatus(null); setPassword(''); setBusy(false); setError('身份已失效，请重新登录。'); });
    void api<AdminEnrollmentStatus>('/api/v1/account/admin-enrollment', { signal: request.signal }).then((data) => { if (!request.signal.aborted) setStatus(data); }).catch((cause) => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '读取邀请失败。'); });
    return () => { request.abort(); unsubscribe(); };
  }, [attempt]);
  async function accept(event: FormEvent) {
    event.preventDefault(); const request = controller.current;
    if (!request || request.signal.aborted || lock.current || unknown || !status?.invitation || status.invitation.expiresAt <= Date.now()) return;
    lock.current = true; setBusy(true); setError(''); let finishing = false;
    try {
      const { reauthToken } = await api<{ reauthToken: string }>('/api/v1/auth/reauth', { method: 'POST', body: { password, action: 'administrator.enroll' }, signal: request.signal });
      if (request.signal.aborted) return; setPassword('');
      const enrollment = await api<AdminEnrollment>('/api/v1/account/admin-enrollment/start', { method: 'POST', body: { reauthToken }, signal: request.signal });
      if (request.signal.aborted) return;
      finishing = true;
      const result = await api<AdminEnrollmentResult>('/api/v1/account/admin-enrollment/finish', { method: 'POST', body: { enrollmentId: enrollment.enrollmentId }, signal: request.signal });
      if (!request.signal.aborted) { setStatus({ invitation: null }); onUserChange(result.user); }
    } catch (cause) {
      if (!request.signal.aborted) {
        if (finishing && (!(cause instanceof APIError) || cause.status === 0 || cause.status >= 500)) setUnknown(true);
        setError(cause instanceof Error ? cause.message : '接受邀请失败，请重试。');
      }
    } finally { lock.current = false; if (!request.signal.aborted) { setBusy(false); setPassword(''); } }
  }
  if (user.siteRole === 'super_admin') return null;
  return <section className="settings-card"><h2>管理权限邀请</h2>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!status && !error && <p role="status">正在读取管理邀请…</p>}
    {status && !status.invitation && <p>当前没有待处理的管理邀请。</p>}
    {status?.invitation && !unknown && <><p>邀请者：{status.invitation.inviter.nickname}（@{status.invitation.inviter.username}）</p><p>验证当前账号密码后即可接受管理权限。邀请到期 {new Date(status.invitation.expiresAt).toLocaleString('zh-CN')}</p><form onSubmit={(event) => void accept(event)}><fieldset disabled={busy || status.invitation.expiresAt <= Date.now()}><label className="form-field">当前密码<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary-button">{busy ? '正在验证并接受…' : '验证密码并接受邀请'}</button></fieldset></form></>}
    {unknown && <p className="warning-note">接受邀请的结果尚未确认，请重新登录核对当前身份。</p>}
    {!busy && !unknown && <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>刷新管理邀请</button>}
  </section>;
}
