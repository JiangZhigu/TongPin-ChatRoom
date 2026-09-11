import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, APIError } from './lib/api';
import type { AuthResult, BootstrapView } from './auth-types';
import { Brand } from './components/Brand';
import { FormField } from './components/FormField';
import { RecoveryCodesPanel } from './components/RecoveryCodesPanel';

interface Captcha { captchaId: string; image: string; expiresAt: number }
type Mode = 'login' | 'register' | 'recover';

export function AuthPage({ bootstrap, admin, onAuthenticated }: { bootstrap: BootstrapView; admin: boolean; onAuthenticated: (result: AuthResult) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState(''); const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [answer, setAnswer] = useState(''); const [secondFactor, setSecondFactor] = useState('');
  const [showFactor, setShowFactor] = useState(admin); const [recoveryCode, setRecoveryCode] = useState('');
  const [siteInvite, setSiteInvite] = useState(''); const [acceptTerms, setAcceptTerms] = useState(false);
  const [remember, setRemember] = useState(false); const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<Captcha | null>(null); const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaError, setCaptchaError] = useState(''); const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({}); const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<AuthResult | null>(null); const [retryAt, setRetryAt] = useState(0); const [now, setNow] = useState(Date.now());
  const captchaRequest = useRef(0);
  const reloadCaptcha = useCallback(async () => {
    const request = ++captchaRequest.current;
    setCaptchaLoading(true); setCaptchaError(''); setAnswer(''); setCaptcha(null);
    try { const result = await api<Captcha>('/api/v1/auth/captcha'); if (request === captchaRequest.current) setCaptcha(result); }
    catch (cause) { if (request === captchaRequest.current) setCaptchaError(cause instanceof Error ? cause.message : '验证码加载失败'); }
    finally { if (request === captchaRequest.current) setCaptchaLoading(false); }
  }, []);
  useEffect(() => { void reloadCaptcha(); return () => { captchaRequest.current++; }; }, [reloadCaptcha, mode]);
  useEffect(() => { if (!captcha || pending || busy) return; const timer = window.setTimeout(() => { setNotice('验证码已过期，已为你刷新。'); void reloadCaptcha(); }, Math.max(0, captcha.expiresAt - Date.now())); return () => window.clearTimeout(timer); }, [captcha, pending, busy, reloadCaptcha]);
  useEffect(() => { if (!retryAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [retryAt]);
  function switchMode(next: Mode) { setMode(next); setPassword(''); setConfirmation(''); setAnswer(''); setSecondFactor(''); setRecoveryCode(''); setError(''); setNotice(''); setFieldErrors({}); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !captcha || captchaLoading || retryAt > Date.now() || (mode === 'register' && (!acceptTerms || bootstrap.registrationMode === 'closed'))) return;
    setError(''); setFieldErrors({}); setNotice('');
    if (mode !== 'login' && password !== confirmation) { setFieldErrors({ confirmation: '两次输入的密码不一致。' }); return; }
    setBusy(true);
    try {
      const common = { username, password, captchaId: captcha.captchaId, captchaAnswer: answer };
      if (mode === 'recover') {
        await api('/api/v1/auth/recover', { method: 'POST', body: { ...common, recoveryCode, ...(secondFactor ? { secondFactor } : {}) } });
        switchMode('login'); setNotice('密码已重置，旧会话已注销。请使用新密码登录。');
      } else {
        const body = mode === 'register' ? { ...common, nickname, termsVersion: bootstrap.terms.version, acceptTerms: true, ...(bootstrap.registrationMode === 'invite-only' ? { siteInvite } : {}) } : { ...common, remember, ...(secondFactor ? { secondFactor } : {}), ...(admin ? { admin: true } : {}) };
        const result = await api<AuthResult>(`/api/v1/auth/${mode}`, { method: 'POST', body });
        setPassword(''); setSecondFactor(''); setConfirmation(''); setAnswer('');
        if (result.recoveryCodes?.length) setPending(result); else onAuthenticated(result);
      }
    } catch (cause) {
      if (cause instanceof APIError) { setError(cause.message); setFieldErrors(cause.fieldErrors || {}); if (cause.code === 'SECOND_FACTOR_REQUIRED') setShowFactor(true); if (cause.retryAfterMs) setRetryAt(Date.now() + cause.retryAfterMs); }
      else setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
      void reloadCaptcha();
    } finally { setBusy(false); }
  }
  const registrationClosed = mode === 'register' && bootstrap.registrationMode === 'closed';
  const title = mode === 'login' ? admin ? '登录管理后台' : '欢迎回来' : mode === 'register' ? '创建你的账号' : '找回你的账号';
  return <main className="welcome-page auth-page"><section className="welcome-story"><Brand /><div className="story-content"><p className="eyebrow">STAY CLOSE. STAY IN SYNC.</p><h1>好的对话，<br />从<span>同频</span>开始。</h1><p className="story-description">和朋友聊聊近况，和同伴分享灵感。<br />让每一条消息，都有它的去处。</p><div className="conversation-art" aria-hidden="true"><div className="art-row"><span className="art-avatar" /><span className="art-bubble"><i /><i /></span></div><div className="art-row own"><span className="art-avatar" /><span className="art-bubble"><i /><i /></span></div></div></div><p className="story-footer">好友私聊<span>群聊协作</span><span>文件分享</span></p></section><section className="welcome-panel"><div className="welcome-top"><a href={admin ? '/' : '/admin'}>{admin ? '返回同频' : '管理入口'}<ArrowRight size={14} /></a></div><div className="auth-content">{pending?.recoveryCodes ? <RecoveryCodesPanel codes={pending.recoveryCodes} onConfirm={() => { const result = pending; setPending(null); onAuthenticated(result); }} /> : <><h2>{title}</h2><p className="auth-subtitle">{admin ? '使用管理账号及动态码或第二因素恢复码登录。' : mode === 'recover' ? '使用已保存的账号恢复码，设置新的密码。' : '给自己一点空间，开始一段新的对话。'}</p>{!admin && <div className="auth-tabs" aria-label="账号操作"><button disabled={busy} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>登录</button><button disabled={busy} className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>注册</button></div>}{registrationClosed ? <div className="service-card"><div><h3>暂未开放注册</h3><p>你仍可以登录已有账号，或使用恢复码找回密码。</p><button className="text-button" onClick={() => switchMode('login')}>返回登录</button></div></div> : <form onSubmit={(event) => void submit(event)} aria-busy={busy}><fieldset disabled={busy}><FormField label="用户名" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required error={fieldErrors.username} hint={mode === 'register' ? '字母开头，4–24 位字母、数字或下划线。' : undefined} />{mode === 'register' && <><FormField label="昵称" value={nickname} onChange={(e) => setNickname(e.target.value)} required error={fieldErrors.nickname} />{bootstrap.registrationMode === 'invite-only' && <FormField label="站点邀请码" value={siteInvite} onChange={(e) => setSiteInvite(e.target.value)} required error={fieldErrors.siteInvite} hint="需要站点邀请码，群聊邀请不能用于注册。" />}</>}<FormField label={mode === 'recover' ? '新密码' : '密码'} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} error={fieldErrors.password} hint={mode === 'login' ? undefined : '15–128 个字符，支持空格与中文，不会自动去除空格。'} />{mode !== 'login' && <FormField label="确认密码" type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required error={fieldErrors.confirmation} />}{mode === 'recover' && <FormField label="账号恢复码" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} autoComplete="off" required error={fieldErrors.recoveryCode} hint="本次使用的恢复码会失效，旧登录会话将全部注销。" />}{mode !== 'register' && <><button className="text-button factor-toggle" type="button" aria-expanded={showFactor} onClick={() => setShowFactor(!showFactor)}>{showFactor ? '收起第二因素输入' : '管理员动态码 / 第二因素恢复码'}</button>{showFactor && <FormField label="动态码或第二因素恢复码" value={secondFactor} onChange={(e) => setSecondFactor(e.target.value)} autoComplete="off" error={fieldErrors.secondFactor} hint="输入管理账号的 TOTP 动态码或独立第二因素恢复码。" />}</>}<div className="captcha-row"><FormField label="图形验证码" value={answer} onChange={(e) => setAnswer(e.target.value)} required autoComplete="off" error={fieldErrors.captchaAnswer || fieldErrors.captchaId} /><button type="button" className="captcha-image" onClick={() => void reloadCaptcha()} disabled={captchaLoading} aria-label="刷新图形验证码">{captcha ? <img src={captcha.image} alt="图形验证码，请输入图片中的字符" /> : <span>{captchaLoading ? '加载中…' : '重新加载'}</span>}<RefreshCw size={16} /></button></div>{captchaError && <p className="field-error" role="alert">{captchaError}</p>}{mode === 'register' && <><details className="terms"><summary>阅读服务条款与隐私说明</summary><p className="terms-meta">版本 {bootstrap.terms.version} · {bootstrap.terms.operatorName}<br />联系：{bootstrap.terms.operatorContact}</p>{bootstrap.terms.development && <p className="warning-note">当前为开发环境条款，请确认运营信息。</p>}<div className="terms-text">{bootstrap.terms.text}</div></details><label className="checkbox-row"><input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} required />我已阅读并同意上述服务条款与隐私说明</label>{fieldErrors.termsVersion && <p className="field-error">{fieldErrors.termsVersion}</p>}</>}{mode === 'login' && <label className="checkbox-row"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />在这台设备保持登录</label>}</fieldset>{error && <p role="alert" className="form-error">{error}</p>}{retryAt > now && <p role="status" className="warning-note">操作频繁，请在 {Math.ceil((retryAt - now) / 1000)} 秒后重试。</p>}{notice && <p role="status" className="success-note">{notice}</p>}<button className="primary-button auth-submit" disabled={busy || !captcha || captchaLoading || retryAt > now || (mode === 'register' && !acceptTerms)}>{busy ? '正在提交…' : mode === 'login' ? '登录' : mode === 'register' ? '创建账号' : '重置密码'}<ArrowRight size={16} /></button></form>}<button className="text-button recovery-link" disabled={busy} onClick={() => switchMode(mode === 'recover' ? 'login' : 'recover')}>{mode === 'recover' ? '返回登录' : '忘记密码？使用恢复码找回'}</button></>}</div><footer className="welcome-footer"><ShieldCheck size={15} />凭据仅用于当前请求，不写入浏览器本地存储。</footer></section></main>;
}
