import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu } from 'lucide-react';
import { api } from './lib/api';
import type { Message } from './lib/chat-types';
import type { MessageUpdateToken } from './lib/chat-client';
import { Modal } from './components/Modal';
import { ReportDialog } from './ReportDialog';
import './styles-message-menu.css';

export function MessageActions({ message, userId, onUpdated, onReply, onBeginUpdate, onBookmarked, onCreateTask }: { message: Message; userId: string; onUpdated: (message: Message, token: MessageUpdateToken) => void | Promise<void>; onBeginUpdate: () => MessageUpdateToken; onBookmarked: (id: string, bookmarked: boolean, token: MessageUpdateToken) => void; onReply: () => void; onCreateTask?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [open, setOpen] = useState(false), [report, setReport] = useState(false);
  const [action, setAction] = useState<'recall' | 'moderate' | null>(null);
  const [reason, setReason] = useState(''), [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const path = `/api/v1/messages/${encodeURIComponent(message.id)}`;
  const active = message.status === 'sent' && message.kind === 'user';
  const own = message.senderId === userId;
  function closeMenu(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus(); }

  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useLayoutEffect(() => {
    if (!open || !active || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect(), panel = menu.current;
    const left = own ? anchor.right - panel.offsetWidth : anchor.left;
    const top = anchor.bottom + 6 + panel.offsetHeight <= window.innerHeight - 8 ? anchor.bottom + 6 : anchor.top - 6 - panel.offsetHeight;
    panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, top)}px`;
  }, [open, active, own, error, copied]);
  useEffect(() => {
    if (!open || !active) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: Event) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    document.addEventListener('scroll', scroll, true); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [open, active]);
  async function run(task: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); } finally { setBusy(false); }
  }
  if (!active) return null;
  return <div className={`message-actions ${own ? 'is-own' : ''}`}>
    <button ref={trigger} type="button" className="message-menu-toggle" aria-label="消息菜单" title="消息菜单" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => { setOpen(!open); setCopied(false); }} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><Menu size={16} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} id={menuId} className="message-action-menu" role="menu" aria-label="消息操作" onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement); if (!items.length) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
      if (next !== null) { event.preventDefault(); items[next].focus(); }
    }}>
      {onCreateTask && <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { await onCreateTask(); closeMenu(); })}>转为待办</button>}
      {message.capabilities?.canInteract && <button type="button" role="menuitem" disabled={busy} onClick={() => { closeMenu(); onReply(); }}>引用回复</button>}
      <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { const token = onBeginUpdate(); const result = await api<{ bookmarked: boolean }>(`${path}/bookmark`, { method: message.bookmarked ? 'DELETE' : 'PUT', body: {} }); onBookmarked(message.id, result.bookmarked, token); closeMenu(true); })}>{message.bookmarked ? '取消收藏' : '收藏'}</button>
      {message.text && <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(message.text); setCopied(true); })}>{copied ? '已复制' : '复制文字'}</button>}
      {message.capabilities?.canRecall && <button type="button" role="menuitem" disabled={busy} onClick={() => { closeMenu(true); setAction('recall'); setError(''); }}>撤回</button>}
      {message.capabilities?.canModerate && <button type="button" role="menuitem" className="danger-text" disabled={busy} onClick={() => { closeMenu(true); setAction('moderate'); setReason(''); setError(''); }}>管理删除</button>}
      <button type="button" role="menuitem" className="danger-text" disabled={busy} onClick={() => { closeMenu(true); setReport(true); }}>举报消息</button>
      {error && !action && <p role="alert" className="message-menu-error">{error}</p>}
    </div>, document.body)}
    {report && <ReportDialog target={{ kind: 'message', id: message.id, label: '这条消息' }} onClose={() => setReport(false)} />}
    <Modal open={!!action} title={action === 'recall' ? '撤回消息' : '管理删除消息'} dismissible={!busy} onClose={() => setAction(null)}>
      <p>{action === 'recall' ? '仅能撤回本人两分钟内的消息，撤回后正文和附件将不可见。' : '删除后其他成员将看不到正文和附件；此操作会记录到管理审计。'}</p>
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => { const token = onBeginUpdate(); const result = await api<{ message: Message }>(`${path}/${action}`, { method: 'POST', body: action === 'moderate' ? { reason } : {} }); await onUpdated(result.message, token); setAction(null); }); }}>
        {action === 'moderate' && <label className="form-field">管理删除原因<textarea required maxLength={500} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>}
        {error && action && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || (action === 'moderate' && !reason.trim())}>{busy ? '正在处理…' : '确认'}</button>
      </form>
    </Modal>
  </div>;
}
