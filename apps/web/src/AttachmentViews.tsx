import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Image as ImageIcon, X } from 'lucide-react';
import type { Attachment, LocalAttachment } from './lib/chat-types';
import { Modal } from './components/Modal';
import './styles-files.css';

export const fileSize = (bytes: number) => bytes === 0 ? '0 B' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
export const attachmentError = (cause: unknown) => cause instanceof Error ? cause.message : '文件操作失败，请重试。';
const localPhase = { preparing: '本机准备', uploading: '上传中', checking: '校验中', ready: '已就绪', failed: '处理失败' };
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function Avatar({ url, label, className = '' }: { url?: string | null; label: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className={`avatar ${className}`} aria-label={label}>{url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : label.slice(0, 1)}</span>;
}

function useDownload() {
  const urls = useRef<string[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; urls.current.forEach((url) => URL.revokeObjectURL(url)); urls.current = []; }; }, []);
  return (blob: Blob, name: string) => {
    if (!alive.current) return;
    const url = URL.createObjectURL(blob); urls.current.push(url);
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    // Keep the URL valid while the browser starts its download, then release it.
    setTimeout(() => { URL.revokeObjectURL(url); urls.current = urls.current.filter((item) => item !== url); }, 1000);
  };
}

function LocalFile({ file, onRemove, beforeDownload, allowDownload }: { file: LocalAttachment; onRemove?: () => void; beforeDownload?: () => Promise<void>; allowDownload?: boolean }) {
  const [url, setUrl] = useState<string>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const download = useDownload();
  useEffect(() => {
    if (!file.mime.startsWith('image/')) return;
    const next = URL.createObjectURL(file.blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file.blob, file.mime]);
  async function saveCopy() { setBusy(true); setError(''); try { await beforeDownload?.(); download(file.blob, file.name); } catch (cause) { setError(attachmentError(cause)); } finally { setBusy(false); } }
  return <li className="local-file"><div className="file-thumbnail">{url ? <img src={url} alt="" /> : <FileText size={24} />}</div><div className="file-copy"><strong>{file.name}</strong><small>{fileSize(file.blob.size)} · {file.phase ? localPhase[file.phase] : '本机附件'}</small>{file.mime === 'image/gif' && <small>本机 GIF · 发送后显示静态预览</small>}{file.error && <p className="field-error">{file.error}</p>}{error && <p role="alert" className="field-error">{error}</p>}</div>{allowDownload && <button type="button" className="icon-button" disabled={busy} aria-label={`下载本机副本 ${file.name}`} onClick={() => void saveCopy()}><Download size={17} /></button>}{onRemove && <button type="button" className="icon-button" aria-label={`移除附件 ${file.name}`} onClick={onRemove}><X size={17} /></button>}</li>;
}

export function LocalAttachmentList({ files, onRemove, beforeDownload, allowDownload = false }: { files: LocalAttachment[]; onRemove?: (id: string) => void; beforeDownload?: () => Promise<void>; allowDownload?: boolean }) {
  return files.length ? <ul className="local-attachments" aria-label="本机附件">{files.map((file) => <LocalFile key={file.id} file={file} onRemove={onRemove ? () => onRemove(file.id) : undefined} allowDownload={allowDownload} beforeDownload={beforeDownload} />)}</ul> : null;
}

function ServerFile({ file }: { file: Attachment }) {
  const [preview, setPreview] = useState(false); const [imageError, setImageError] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null); const download = useDownload();
  const available = (file.state === undefined || file.state === 'ready') && file.errorCode !== 'FILE_RESTRICTED' && typeof file.contentUrl === 'string' && file.contentUrl.trim().length > 0;
  const accessKey = JSON.stringify([file.id, file.state, file.errorCode, file.contentUrl]);
  const access = useRef({ key: accessKey, revision: 0, available });
  if (access.current.key !== accessKey) access.current = { key: accessKey, revision: access.current.revision + 1, available };
  else access.current.available = available;
  const previewAvailable = available && !!file.thumbnailUrl && !!file.previewUrl;
  useEffect(() => {
    controller.current?.abort(); controller.current = null; setBusy(false); setPreview(false); setError(''); setImageError(false);
  }, [accessKey, file.thumbnailUrl, file.previewUrl]);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  const animated = file.mime === 'image/gif' || (file.frameCount || 0) > 1;
  async function save() {
    if (!access.current.available || controller.current) return;
    const requestRevision = access.current.revision; const contentUrl = file.contentUrl;
    setBusy(true); setError(''); const request = new AbortController(); controller.current = request;
    let timedOut = false;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new DOMException('下载已取消', 'AbortError')); request.signal.addEventListener('abort', abort, { once: true }); });
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, DOWNLOAD_TIMEOUT_MS);
    try {
      const body = (async () => {
        const response = await fetch(contentUrl, { credentials: 'same-origin', signal: request.signal });
        if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录后下载。' : [403, 404, 410].includes(response.status) ? '文件已不可访问，可能已撤回、删除或失去会话权限。' : '下载失败，请稍后重试。');
        return response.blob();
      })();
      const blob = await Promise.race([body, cancelled]); if (!request.signal.aborted && controller.current === request && access.current.available && access.current.revision === requestRevision) download(blob, file.name);
    } catch (cause) { if (controller.current === request && (timedOut || !request.signal.aborted)) setError(timedOut ? '下载超过 120 秒，已停止等待，请重试。' : attachmentError(cause)); }
    finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); if (controller.current === request) { controller.current = null; setBusy(false); } }
  }
  return <div className={`server-file ${file.kind === 'image' ? 'image-attachment' : ''}`}>
    {file.kind === 'image' && previewAvailable && !imageError && <button type="button" className="image-preview-button" aria-label={`预览图片 ${file.name}`} onClick={() => setPreview(true)}><img src={file.thumbnailUrl} alt={file.name} loading="lazy" onError={() => setImageError(true)} /></button>}
    {imageError && <p className="field-error" role="alert">图片预览已不可访问，请刷新会话确认权限。</p>}
    <div className="file-card"><span className="file-type-icon">{file.kind === 'image' ? <ImageIcon size={23} /> : <FileText size={23} />}</span><div className="file-copy"><strong>{file.name}</strong><small>{fileSize(file.size)}{animated ? ' · 静态预览，原件保留动画' : ''}</small>{file.error && <p className="field-error" role="alert">{file.error}</p>}{!available && !file.error && <p className="field-error" role="status">文件当前不可下载，请刷新会话确认状态。</p>}</div><button type="button" className="icon-button" aria-label={`${animated ? '下载原始动画' : '下载文件'} ${file.name}`} disabled={busy || !available} onClick={() => void save()}><Download size={18} /></button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {preview && previewAvailable && <Modal open title={file.name} onClose={() => setPreview(false)}><div className="attachment-lightbox">{file.previewUrl && !imageError ? <img src={file.previewUrl} alt={file.name} onError={() => setImageError(true)} /> : <p role="alert">图片预览已不可访问。</p>}</div>{animated && <p className="field-hint">这是安全处理后的静态预览。下载原始文件可查看动画。</p>}<button type="button" className="secondary-button" disabled={busy || !available} onClick={() => void save()}>{busy ? '正在下载…' : '下载原件'}</button>{error && <p className="field-error" role="alert">{error}</p>}</Modal>}
  </div>;
}

export function AttachmentList({ files }: { files: Attachment[] }) { return files.length ? <div className="message-attachments" aria-label="消息附件">{files.map((file) => <ServerFile key={file.id} file={file} />)}</div> : null; }
