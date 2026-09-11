import { EmptyState } from './EmptyState';

export interface MessageView { id: string; author: string; text: string; own: boolean; timeLabel: string; statusLabel?: string }
export function MessageTimeline({ messages }: { messages: MessageView[] }) {
  return <section className="message-timeline" aria-label="消息记录">{messages.length ? <ol>{messages.map((message) => <li className={`message ${message.own ? 'own' : ''}`} key={message.id}><span className="avatar" aria-hidden="true">{message.author.slice(0, 1)}</span><div className="message-content"><div className="message-meta">{message.author}<span>{message.timeLabel}</span></div><div className="message-bubble">{message.text}</div>{message.statusLabel && <div className="message-status">{message.statusLabel}</div>}</div></li>)}</ol> : <EmptyState title="对话从这里开始" description="这段会话还没有消息。" />}</section>;
}
