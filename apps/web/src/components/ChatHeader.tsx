import { ArrowLeft, PanelRight } from 'lucide-react';

export function ChatHeader({ title, description, onBack, onToggleDetails, detailsOpen = false }: { title: string; description?: string; onBack: () => void; onToggleDetails?: () => void; detailsOpen?: boolean }) {
  return <header className="chat-header"><button className="icon-button back-button" onClick={onBack} aria-label="返回会话列表"><ArrowLeft size={21} /></button><span className="avatar" aria-hidden="true">{title.slice(0, 1)}</span><div className="chat-heading"><h1>{title}</h1>{description && <p>{description}</p>}</div>{onToggleDetails && <button className="icon-button" onClick={onToggleDetails} aria-label="会话设置" aria-expanded={detailsOpen}><PanelRight size={20} /></button>}</header>;
}
