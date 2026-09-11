import { Bell, Clock3, Folder, MessageCircle, Settings, Users } from 'lucide-react';
import { Brand } from './Brand';

export type MainSection = 'messages' | 'contacts' | 'notifications' | 'queue' | 'files' | 'settings';
const sections = [{ id: 'messages', label: '消息', Icon: MessageCircle }, { id: 'contacts', label: '联系人', Icon: Users }, { id: 'notifications', label: '通知', Icon: Bell }, { id: 'queue', label: '待发', Icon: Clock3 }, { id: 'files', label: '文件', Icon: Folder }, { id: 'settings', label: '设置', Icon: Settings }] as const;
export function NavigationRail({ active, onNavigate, badges = {} }: { active: MainSection; onNavigate: (section: MainSection) => void; badges?: Partial<Record<MainSection, number>> }) {
  return <nav className="navigation-rail" aria-label="主导航"><a className="rail-brand" href="/" aria-label="同频首页"><Brand compact /></a><div className="rail-items">{sections.map(({ id, label, Icon }) => <button key={id} className={`rail-button ${active === id ? 'active' : ''}`} aria-current={active === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={21} strokeWidth={1.6} /><span>{label}</span>{(badges[id] || 0) > 0 && <span className="rail-badge" aria-label={`${badges[id]} 条未处理`}>{badges[id]! > 99 ? '99+' : badges[id]}</span>}</button>)}</div></nav>;
}
