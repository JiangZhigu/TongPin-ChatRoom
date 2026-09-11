import { AnnouncementsPage } from './AnnouncementsPage';
import { AdministratorsPage } from './AdministratorsPage';
import { AuditPage } from './AuditPage';
import { OperationsPage } from './OperationsPage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brand } from '../components/Brand';
import type { UserView } from '../auth-types';
import { AdminActionDialog } from './AdminActionDialog';
import { AdminContext, AdminLink, PageHeading, type ActionRequest } from './AdminShared';
import { OverviewPage } from './OverviewPage';
import { MonitoringPage } from './MonitoringPage';
import { UserDetailPage, UsersPage } from './UsersPage';
import { SessionsPage } from './SessionsPage';
import { RelationsPage } from './RelationsPage';
import { GroupDetailPage, GroupsPage } from './GroupsPage';
import { ContentPage } from './ContentPage';
import { FilesPage } from './FilesPage';
import { ReportsPage } from './ReportsPage';
import { SettingsPage } from './SettingsPage';
import '../styles-admin.css';

const navigation = [['/admin', '运营概览'], ['/admin/monitoring', '系统监控'], ['/admin/users', '用户管理'], ['/admin/sessions', '会话与连接'], ['/admin/relations', '好友与关系'], ['/admin/groups', '群聊管理'], ['/admin/content', '消息治理'], ['/admin/files', '文件与空间'], ['/admin/reports', '举报工单'], ['/admin/settings', '站点策略'], ['/admin/announcements', '公告与通知'], ['/admin/administrators', '管理员安全'], ['/admin/audit', '审计与日志'], ['/admin/operations', '运维与备份']];
function currentLocation() { return window.location.pathname + window.location.search; }
function Route({ url }: { url: string }) {
  const parsed = new URL(url, window.location.origin); const path = parsed.pathname.replace(/\/$/, ''); const params = parsed.searchParams;
  if (path === '/admin') return <OverviewPage params={params} />;
  if (path === '/admin/monitoring') return <MonitoringPage params={params} />;
  if (path === '/admin/users') return <UsersPage params={params} />;
  if (path === '/admin/sessions') return <SessionsPage params={params} />;
  if (path === '/admin/relations') return <RelationsPage params={params} />;
  if (path === '/admin/groups') return <GroupsPage params={params} />;
  if (path === '/admin/content') return <ContentPage params={params} />;
  if (path === '/admin/files') return <FilesPage params={params} />;
  if (path === '/admin/reports') return <ReportsPage params={params} />;
  if (path === '/admin/settings') return <SettingsPage params={params} />;
  if (path === '/admin/announcements') return <AnnouncementsPage params={params} />;
  if (path === '/admin/administrators') return <AdministratorsPage params={params} />;
  if (path === '/admin/audit') return <AuditPage />;
  if (path === '/admin/operations') return <OperationsPage />;
  const detail = path.match(/^\/admin\/(users|groups)\/([^/]+)$/);
  if (detail) { try { const id = decodeURIComponent(detail[2]); return detail[1] === 'users' ? <UserDetailPage id={id} /> : <GroupDetailPage id={id} params={params} />; } catch { /* Malformed URL remains a route error. */ } }
  return <><PageHeading title="未找到管理页面" description="此地址没有对应的管理功能。" /><AdminLink href="/admin">返回运营概览</AdminLink></>;
}
export function AdminShell({ user, onSignOut, signOutBusy, signOutError }: { user: UserView; onSignOut: () => void; signOutBusy: boolean; signOutError: string }) {
  const [url, setUrl] = useState(currentLocation); const [revision, setRevision] = useState(0); const [request, setRequest] = useState<ActionRequest | null>(null); const [forbidden, setForbidden] = useState(false); const [menuOpen, setMenuOpen] = useState(false);
  const deny = useCallback(() => { setRequest(null); setForbidden(true); }, []);
  const navigate = useCallback((next: string) => { const parsed = new URL(next, window.location.origin); if (parsed.origin !== window.location.origin || !(parsed.pathname === '/admin' || parsed.pathname.startsWith('/admin/'))) return; window.history.pushState({}, '', parsed.pathname + parsed.search); setRequest(null); setMenuOpen(false); setUrl(currentLocation()); }, []);
  useEffect(() => { const pop = () => { setRequest(null); setMenuOpen(false); setUrl(currentLocation()); }; window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => { document.querySelector<HTMLElement>('.admin-content h1')?.focus(); }, [url]);
  const value = useMemo(() => ({ navigate, openAction: setRequest, deny, revision }), [navigate, deny, revision]);
  if (forbidden) return <main className="admin-denied"><Brand /><h1>管理权限已失效</h1><p role="alert">已清除本页面的管理数据。请重新登录并确认超级管理员身份与第二因素验证。</p><a className="primary-button" href="/admin">重新验证管理身份</a><a href="/">返回同频</a></main>;
  return <AdminContext.Provider value={value}><div className="admin-shell"><a className="admin-skip" href="#admin-main">跳到主要内容</a><header className="admin-topbar"><a href="/" aria-label="返回同频"><Brand /></a><span className="admin-tag">管理后台</span><button className="secondary-button admin-menu-toggle" aria-expanded={menuOpen} aria-controls="admin-navigation" onClick={() => setMenuOpen(!menuOpen)}>管理导航</button><span className="admin-identity">{user.nickname} · 超级管理员</span><button className="text-button" disabled={signOutBusy} onClick={onSignOut}>{signOutBusy ? '正在退出…' : '退出当前账号'}</button></header><aside className={`admin-sidebar${menuOpen ? ' open' : ''}`}><nav id="admin-navigation" aria-label="管理导航">{navigation.map(([href, label]) => <div key={href} aria-current={href === '/admin' ? url.split('?')[0] === href ? 'page' : undefined : url.startsWith(href) ? 'page' : undefined}><AdminLink href={href}>{label}</AdminLink></div>)}</nav><p>每项操作均由服务器核验管理权限。</p><a href="/">返回聊天</a></aside><main id="admin-main" className="admin-content">{signOutError && <p role="alert" className="form-error">{signOutError}</p>}<div key={url.split('?' )[0] === '/admin/operations' ? url : `${url}:${revision}`}><Route url={url} /></div></main>{request && <AdminActionDialog request={request} onClose={() => setRequest(null)} onChanged={() => { setUrl(currentLocation()); setRevision((version) => version + 1); }} />}</div></AdminContext.Provider>;
}
