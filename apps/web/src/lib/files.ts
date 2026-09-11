import { api, APIError } from './api';
import type { LocalAttachment } from './chat-types';
import type { UploadPurpose, UploadRecord } from './files-types';

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
export const FILE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, 'pdf', 'txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'zip', '7z']);
export const FILE_ACCEPT = [...FILE_EXTENSIONS].map((extension) => '.' + extension).join(',');

export function validateLocalFiles(files: LocalAttachment[]): void {
  if (files.length > 6) throw new APIError(0, { code: 'ATTACHMENT_LIMIT', message: '每条消息最多添加6个附件。' });
  let total = 0;
  const ids = new Set<string>();
  for (const file of files) {
    const ext = file.name.split('.').at(-1)?.toLowerCase() || '';
    if (!FILE_EXTENSIONS.has(ext) || !file.name.includes('.') || /[/\\:\u0000-\u001f\u007f]/.test(file.name) || file.name !== file.name.trim() || file.name.length > 200) throw new APIError(0, { code: 'FILE_TYPE_UNSUPPORTED', message: '附件类型或文件名不受支持，请重新选择。' });
    if (!file.blob || file.blob.size <= 0 || file.blob.size > (IMAGE_EXTENSIONS.has(ext) ? 10 : 25) * 1024 ** 2) throw new APIError(0, { code: 'PAYLOAD_TOO_LARGE', message: '图片须为非空且不超过10 MiB，文件须为非空且不超过25 MiB。' });
    if (ids.has(file.id)) throw new APIError(0, { code: 'ATTACHMENT_LIMIT', message: '同一附件不能重复添加。' });
    ids.add(file.id); total += file.blob.size;
  }
  if (total > 50 * 1024 ** 2) throw new APIError(0, { code: 'PAYLOAD_TOO_LARGE', message: '每条消息附件合计不能超过50 MiB。' });
}

export function prepareLocalFiles(files: File[]): LocalAttachment[] {
  const result = files.map((file) => ({ id: crypto.randomUUID(), blob: file, name: file.name, mime: file.type, phase: 'preparing' as const }));
  validateLocalFiles(result);
  return result;
}

function pause(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new DOMException('已取消', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export type UploadContext = { actorContext: string; purpose: UploadPurpose; conversationId?: string; accessKey?: string };
export async function uploadLocalAttachment(original: LocalAttachment, context: UploadContext, options: { signal?: AbortSignal; onChange?: (file: LocalAttachment) => void | Promise<void>; retry?: boolean } = {}): Promise<UploadRecord> {
  validateLocalFiles([original]);
  let file = original;
  const update = async (change: Partial<LocalAttachment>) => { file = { ...file, ...change }; await options.onChange?.(file); if (options.signal?.aborted) throw options.signal.reason; };
  try {
    await update({ phase: 'preparing', error: undefined });
    if (!file.sha256) {
      const digest = await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer());
      await update({ sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('') });
    }
    let record = file.attachmentId ? await api<UploadRecord>('/api/v1/attachments/' + encodeURIComponent(file.attachmentId), { signal: options.signal }) : await api<UploadRecord>('/api/v1/attachment-uploads', { method: 'POST', body: { clientUploadId: file.id, name: file.name, mime: file.mime, size: file.blob.size, sha256: file.sha256, ...context }, signal: options.signal });
    await update({ attachmentId: record.id });
    if (record.state === 'quarantined' && options.retry) record = await api<UploadRecord>('/api/v1/attachments/' + encodeURIComponent(record.id) + '/retry', { method: 'POST', body: {}, signal: options.signal });
    if (record.state === 'reserved' || record.state === 'uploading') {
      await update({ phase: 'uploading' });
      record = await api<UploadRecord>('/api/v1/attachments', { method: 'POST', upload: { id: record.id, blob: file.blob }, signal: options.signal });
    }
    const deadline = Date.now() + 30000;
    while (record.state === 'processing') {
      await update({ phase: 'checking' });
      if (Date.now() >= deadline) throw new APIError(503, { code: 'FILE_PROCESSING', message: '文件仍在校验中，稍后将查询同一上传记录。', retryAfterMs: 2000 });
      await pause(500, options.signal);
      record = await api<UploadRecord>('/api/v1/attachments/' + encodeURIComponent(record.id), { signal: options.signal });
    }
    if (record.state !== 'ready') throw new APIError(409, { code: record.state === 'quarantined' ? 'FILE_QUARANTINED' : record.errorCode || 'FILE_NOT_READY', message: record.error || '文件未就绪，请保留本机副本并重试或重新选择。' });
    await update({ phase: 'ready', error: undefined });
    return record;
  } catch (error) {
    if (!options.signal?.aborted) await update({ phase: 'failed', error: error instanceof Error ? error.message : '上传结果尚未确认，请重试同一附件。' });
    throw error;
  }
}
