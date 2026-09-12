import { useEffect, useRef, useState } from 'react';
import { api, APIError } from './lib/api';
import type { UserView } from './auth-types';
import { Modal } from './components/Modal';
import { FormField } from './components/FormField';
type Preview = { coolingDays: number; ownedGroups: { id: string; name: string; status: 'active' | 'frozen' }[]; lastAdministrator: boolean; sharedMessagesRetained: true };
export function AccountDeletion({ user, onClose, onDeleted, onBeforeDelete, onDeleteFailed, onPreserveAndSignOut, onGetLocalSummary }: { user: UserView; onClose: () => void; onDeleted: (choice: 'keep' | 'delete') => Promise<void>; onBeforeDelete?: () => Promise<void>; onDeleteFailed?: () => void; onPreserveAndSignOut?: () => Promise<void>; onGetLocalSummary?: () => Promise<{ pending: number; drafts: number; taskDrafts: number }> }) {
  const [preview, setPreview] = useState<Preview | null>(null); const [reload, setReload] = useState(0); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(''); const [factor, setFactor] = useState(''); const [confirmation, setConfirmation] = useState(''); const [choice, setChoice] = useState<'' | 'keep' | 'delete'>(''); const [deleted, setDeleted] = useState(false); const confirmedDeleted = useRef(false);
  const submission = useRef<{ reauthToken: string; confirmation: string } | null>(null); const [uncertain, setUncertain] = useState(false); const [receiptExpired, setReceiptExpired] = useState(false);
  useEffect(() => { const controller = new AbortController(); setError(''); void api<Preview>('/api/v1/account/deletion-preview', { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setPreview(result); }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法加载注销影响。'); }); return () => controller.abort(); }, [reload]);
  const [localSummary, setLocalSummary] = useState<{ pending: number; drafts: number; taskDrafts: number } | null>(null); const [localError, setLocalError] = useState('');
  useEffect(() => { let active = true; setLocalSummary(null); setLocalError(''); if (onGetLocalSummary) void onGetLocalSummary().then((value) => { if (active) setLocalSummary(value); }).catch((cause) => { if (active) setLocalError(cause instanceof Error ? cause.message : '本机内容计数读取失败。'); }); return () => { active = false; }; }, [onGetLocalSummary, user.id, reload]);
  const blocked = !preview || preview.ownedGroups.length > 0 || preview.lastAdministrator;
  async function submit() {
    if (busy || receiptExpired || !choice || blocked || confirmation !== user.username) return;
    setBusy(true); setError(''); let sentDeletion = false; const wasUncertain = uncertain;
    try {
      if (!confirmedDeleted.current) {
        if (!submission.current) {
          await onBeforeDelete?.();
          const { reauthToken } = await api<{ reauthToken: string }>('/api/v1/auth/reauth', { method: 'POST', body: { password, action: 'account.delete', ...(factor ? { secondFactor: factor } : {}) } });
          submission.current = { reauthToken, confirmation };
        }
        sentDeletion = true;
        await api<{ deleted: true; recoverBefore: number }>('/api/v1/account/delete', { method: 'POST', body: submission.current });
        confirmedDeleted.current = true; submission.current = null; setDeleted(true); setUncertain(false); setPassword(''); setFactor('');
      }
      await onDeleted(choice);
    } catch (cause) {
      if (!confirmedDeleted.current) {
        if (wasUncertain && cause instanceof APIError && cause.status === 403) { setReceiptExpired(true); setUncertain(true); }
        else {
          const definite = !sentDeletion || (cause instanceof APIError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429);
          if (definite) { submission.current = null; setUncertain(false); onDeleteFailed?.(); } else setUncertain(true);
        }
      }
      setError(cause instanceof Error ? cause.message : '注销未能完成，请重试。');
    } finally { setBusy(false); }
  }
  return <Modal open title="注销账号" dismissible={!busy && !deleted && !uncertain} onClose={onClose}>{preview ? <><p className="warning-note">注销会立即停用账号并退出所有设备。{preview.coolingDays} 天冷静期内可使用账号恢复码恢复；到期后会清除凭据和非必要资料。</p><p>已经发送给他人的共享消息会保留，账号最终清理后显示为已注销身份。本机聊天草稿、任务草稿与待发消息由你选择保留或一起删除。恢复账号后，聊天待发可继续投递；任务草稿仍须本人联网核对并确认提交。</p>{preview.ownedGroups.length > 0 && <div role="status"><p>请先转让或解散以下群聊，再注销账号：</p><ul>{preview.ownedGroups.map((group) => <li key={group.id}>{group.name}{group.status === 'frozen' ? '（已冻结）' : ''}</li>)}</ul></div>}{preview.lastAdministrator && <p role="status">你是最后一位可用的超级管理员。请先配置另一位管理员。</p>}<>{localSummary && <p role="status">当前账号本机有 {localSummary.pending} 条待发消息、{localSummary.drafts} 份聊天草稿、{localSummary.taskDrafts} 份任务草稿。</p>}{localError && <p role="alert" className="form-error">本机内容计数未能读取：{localError}。请重新核对影响后再确认处理。</p>}</><form onSubmit={(event) => { event.preventDefault(); void submit(); }}><fieldset disabled={busy || deleted || uncertain || blocked}><FormField label="当前密码" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><FormField label="动态码或第二因素恢复码（管理员必填）" value={factor} onChange={(event) => setFactor(event.target.value)} autoComplete="off" /><FormField label={`输入登录名 ${user.username} 确认注销`} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /><label className="form-field">本机内容处理<select required value={choice} onChange={(event) => setChoice(event.target.value as typeof choice)}><option value="">请选择</option><option value="keep">保留本机内容，恢复账号后继续</option><option value="delete">删除此账号的聊天草稿、任务草稿与待发内容</option></select></label></fieldset>{error && <p role="alert" className="form-error">{error}</p>}{uncertain && <p className="warning-note" role="status">注销结果尚未确认。同步已暂停，本机内容尚未删除。{receiptExpired ? '核对凭据已失效，请保留本机内容并重新登录或使用账号恢复流程核对。' : '点击“核对注销结果”会继续核对同一份请求，不会重新验证或更改本机处理选择。'}</p>}{deleted && <p role="status">账号已注销，正在处理本机内容。失败时可重试完成本机处理。</p>}<button className="primary-button" disabled={busy || receiptExpired || blocked || !choice || (!deleted && !uncertain && (!password || confirmation !== user.username))}>{busy ? '正在处理…' : deleted ? '重试完成本机处理' : uncertain ? '核对注销结果' : '验证身份并注销账号'}</button></form>{receiptExpired && onPreserveAndSignOut && <button className="secondary-button" disabled={busy} onClick={() => { setBusy(true); void onPreserveAndSignOut().catch((cause) => setError(cause instanceof Error ? cause.message : '暂未能返回登录，请重试。')).finally(() => setBusy(false)); }}>保留本机内容并返回登录</button>}</> : error ? <p className="form-error" role="alert">{error}</p> : <p role="status">正在核对注销影响…</p>}{!deleted && !uncertain && <button className="text-button" disabled={busy} onClick={() => setReload((value) => value + 1)}>重新核对影响</button>}</Modal>;
}
