import { useRef, useState } from 'react';
import { api, APIError } from './lib/api';
import type { ReportItem, ReportTarget } from './lib/interactions-types';
import { Modal } from './components/Modal';

export function ReportDialog({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const [category, setCategory] = useState('spam'); const [description, setDescription] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState<ReportItem | null>(null);
  const submission = useRef<{ clientReportId: string; targetKind: ReportTarget['kind']; targetId: string; category: string; description: string } | null>(null); const locked = !!submission.current;
  async function submit() {
    if (busy) return; if (!submission.current) submission.current = { clientReportId: crypto.randomUUID(), targetKind: target.kind, targetId: target.id, category, description };
    setBusy(true); setError('');
    try { const result = await api<{ report: ReportItem }>('/api/v1/reports', { method: 'POST', body: submission.current }); setDone(result.report); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '提交结果尚未确认。'); if (cause instanceof APIError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429) submission.current = null; }
    finally { setBusy(false); }
  }
  return <Modal open title="举报" dismissible={!busy} onClose={onClose}>{done ? <><p role="status">举报已提交，可在账号设置的“我的举报”查看处理进度。</p><p>举报编号：{done.id}</p><button className="primary-button" onClick={onClose}>完成</button></> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}><p>举报对象：{target.label}</p><fieldset disabled={busy || locked}><label className="form-field">举报类别<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="spam">垃圾信息</option><option value="harassment">骚扰</option><option value="illegal">违法内容</option><option value="other">其他</option></select></label><label className="form-field">情况说明<textarea value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} /></label><p className="field-hint">最多 1,000 字。请避免填写与举报无关的个人资料。</p></fieldset>{error && <p className="form-error" role="alert">{error}</p>}{locked && <p className="warning-note">提交结果尚未确认，重试将继续核对同一份举报；内容暂时锁定。</p>}<button className="primary-button" disabled={busy}>{busy ? '正在提交…' : locked ? '重试同一份举报' : '提交举报'}</button></form>}</Modal>;
}
