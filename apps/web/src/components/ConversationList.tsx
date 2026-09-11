import { Search } from 'lucide-react';
import { useState } from 'react';
import { Brand } from './Brand';
import { EmptyState } from './EmptyState';

// Presentation models only. Map authenticated domain data into these props.
export interface ConversationView { id: string; title: string; preview: string; timeLabel?: string; unreadLabel?: string }
export function ConversationList({ conversations, selectedId, onSelect }: { conversations: ConversationView[]; selectedId?: string; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const filtered = conversations.filter((item) => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <aside className="conversation-list" aria-label="会话列表"><header className="list-brand"><Brand /><p>让对话，自然发生。</p></header><label className="search-field"><Search size={17} aria-hidden="true" /><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="list-label">最近会话</div><div className="conversation-scroll">{filtered.length ? <ul>{filtered.map((item) => <li key={item.id}><button className={`conversation-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}><span className="avatar">{item.title.slice(0, 1)}</span><span className="conversation-copy"><span className="conversation-title">{item.title}</span><span className="conversation-preview">{item.preview}</span></span><span className="conversation-meta">{item.timeLabel}{item.unreadLabel && <span className="unread">{item.unreadLabel}</span>}</span></button></li>)}</ul> : <EmptyState title={search ? '没有找到会话' : '还没有会话'} description={search ? '试试其他关键词。' : '开始对话后，会话将出现在这里。'} />}</div></aside>;
}
