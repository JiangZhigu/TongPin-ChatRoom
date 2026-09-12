import { useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, APIError } from '../lib/api';
import { AdminContext, errorText, queryPath } from './AdminShared';

export function useSensitiveRead<T>() {
  const { deny, revision } = useContext(AdminContext); const controller = useRef<AbortController | null>(null); const generation = useRef(0); const mounted = useRef(false);
  const [data, setData] = useState<T | undefined>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; controller.current?.abort(); }; }, [revision]);
  function clear() { generation.current++; controller.current?.abort(); setData(undefined); setError(''); setBusy(false); }
  async function read(path: string, body: Record<string, unknown>) {
    controller.current?.abort(); const request = new AbortController(); controller.current = request; const current = ++generation.current; setData(undefined); setError(''); setBusy(true);
    try { const result = await api<T>(path, { method: 'POST', body, signal: request.signal }); if (!mounted.current || request.signal.aborted || generation.current !== current) return; setData(result); return result; }
    catch (cause) { if (!mounted.current || request.signal.aborted || generation.current !== current) return; if (cause instanceof APIError && (cause.status === 401 || cause.status === 403)) { clear(); deny(); } else setError(errorText(cause)); }
    finally { if (mounted.current && generation.current === current && !request.signal.aborted) setBusy(false); }
  }
  return { data, error, busy, read, clear };
}

export function SensitiveReadForm({ busy, children, onSubmit, label = '填写理由并读取' }: { busy: boolean; children?: ReactNode; onSubmit: (body: Record<string, unknown>) => void; label?: string }) {
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const body: Record<string, unknown> = {}; for (const [key, value] of new FormData(event.currentTarget)) if (typeof value === 'string' && value.trim()) body[key] = value.trim(); if (typeof body.reason !== 'string' || body.reason.length < 3) { setError('读取理由至少需要 3 个字符。'); return; } for (const key of ['fromAt', 'until']) if (body[key]) { const value = new Date(String(body[key])).getTime(); if (!Number.isFinite(value)) { setError('请选择有效时间。'); return; } body[key] = value; } setError(''); onSubmit(body); }
  return <form className="admin-sensitive-form" onSubmit={submit}><fieldset disabled={busy}>{children}<label className="form-field">读取理由<textarea name="reason" minLength={3} maxLength={500} required autoComplete="off" /></label><p className="field-hint">敏感搜索词与读取理由仅保存在当前页面内存中。离开页面后需要重新填写。</p>{error && <p role="alert" className="form-error">{error}</p>}<button className="primary-button">{busy ? '正在受控读取…' : label}</button></fieldset></form>;
}
export function SensitiveState({ busy, error }: { busy: boolean; error: string }) { return <>{busy && <p role="status">正在核验权限并读取…</p>}{error && <p role="alert" className="form-error">{error} 请检查筛选和读取理由后重试。</p>}</>; }
export function safeSearchLocation(path: string, body: Record<string, unknown>, id?: string) { const safe = new URLSearchParams(); for (const key of ['senderId', 'ownerId', 'conversationId', 'kind', 'status', 'state', 'governance', 'fromAt', 'until', 'after']) if (body[key] !== undefined && body[key] !== '') safe.set(key, String(body[key])); if (id) safe.set('id', id); window.history.replaceState({}, '', queryPath(path, safe)); }
export function dateInput(value: string | null) { if (!value || !Number.isFinite(Number(value))) return ''; const date = new Date(Number(value)); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
