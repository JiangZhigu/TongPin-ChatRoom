import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { parseInvitation } from './lib/invitation';
import type { GroupApplication, InvitePreview } from './lib/group-types';
import { Modal } from './components/Modal';

export const applicationLabel = (status: GroupApplication['status']) => ({ pending: '等待管理员审核', approved: '申请已批准', rejected: '申请已拒绝', cancelled: '申请已取消', expired: '申请已过期', already_member: '你已是群成员' })[status];
const previewLabel = (state: InvitePreview['state']) => ({ available: '可以申请加入', expired: '邀请已过期', revoked: '邀请已撤销', exhausted: '邀请名额已用完', full: '群成员已满', already_member: '你已是群成员', pending: '申请正在审核中', unavailable: '邀请暂不可用' })[state];

export function GroupInviteEntry({ token: initialToken, userId, onClose, onSignIn, onOpenGroup }: { token?: string | null; userId: string | null; onClose: () => void; onSignIn?: () => void; onOpenGroup: (id: string) => Promise<void> }) {
  const [input, setInput] = useState(''); const [token, setToken] = useState(initialToken || ''); const [preview, setPreview] = useState<InvitePreview | null>(null); const [result, setResult] = useState<GroupApplication | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [retry, setRetry] = useState(0); const attempt = useRef<string | null>(null); const active = useRef(false);
  const [uncertain, setUncertain] = useState(false); const uncertainAttempt = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { attempt.current = null; uncertainAttempt.current = false; setUncertain(false); setResult(null); }, [token, userId]);
  useEffect(() => {
    if (!token) return; const controller = new AbortController(); setPreview(null); setError(''); setBusy(true);
    void api<InvitePreview>('/api/v1/group-invites/preview', { inviteToken: token, signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setPreview(value); setResult(value.application);
      // A successful preview replaces known application/member state, even
      // with null. It cannot prove which UUID an uncertain write used.
      if (!uncertainAttempt.current && !value.application) attempt.current = null;
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '邀请预览加载失败'); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [token, userId, retry]);
  async function apply(newRequest = false) {
    if (!preview || !userId || busy) return; setBusy(true); setError('');
    if (newRequest) { attempt.current = crypto.randomUUID(); setResult(null); } else attempt.current ??= crypto.randomUUID();
    uncertainAttempt.current = true; setUncertain(true);
    try { const application = await api<GroupApplication>(`/api/v1/group-invites/${encodeURIComponent(preview.inviteId)}/apply`, { method: 'POST', body: { clientRequestId: attempt.current }, inviteToken: token }); if (active.current) { setResult(application); uncertainAttempt.current = false; setUncertain(false); } }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '申请结果未确认，请使用同一请求重试。'); }
    finally { if (active.current) setBusy(false); }
  }
  async function open() { if (!preview || busy) return; setBusy(true); setError(''); try { await onOpenGroup(preview.conversationId); } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '群聊打开失败'); } finally { if (active.current) setBusy(false); } }
  const canOpen = !!userId && (result?.currentMember || preview?.state === 'already_member');
  const canReapply = !uncertain && preview?.state === 'available' && result && !result.currentMember && result.status !== 'pending';
  const resultNotice = canOpen ? '你已是群成员，可以打开群聊。' : result && !uncertain ? `${result.status === 'already_member' ? '此前已加入群聊' : applicationLabel(result.status)}${['approved', 'already_member'].includes(result.status) && !result.currentMember ? '，当前已不在群中。' : '。'}` : '';
  return <Modal open title="加入群聊" onClose={onClose} dismissible={!busy}><div className="group-invite-entry">{!token ? <form className="group-form" onSubmit={(event) => { event.preventDefault(); const parsed = parseInvitation(input); setInput(''); if (!parsed) setError('请输入本站有效的群邀请链接或邀请码。'); else { setError(''); setToken(parsed); } }}><label>群邀请链接或邀请码<textarea value={input} onChange={(event) => setInput(event.target.value)} autoComplete="off" required /></label><button className="primary-button">查看群邀请</button></form> : <>{busy && !preview && <p role="status">正在加载邀请预览…</p>}{preview && <><div className="group-summary"><span className="avatar">{preview.name.slice(0, 1)}</span><h3>{preview.name}</h3><p>{preview.description || '暂无群简介'}</p><span>{preview.memberCount} 位成员 · 剩余 {preview.remaining} 个名额</span></div><p>{canOpen ? '本次入群已确认' : previewLabel(preview.state)}{!canOpen && <> · {preview.requiresApproval ? '加入需要管理员审核' : '确认后可加入'}</>}</p><p className="field-hint">有效期至 {new Date(preview.expiresAt).toLocaleString('zh-CN')}。加入后只能查看本次加入以后的消息；重新加入不会恢复旧记录。</p>{resultNotice && <p role="status">{resultNotice}</p>}{canOpen ? <button className="primary-button" disabled={busy} onClick={() => void open()}>打开群聊</button> : !userId ? <><p>登录或按站点规则完成注册后，再明确提交申请。登录不会自动加入群聊。</p>{onSignIn && <button className="primary-button" disabled={busy} onClick={onSignIn}>登录或注册后继续</button>}</> : uncertain ? <><p className="field-hint">上次提交的结果尚未确认。重试会确认同一次申请，刷新不会创建新申请。</p><button className="primary-button" disabled={busy} onClick={() => void apply()}>{busy ? '正在确认…' : '重试同一次申请'}</button></> : canReapply ? <><p className="field-hint">上次申请已结束。再次申请会提交一个新请求，按当前入群规则处理。</p><button className="primary-button" disabled={busy} onClick={() => void apply(true)}>再次申请加入</button></> : preview.state === 'available' && !result && <button className="primary-button" disabled={busy} onClick={() => void apply()}>{busy ? '正在提交…' : '确认申请加入'}</button>}<button className="text-button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>刷新邀请状态</button></>}{!preview && !busy && <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试加载邀请</button>}</>}{error && <p className="form-error" role="alert">{error}</p>}</div></Modal>;
}
