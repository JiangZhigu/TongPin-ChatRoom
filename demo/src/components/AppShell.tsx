import { useState, type ReactNode } from 'react';
import { NavigationRail, type MainSection } from './NavigationRail';
import { ConversationList, type ConversationView } from './ConversationList';
import { EmptyState } from './EmptyState';

export function AppShell({ conversations, selectedId, onSelectConversation, children, details, settingsContent, accountFooter, activeSection, onNavigate, sectionContent, listContent, badges, failedCount, onOpenProfile }: { conversations: ConversationView[]; selectedId?: string; onSelectConversation: (id: string) => void; children: ReactNode; details?: ReactNode; settingsContent?: ReactNode; accountFooter?: ReactNode; activeSection?: MainSection; onNavigate?: (section: MainSection) => void; sectionContent?: ReactNode; listContent?: ReactNode; onOpenProfile?: () => void; failedCount?: number; badges?: Partial<Record<MainSection, number>> }) {
  const [localSection, setLocalSection] = useState<MainSection>('messages');
  const section = activeSection || localSection;
  const labels = { tasks: '待办', contacts: '联系人', notifications: '通知', queue: '本机待发', files: '共享文件', bookmarks: '我的收藏', settings: '账号设置' };
  return <div className={`app-shell ${selectedId && section === 'messages' ? 'chat-mode' : 'list-mode'}`}><NavigationRail onOpenProfile={onOpenProfile} active={section} badges={badges} failedCount={failedCount} onNavigate={onNavigate || setLocalSection} />{section === 'messages' ? <><div className="conversation-column">{listContent || <ConversationList conversations={conversations} selectedId={selectedId} onSelect={onSelectConversation} />}{accountFooter}</div><main className="chat-pane">{children}</main>{details && <aside className="details-panel" aria-label="会话详情">{details}</aside>}</> : <main className={`section-page section-page-${section}`}>{sectionContent || (section === 'settings' && settingsContent ? settingsContent : <><h1>{labels[section]}</h1><EmptyState title="功能尚未启用" description="功能开放后，你可以在这里查看和管理相关内容。" /></>)}</main>}</div>;
}
