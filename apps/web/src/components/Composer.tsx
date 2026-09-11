import { Send } from 'lucide-react';
import { useId, useState } from 'react';

export function Composer({ value, onChange, onSend, disabledReason, sending = false }: { value: string; onChange: (value: string) => void; onSend: () => void; disabledReason?: string; sending?: boolean }) {
  const [composing, setComposing] = useState(false);
  const hintId = useId();
  const canSend = !disabledReason && !sending && !!value.trim();
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}><textarea aria-label="消息内容" aria-describedby={hintId} placeholder={disabledReason || '发送一条消息…'} disabled={!!disabledReason} value={value} onChange={(event) => onChange(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) onSend(); } }} /><div className="composer-footer"><p id={hintId}>{disabledReason || 'Enter 发送 · Shift + Enter 换行'}</p><button className="primary-button" disabled={!canSend} type="submit">{sending ? '发送中' : '发送'}<Send size={16} /></button></div></form>;
}
