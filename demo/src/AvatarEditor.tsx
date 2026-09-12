import { useEffect, useRef, useState } from 'react';
import type { LocalAttachment } from './lib/chat-types';
import type { UploadPurpose } from './lib/files-types';
import { IMAGE_EXTENSIONS, prepareLocalFiles, uploadLocalAttachment } from './lib/files';
import { attachmentError, Avatar, LocalAttachmentList } from './AttachmentViews';

export function AvatarEditor({ actorContext, label, avatarUrl, purpose, conversationId, accessKey, disabled = false, onSave, onBusyChange }: { onBusyChange?: (busy: boolean) => void; actorContext: string; label: string; avatarUrl?: string | null; purpose: Extract<UploadPurpose, 'user_avatar' | 'group_avatar'>; conversationId?: string; accessKey?: string; disabled?: boolean; onSave: (attachmentId: string | null, signal: AbortSignal) => Promise<void> }) {
  const [file, setFile] = useState<LocalAttachment | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const input = useRef<HTMLInputElement>(null); const active = useRef(false); const request = useRef<AbortController | null>(null); const latestFile = useRef<LocalAttachment | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); latestFile.current = null; }; }, [actorContext, conversationId]);
  function choose(files: FileList | null) {
    if (busy || !files?.length) return;
    setError(''); setNotice('');
    try { const [next] = prepareLocalFiles([files[0]]); if (!IMAGE_EXTENSIONS.has(next.name.split('.').at(-1)?.toLowerCase() || '')) throw new Error('头像仅支持 PNG、JPEG、WebP 或 GIF 图片。'); latestFile.current = next; setFile(next); }
    catch (cause) { setError(attachmentError(cause)); }
  }
  async function save(remove = false) {
    if (busy || disabled || !remove && !latestFile.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setNotice('');
    try {
      let attachmentId: string | null = null;
      if (!remove) {
        const uploaded = await uploadLocalAttachment(latestFile.current!, { actorContext, purpose, conversationId, accessKey }, { signal: controller.signal, retry: true, onChange: async (value: LocalAttachment) => { if (active.current && !controller.signal.aborted) { latestFile.current = value; setFile(value); } } });
        if (uploaded.state !== 'ready') throw new Error(uploaded.error || '头像尚未通过服务端校验，不能保存。');
        attachmentId = uploaded.id;
      }
      if (!active.current || controller.signal.aborted) return;
      await onSave(attachmentId, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      latestFile.current = null; setFile(null); setNotice(remove ? '头像已移除。' : '头像已保存。');
    } catch (cause) { if (active.current && !controller.signal.aborted) setError(attachmentError(cause)); }
    finally { if (active.current && request.current === controller) setBusy(false); }
  }
  return <section className="avatar-editor" aria-label={purpose === 'user_avatar' ? '个人头像' : '群头像'}><Avatar label={label} url={avatarUrl} /><div className="avatar-editor-controls"><strong>{purpose === 'user_avatar' ? '个人头像' : '群头像'}</strong><p className="field-hint">支持 PNG、JPEG、WebP、GIF，最大 10 MiB。保存为规范化静态头像。</p><div className="avatar-editor-actions"><button type="button" className="secondary-button" disabled={disabled || busy} onClick={() => input.current?.click()}>选择头像</button>{file && <button type="button" className="primary-button" disabled={disabled || busy} onClick={() => void save()}>{busy ? '正在处理头像…' : error ? '重试保存头像' : '保存头像'}</button>}{avatarUrl && <button type="button" className="text-button danger-text" disabled={disabled || busy} onClick={() => void save(true)}>移除头像</button>}{busy && <button type="button" className="text-button" onClick={() => { request.current?.abort(); setBusy(false); setNotice('已停止本次等待。上传结果可能尚未确认，可重试查询原记录。'); }}>停止等待</button>}</div><input className="attachment-input" ref={input} type="file" aria-label={purpose === 'user_avatar' ? '选择个人头像图片' : '选择群头像图片'} accept=".png,.jpg,.jpeg,.webp,.gif" disabled={disabled || busy} onChange={(event) => { choose(event.target.files); event.target.value = ''; }} /></div>{file && <LocalAttachmentList files={[file]} onRemove={busy ? undefined : () => { latestFile.current = null; setFile(null); setError(''); }} />}{error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}</section>;
}
