import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AvatarEditor } from './AvatarEditor';
import { FormField } from './components/FormField';
import { api, APIError } from './lib/api';
import type { UserView } from './auth-types';

const messageOf = (cause: unknown) => cause instanceof APIError
  ? [cause.message, ...Object.values(cause.fieldErrors || {}), cause.retryAfterMs ? `请在 ${Math.ceil(cause.retryAfterMs / 1000)} 秒后重试。` : ''].filter(Boolean).join(' ')
  : cause instanceof Error ? cause.message : '操作失败，请重试。';

type ProfileSettingsProps = { user: UserView; onUserChange: (user: UserView) => void; onBusyChange?: (busy: boolean) => void };

// Remount the draft editor for a different identity, retaining drafts across updates to this user's avatar.
export function ProfileSettings(props: ProfileSettingsProps) {
  const identity = useRef(props.user.id); identity.current = props.user.id;
  return <ProfileEditor key={props.user.id} {...props} isCurrentAccount={() => identity.current === props.user.id} />;
}

function ProfileEditor({ user, onUserChange, onBusyChange, isCurrentAccount }: ProfileSettingsProps & { isCurrentAccount: () => boolean }) {
  const [nickname, setNickname] = useState(user.nickname);
  const [bio, setBio] = useState(user.bio);
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const saveInFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const callbacks = useRef({ onUserChange, isCurrentAccount });
  callbacks.current = { onUserChange, isCurrentAccount };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  const busy = saving || avatarBusy;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (saveInFlight.current || avatarBusy || !callbacks.current.isCurrentAccount()) return;
    const controller = new AbortController(); request.current = controller; saveInFlight.current = true;
    const current = () => mounted.current && !controller.signal.aborted && request.current === controller && callbacks.current.isCurrentAccount();
    setSaving(true); setError(''); setNotice(''); setFields({});
    try {
      const data = await api<{ user: UserView }>('/api/v1/account/profile', { method: 'PATCH', body: { nickname, bio }, signal: controller.signal, actorContext: user.id });
      if (!current()) return;
      if (!data.user || data.user.id !== user.id) throw new Error('返回账号与当前账号不一致，请重新核对。');
      callbacks.current.onUserChange(data.user); setNickname(data.user.nickname); setBio(data.user.bio); setNotice('个人资料已保存。');
    } catch (cause) {
      if (current()) { setError(messageOf(cause)); if (cause instanceof APIError) setFields(cause.fieldErrors || {}); }
    } finally {
      if (current()) { saveInFlight.current = false; request.current = null; setSaving(false); }
    }
  }

  async function saveAvatar(attachmentId: string | null, signal: AbortSignal) {
    if (saveInFlight.current) throw new Error('个人资料正在保存，请稍后重试头像。');
    if (!mounted.current || signal.aborted || !callbacks.current.isCurrentAccount()) return;
    const updated = await api<{ user: UserView }>('/api/v1/me/avatar', { method: 'PUT', body: { attachmentId }, signal, actorContext: user.id });
    if (!mounted.current || signal.aborted || !callbacks.current.isCurrentAccount()) return;
    if (!updated.user || updated.user.id !== user.id) throw new Error('返回账号与当前账号不一致，请重新核对。');
    callbacks.current.onUserChange(updated.user);
  }

  return <div className="profile-settings">
    <AvatarEditor key={user.id} actorContext={user.id} label={user.nickname} avatarUrl={user.avatarUrl} purpose="user_avatar" disabled={saving} onSave={saveAvatar} onBusyChange={setAvatarBusy} />
    <p className="field-hint">用户名：{user.username}</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status" className="success-note">{notice}</p>}
    <form onSubmit={(event) => void saveProfile(event)}>
      <fieldset disabled={busy}>
        <FormField label="昵称" value={nickname} onChange={(event) => setNickname(event.target.value)} required error={fields.nickname} />
        <label className="form-field bio-field">个人简介<textarea value={bio} onChange={(event) => setBio(event.target.value)} aria-invalid={!!fields.bio} /></label>
        {fields.bio && <p className="field-error">{fields.bio}</p>}
        <button className="primary-button" type="submit">{saving ? '正在保存…' : '保存资料'}</button>
      </fieldset>
    </form>
  </div>;
}
