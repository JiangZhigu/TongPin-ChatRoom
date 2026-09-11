import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { APIError } from './lib/api';
import { readOfflineSnapshot, removeOfflineItem, subscribeOfflineChanges, type OfflineLocalSnapshot } from './lib/outbox';
import { Brand } from './components/Brand';
import { EmptyState } from './components/EmptyState';
import { Modal } from './components/Modal';
import './styles-chat.css';

export function OfflineRecoveryPage({ onReconnect, onBack }: { onReconnect: () => void; onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<OfflineLocalSnapshot | null>(null); const [loading, setLoading] = useState(true);
  const [closed, setClosed] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [deleteTarget, setDeleteTarget] = useState<{ kind: 'outbox' | 'draft'; key: string } | null>(null);
  const revision = useRef<string | undefined>(undefined); const active = useRef(false); const closedRef = useRef(false); const generation = useRef(0);
  const initialized = useRef(false);
  const closeIdentity = useCallback(() => {
    closedRef.current = true; generation.current++; setSnapshot(null); setDeleteTarget(null); setLoading(false); setClosed(true); setNotice('');
    setError('本机身份已改变，旧内容已关闭。请重新连接并验证账号后继续。');
  }, []);
  const load = useCallback(async (kind: 'initial' | 'content' | 'check' | 'more', cursor?: string) => {
    if (!active.current || closedRef.current) return;
    const requestGeneration = ++generation.current;
    if (kind !== 'check') setLoading(true);
    try {
      const data = await readOfflineSnapshot(kind === 'initial' && !initialized.current ? undefined : revision.current, cursor);
      if (!active.current || closedRef.current || generation.current !== requestGeneration) return;
      if (initialized.current && (!data || data.identity.revision !== revision.current)) { closeIdentity(); return; }
      initialized.current = true;
      if (!data) { setSnapshot(null); setLoading(false); return; }
      revision.current = data.identity.revision;
      setSnapshot((current) => kind === 'check' && current ? { ...current, identity: data.identity, outbox: data.outbox } : kind === 'more' && current ? { ...data, drafts: [...current.drafts, ...data.drafts] } : data);
      if (kind !== 'check') setError('');
    } catch (cause) {
      if (!active.current || closedRef.current || generation.current !== requestGeneration) return;
      if (cause instanceof APIError && cause.code === 'LOCAL_IDENTITY_CHANGED') closeIdentity();
      else { setSnapshot(null); setError(cause instanceof Error ? cause.message : '本机内容暂时无法读取。'); }
    } finally { if (active.current && generation.current === requestGeneration) setLoading(false); }
  }, [closeIdentity]);
  useEffect(() => {
    active.current = true; closedRef.current = false; initialized.current = false; revision.current = undefined;
    void load('initial');
    const unsubscribe = subscribeOfflineChanges((kind) => {
      if (kind === 'identity') {
        closeIdentity();
        // Validate the old revision again without ever adopting another identity.
        if (revision.current) void readOfflineSnapshot(revision.current).catch(() => undefined);
      } else if (initialized.current && !revision.current) { closeIdentity(); }
      else void load(kind);
    });
    return () => { active.current = false; generation.current++; unsubscribe(); };
  }, [load, closeIdentity]);
  async function copy(text: string) {
    if (busy || !revision.current || closedRef.current) return;
    setBusy(true); setNotice('');
    try {
      const expected = revision.current; const current = await readOfflineSnapshot(expected);
      if (!active.current || closedRef.current) return;
      if (!current || current.identity.revision !== expected) { closeIdentity(); return; }
      await navigator.clipboard.writeText(text);
      if (active.current && !closedRef.current) setNotice('已复制到剪贴板，请妥善保管。');
    } catch (cause) {
      if (cause instanceof APIError && cause.code === 'LOCAL_IDENTITY_CHANGED') closeIdentity();
      else if (active.current && !closedRef.current) setNotice('无法复制，请手动选中内容保存。');
    } finally { if (active.current) setBusy(false); }
  }
  async function remove() {
    if (!deleteTarget || busy || !revision.current || closedRef.current) return;
    setBusy(true); setError('');
    try {
      await removeOfflineItem(revision.current, deleteTarget.kind, deleteTarget.key);
      if (!active.current || closedRef.current) return;
      setDeleteTarget(null); setNotice('本机条目已删除；服务器已经收到的消息不受影响。'); await load('content');
    } catch (cause) {
      if (cause instanceof APIError && cause.code === 'LOCAL_IDENTITY_CHANGED') closeIdentity();
      else if (active.current && !closedRef.current) setError(cause instanceof Error ? cause.message : '删除失败，请重试。');
    } finally { if (active.current) setBusy(false); }
  }
  return <div className="offline-recovery"><header className="offline-recovery-header"><Brand /><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} />返回连接页</button></header><main><header className="workspace-page-header"><div><h1><WifiOff size={24} />离线本机内容</h1><p>账号状态尚未验证，重新连接后确认身份再补发。</p></div><button className="primary-button" onClick={onReconnect}><RefreshCw size={16} />重新连接</button></header><div className="queue-explanation"><p>这里只显示此浏览器当前本机身份的待发消息和草稿，不包含服务器聊天历史，也不会自动发送。</p><p>已退出并选择保留的旧账号内容，需要重新登录对应账号后才能访问。</p></div>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}{loading && !snapshot && <p role="status">正在读取本机内容…</p>}{snapshot && !closed && <><p className="offline-identity">本机记录：<strong>{snapshot.identity.user.nickname}</strong> @{snapshot.identity.user.username}<span>账号状态未验证</span></p><section><h2>本机待发</h2>{snapshot.outbox.length ? <ul className="outbox-list">{snapshot.outbox.map((item) => <li className="outbox-card" key={item.key}><header><strong>{item.conversationTitle}</strong><span className="queue-state">上次状态：{item.state === 'queued' ? '等待投递' : item.state === 'sending' ? '等待服务器确认' : '发送失败'}</span></header><p className="outbox-message">{item.payload.text || '（没有正文）'}</p>{item.error && <p className="field-error">{item.error}</p>}<div className="outbox-meta">保存于 {new Date(item.createdAt).toLocaleString('zh-CN')}</div><footer><button className="secondary-button" disabled={busy} onClick={() => void copy(item.payload.text)}><Copy size={15} />复制正文</button><button className="text-button danger-text" disabled={busy} onClick={() => setDeleteTarget({ kind: 'outbox', key: item.key })}><Trash2 size={15} />删除本机条目</button></footer></li>)}</ul> : <p className="section-help">这个本机身份没有待发消息。</p>}</section><section><h2>本机草稿</h2>{snapshot.drafts.length ? <ul className="outbox-list">{snapshot.drafts.map((item) => <li className="outbox-card" key={item.key}><header><strong>{snapshot.outbox.find((pending) => pending.conversationId === item.conversationId)?.conversationTitle || '会话草稿'}</strong><time>{new Date(item.updatedAt).toLocaleString('zh-CN')}</time></header><p className="outbox-message">{item.text}</p><footer><button className="secondary-button" disabled={busy} onClick={() => void copy(item.text)}><Copy size={15} />复制草稿</button><button className="text-button danger-text" disabled={busy} onClick={() => setDeleteTarget({ kind: 'draft', key: item.key })}><Trash2 size={15} />删除本机草稿</button></footer></li>)}</ul> : <p className="section-help">这个本机身份没有已保存的草稿。</p>}{snapshot.nextDraftCursor && <button className="load-more-button" disabled={loading} onClick={() => void load('more', snapshot.nextDraftCursor!)}>{loading ? '正在加载…' : '加载更多草稿'}</button>}</section></>}{!loading && !snapshot && !closed && !error && <EmptyState title="没有可展示的本机内容" description="当前没有活跃的本机身份。请重新连接并登录后查看对应账号的内容。" />}{!loading && !snapshot && !closed && error && <button className="secondary-button" onClick={() => void load(initialized.current ? 'content' : 'initial')}>重新读取本机内容</button>}</main><Modal open={!!deleteTarget} title="删除本机内容" dismissible={!busy} onClose={() => setDeleteTarget(null)}><p>这会删除当前条目在本机的副本。不会撤回或删除服务器已经收到的消息，删除后无法从本机恢复。</p>{deleteTarget && error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除本机条目'}</button></Modal></div>;
}
