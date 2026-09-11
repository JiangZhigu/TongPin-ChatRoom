import { Send } from 'lucide-react';
import { useId, useState } from 'react';

export function Composer({ value, onChange, onSend, disabledReason, sending = false, notice, inputRef }: { value: string; onChange: (value: string) => void; onSend: () => void; disabledReason?: string; sending?: boolean; notice?: string; inputRef?: React.Ref<HTMLTextAreaElement> }) {
  const [composing, setComposing] = useState(false);
  const hintId = useId();
  const codepoints = Array.from(value).length;
  const bytes = new TextEncoder().encode(value).byteLength;
  const limitError = codepoints > 4000 || bytes > 16384 ? '消息不能超过 4,000 个字符或 16 KiB，请缩短后再发送。' : '';
  const canSend = !disabledReason && !sending && !limitError && !!value.trim();
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }}><textarea ref={inputRef} aria-label="消息内容" aria-describedby={hintId} aria-invalid={!!limitError} placeholder={disabledReason || '发送一条消息…'} disabled={!!disabledReason} value={value} onChange={(event) => onChange(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) onSend(); } }} />{limitError && <p className="field-error" role="alert">{limitError}</p>}<div className="composer-footer"><p id={hintId}>{disabledReason || notice || 'Enter 发送 · Shift + Enter 换行'}{codepoints > 3500 && <span className="composer-count">{codepoints.toLocaleString()} / 4,000 字符</span>}</p><button className="primary-button" disabled={!canSend} type="submit">{sending ? '保存中…' : '发送'}<Send size={16} /></button></div></form>;
}
