import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleDashed, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { Brand } from './components/Brand';
import { Modal } from './components/Modal';
import { api, fetchBootstrap, onAuthExpired } from './lib/api';
import type { AuthResult, BootstrapView, UserView } from './auth-types';
import { AuthPage } from './AuthPage';
import { ChatWorkspace } from './ChatWorkspace';
import { OfflineRecoveryPage } from './OfflineRecoveryPage';
import { GroupInviteEntry } from './GroupInviteEntry';
import { dismissInvitation, readInvitation } from './lib/invitation';
import { EmptyState } from './components/EmptyState';
import { AdminShell } from './admin/AdminShell';

const DevelopmentPreview = import.meta.env.DEV ? lazy(() => import('./DevelopmentPreview')) : null;
type ServiceState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; version: string; accountsEnabled: boolean };

function useServiceReadiness() {
  const [state, setState] = useState<ServiceState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setState({ kind: 'loading' });
    async function check() {
      try {
        const responses = await Promise.all(['/health/ready', '/api/v1/auth/bootstrap'].map((url) => fetch(url, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })));
        if (responses.some((response) => !response.ok)) throw new Error('Service unavailable');
        const [health, bootstrap] = await Promise.all(responses.map((response) => response.json()));
        if (health?.data?.status !== 'ready' || typeof health.data.version !== 'string' || typeof health.data.features?.accounts !== 'boolean' || typeof bootstrap?.data?.accountsEnabled !== 'boolean' || typeof bootstrap.data.registrationMode !== 'string') throw new Error('Invalid service response');
        if (active) setState({ kind: 'ready', version: health.data.version, accountsEnabled: health.data.features.accounts && bootstrap.data.accountsEnabled });
      } catch {
        if (active) setState({ kind: 'error' });
      } finally { window.clearTimeout(timeout); }
    }
    void check();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);
  return { state, retry: () => setAttempt((value) => value + 1) };
}

function WelcomePage() {
  const { state, retry } = useServiceReadiness();
  const [aboutOpen, setAboutOpen] = useState(false);
  return <main className="welcome-page"><section className="welcome-story" aria-label="认识同频"><Brand /><div className="story-content"><p className="eyebrow">STAY CLOSE. STAY IN SYNC.</p><h1>好的对话，<br />从<span>同频</span>开始。</h1><p className="story-description">和朋友聊聊近况，和同伴分享灵感。<br />让每一条消息，都有它的去处。</p><div className="conversation-art" aria-hidden="true"><div className="art-row"><span className="art-avatar" /><span className="art-bubble"><i /><i /></span></div><div className="art-row own"><span className="art-avatar" /><span className="art-bubble"><i /><i /></span></div><div className="art-row"><span className="art-avatar mint" /><span className="art-bubble"><i /></span></div></div></div><p className="story-footer">好友私聊<span>群聊协作</span><span>文件分享</span></p></section><section className="welcome-panel" aria-labelledby="welcome-title"><div className="welcome-top"><button className="text-button" onClick={() => setAboutOpen(true)}>关于同频</button></div><div className="welcome-content"><span className="small-label">欢迎来到同频</span><h2 id="welcome-title">留一点空间，<br />给下一段对话。</h2><p className="intro-copy">一个简单、好用的聊天空间。<br />连接朋友，也连接新的想法。</p><div className={`service-card ${state.kind}`} role="status" aria-live="polite" aria-busy={state.kind === 'loading'}><span className="service-icon" aria-hidden="true">{state.kind === 'loading' ? <CircleDashed className="spin" size={21} /> : state.kind === 'error' ? <WifiOff size={21} /> : <Check size={21} />}</span><div><h3>{state.kind === 'loading' ? '正在连接服务' : state.kind === 'error' ? '暂时无法连接服务' : '基础服务已连接'}</h3><p>{state.kind === 'loading' ? '正在确认服务与账号功能的可用状态。' : state.kind === 'error' ? '请确认服务已启动或网络可用，然后重试。' : state.accountsEnabled ? '账号服务已开放，登录界面正在准备中。' : '账号功能尚未启用，暂时无法登录或注册。'}</p>{state.kind === 'ready' && <span className="service-version">服务版本 {state.version}</span>}</div></div><button className="primary-button connect-button" onClick={retry} disabled={state.kind === 'loading'}><RefreshCw size={17} />{state.kind === 'loading' ? '连接中…' : state.kind === 'error' ? '重新连接' : '刷新服务状态'}</button><p className="availability-note">登录与注册开放后，即可开始使用。</p></div><footer className="welcome-footer"><ShieldCheck size={15} aria-hidden="true" /><span>账号功能未就绪时，不收集登录凭据。</span><a href="/admin">管理入口<ArrowRight size={14} /></a></footer></section><Modal open={aboutOpen} title="关于同频" onClose={() => setAboutOpen(false)}><Brand /><p>同频是一个为日常对话准备的聊天空间，支持的功能将随服务逐步开放。</p><p>此页面展示当前服务的真实连接状态。账号功能尚未就绪时，无法登录、注册或发送消息。</p><button className="primary-button" onClick={() => setAboutOpen(false)}>知道了</button></Modal></main>;
}

function AdminEntry({ onSignedOut }: { onSignedOut: () => void }) {
  const [verifiedUser, setVerifiedUser] = useState<UserView | null>(null);
  const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0); const [busy, setBusy] = useState(false);
  useEffect(() => { const controller = new AbortController(); setError(''); setVerifiedUser(null); void api<{ user: UserView }>('/api/v1/admin/auth', { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setVerifiedUser(data.user); }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '管理身份验证失败'); }); return () => controller.abort(); }, [attempt]);
  async function signOut() { setBusy(true); try { await api('/api/v1/auth/logout', { method: 'POST', body: {} }); onSignedOut(); } catch (cause) { setError(cause instanceof Error ? cause.message : '退出失败'); } finally { setBusy(false); } }
  if (verifiedUser) return <AdminShell key={verifiedUser.id} user={verifiedUser} onSignOut={() => void signOut()} signOutBusy={busy} signOutError={error} />;
  return <div className="admin-page"><header><a href="/" aria-label="同频首页"><Brand /></a><span className="admin-tag">管理后台</span></header><main><span className="empty-symbol"><ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" /></span><p className="eyebrow">同频管理</p><h1>{error ? '无法进入管理后台' : '正在验证管理身份'}</h1>{error && <p role="alert" className="form-error">{error}</p>}<div className="admin-actions"><a className="primary-button" href="/">返回同频<ArrowRight size={16} /></a>{error && <button className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>重新验证</button>}<button className="text-button" disabled={busy} onClick={() => void signOut()}>{busy ? '正在退出…' : '退出当前账号'}</button></div></main></div>;
}

export function App() {
  const pathname = window.location.pathname;
  if (DevelopmentPreview && pathname === '/__dev/preview') return <Suspense fallback={<p className="preview-loading">正在加载开发预览…</p>}><DevelopmentPreview /></Suspense>;
  return <AccountApplication admin={pathname === '/admin' || pathname.startsWith('/admin/')} />;
}

function AccountApplication({ admin }: { admin: boolean }) {
  const [bootstrap, setBootstrap] = useState<BootstrapView | null>(null); const [error, setError] = useState('');
  const [showLocalContent, setShowLocalContent] = useState(false);
  const [invitationToken, setInvitationToken] = useState(readInvitation); const [invitationOpen, setInvitationOpen] = useState(true);
  function closeInvitation() { dismissInvitation(); setInvitationToken(null); setInvitationOpen(false); }
  useEffect(() => {
    const captureInvitation = () => {
      if (!window.location.hash.startsWith('#invite=')) return;
      setInvitationToken(readInvitation()); setInvitationOpen(true);
    };
    window.addEventListener('hashchange', captureInvitation);
    return () => window.removeEventListener('hashchange', captureInvitation);
  }, []);
  const generation = useRef(0); const mounted = useRef(false); const expiryRefreshPending = useRef(false);
  const reloadBootstrap = useCallback(() => {
    const requestGeneration = ++generation.current;
    // Removing bootstrap unmounts all identity-bearing and sensitive forms immediately.
    setBootstrap(null); setError('');
    void fetchBootstrap().then((data) => {
      if (mounted.current && generation.current === requestGeneration) setBootstrap(data as BootstrapView);
    }).catch((cause) => {
      if (mounted.current && generation.current === requestGeneration) setError(cause instanceof Error ? cause.message : '暂时无法连接服务');
    }).finally(() => {
      if (generation.current === requestGeneration) expiryRefreshPending.current = false;
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onAuthExpired(() => {
      if (!mounted.current || expiryRefreshPending.current) return;
      expiryRefreshPending.current = true;
      reloadBootstrap();
    });
    reloadBootstrap();
    return () => { mounted.current = false; generation.current++; expiryRefreshPending.current = false; unsubscribe(); };
  }, [reloadBootstrap]);
  // A callback retained by a form unmounted on expiry cannot restore the old user.
  const viewGeneration = generation.current;
  function signedOut() { if (mounted.current && generation.current === viewGeneration) reloadBootstrap(); }
  function authenticated(result: AuthResult) {
    if (mounted.current && generation.current === viewGeneration) setBootstrap((current) => current ? { ...current, user: result.user, csrfToken: result.csrfToken } : current);
  }
  function userChanged(updated: UserView) {
    if (mounted.current && generation.current === viewGeneration) setBootstrap((current) => current ? { ...current, user: updated } : current);
  }
  if (!bootstrap) {
    if (showLocalContent && error) return <OfflineRecoveryPage onBack={() => setShowLocalContent(false)} onReconnect={() => { setShowLocalContent(false); reloadBootstrap(); }} />;
    return <main className="boot-screen"><Brand /><EmptyState title={error ? '暂时无法连接服务' : '正在连接同频'} description={error || '正在确认服务与账号状态。'} action={error ? <><button className="primary-button" onClick={reloadBootstrap}><RefreshCw size={16} />重新连接</button><button className="text-button" onClick={() => setShowLocalContent(true)}>查看本机待发与草稿</button></> : undefined} /></main>;
  }
  if (!bootstrap.accountsEnabled) return <WelcomePage />;
  if (!bootstrap.user) return <><AuthPage bootstrap={bootstrap} admin={admin} initialMode={window.location.pathname.replace(/\/+$/, '') === '/register' ? 'register' : 'login'} onAuthenticated={authenticated} />{invitationToken && (invitationOpen ? <GroupInviteEntry key={invitationToken} token={invitationToken} userId={null} onClose={closeInvitation} onSignIn={() => setInvitationOpen(false)} onOpenGroup={async () => {}} /> : <button className="invitation-resume-button secondary-button" onClick={() => setInvitationOpen(true)}>继续查看群邀请</button>)}</>;
  if (admin) return <AdminEntry key={bootstrap.user.id} onSignedOut={signedOut} />;
  const user = bootstrap.user;
  return <ChatWorkspace key={user.id} user={user} onUserChange={userChanged} onSignedOut={signedOut} invitationToken={invitationToken} onInvitationDismiss={closeInvitation} />;
}
