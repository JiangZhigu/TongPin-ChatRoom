import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from './lib/api';
import type { Conversation, Page } from './lib/chat-types';
import type { FileListItem, FilePolicy } from './lib/files-types';
import { AttachmentList, attachmentError, fileSize } from './AttachmentViews';
import { EmptyState } from './components/EmptyState';

export function FilesPage({ conversations }: { conversations: Conversation[] }) {
  const [conversationId, setConversationId] = useState(''); const [kind, setKind] = useState('');
  const [items, setItems] = useState<FileListItem[]>([]); const [after, setAfter] = useState<string | null>(null); const [policy, setPolicy] = useState<FilePolicy | null>(null);
  const [busy, setBusy] = useState(true); const [error, setError] = useState(''); const [policyError, setPolicyError] = useState(''); const [revision, setRevision] = useState(0);
  const generation = useRef(0); const request = useRef<AbortController | null>(null);
  function endpoint(cursor?: string | null) { const query = new URLSearchParams({ limit: '30' }); if (conversationId) query.set('conversationId', conversationId); if (kind) query.set('kind', kind); if (cursor) query.set('after', cursor); return `/api/v1/files?${query}`; }
  useEffect(() => {
    const controller = new AbortController(); setPolicyError('');
    void api<FilePolicy>('/api/v1/files/policy', { signal: controller.signal }).then(setPolicy).catch((cause) => { if (!controller.signal.aborted) setPolicyError(attachmentError(cause)); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const current = ++generation.current; const controller = new AbortController(); request.current = controller;
    setItems([]); setAfter(null); setBusy(true); setError('');
    void api<Page<FileListItem>>(endpoint(), { signal: controller.signal }).then((page) => { if (!controller.signal.aborted && generation.current === current) { setItems(page.items); setAfter(page.nextCursor); } }).catch((cause) => { if (!controller.signal.aborted) setError(attachmentError(cause)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); request.current?.abort(); generation.current++; };
  }, [conversationId, kind, revision]);
  async function loadMore() {
    if (busy || !after) return; const current = generation.current; const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try { const page = await api<Page<FileListItem>>(endpoint(after), { signal: controller.signal }); if (!controller.signal.aborted && current === generation.current) { setItems((previous) => [...previous, ...page.items.filter((file) => !previous.some((old) => old.id === file.id && old.messageId === file.messageId))]); setAfter(page.nextCursor); } }
    catch (cause) { if (!controller.signal.aborted && current === generation.current) setError(attachmentError(cause)); }
    finally { if (!controller.signal.aborted && current === generation.current) setBusy(false); }
  }
  return <section className="files-page" aria-label="文件中心"><header className="files-heading"><div><h1>文件</h1><p className="field-hint">查找当前可访问会话中的图片与附件。</p></div><button className="secondary-button" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} />刷新文件</button></header>
    {policy && <div className="file-policy"><p>本人空间：已用 {fileSize(policy.usedBytes)} / {fileSize(policy.userQuota)}，上传预留 {fileSize(policy.reservedBytes)}</p><p>每条最多 {policy.attachmentCount} 件、合计 {fileSize(policy.messageBytes)}；图片 {fileSize(policy.imageLimit)} / 文件 {fileSize(policy.fileLimit)}。</p><p>{policy.scanPolicy === 'closed-test-unscanned' ? '当前为封闭测试：一般文件可能未经恶意软件扫描（not_scanned）。' : '一般文件需通过服务端扫描后才可发送；扫描不可用时将保持隔离。'}</p></div>}{policyError && <p className="field-error" role="alert">配额与策略加载失败：{policyError}</p>}
    <div className="files-filters"><label>所属会话<select value={conversationId} onChange={(event) => setConversationId(event.target.value)}><option value="">全部可访问会话</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select></label><label>文件类型<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option><option value="image">图片</option><option value="file">文件</option></select></label></div>
    {error && <p role="alert" className="form-error">{error}</p>}{busy && !items.length ? <p role="status">正在加载文件…</p> : !items.length && !error ? <EmptyState title="还没有可显示的文件" description="发送的附件会在获得服务器确认后显示在这里。" /> : <ul className="files-grid">{items.map((file) => <li key={`${file.messageId}:${file.id}`}><span className="file-origin">{file.conversationTitle} · {file.senderName}<br />{new Date(file.createdAt).toLocaleString('zh-CN')}</span><AttachmentList files={[file]} /></li>)}</ul>}{after && <button className="load-more-button" disabled={busy} onClick={() => void loadMore()}>{busy ? '正在加载…' : '加载更多文件'}</button>}
  </section>;
}
