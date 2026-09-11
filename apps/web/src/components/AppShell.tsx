import { useState, type ReactNode } from 'react';
import { NavigationRail, type MainSection } from './NavigationRail';
import { ConversationList, type ConversationView } from './ConversationList';
import { EmptyState } from './EmptyState';

export function AppShell({ conversations, selectedId, onSelectConversation, children, details }: { conversations: ConversationView[]; selectedId?: string; onSelectConversation: (id: string) => void; children: ReactNode; details?: ReactNode }) {
  const [section, setSection] = useState<MainSection>('messages');
  const labels = { contacts: '联系人', notifications: '通知', files: '共享文件', settings: '账号设置' };
  return <div className={`app-shell ${selectedId && section === 'messages' ? 'chat-mode' : 'list-mode'}`}><NavigationRail active={section} onNavigate={setSection} />{section === 'messages' ? <><ConversationList conversations={conversations} selectedId={selectedId} onSelect={onSelectConversation} /><main className="chat-pane">{children}</main>{details && <aside className="details-panel" aria-label="会话详情">{details}</aside>}</> : <main className="section-page"><h1>{labels[section]}</h1><EmptyState title="功能尚未启用" description="功能开放后，你可以在这里查看和管理相关内容。" /></main>}</div>;
}
