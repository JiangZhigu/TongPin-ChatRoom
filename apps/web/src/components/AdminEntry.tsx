import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import type { ChatClient } from '../lib/chat-client';

type Navigation = { admin: null | { href: '/admin' } };
type Authority = { userId: string; admin: Navigation['admin'] };

export function AdminEntry({ userId, online, client }: { userId: string; online: boolean; client: Pick<ChatClient, 'subscribeTaskEvents'> }) {
  const [authority, setAuthority] = useState<Authority | null>(null);
  useEffect(() => {
    let active = true; let revision = 0; let controller: AbortController | null = null;
    function refresh() {
      controller?.abort(); setAuthority(null);
      if (!online || !userId) return;
      const request = new AbortController(); controller = request; const requestRevision = ++revision;
      const current = () => active && !request.signal.aborted && requestRevision === revision;
      void api<Navigation>('/api/v1/account/navigation', { actorContext: userId, signal: request.signal }).then((data) => {
        if (!current()) return;
        setAuthority({ userId, admin: data?.admin?.href === '/admin' ? data.admin : null });
      }).catch(() => { if (current()) setAuthority(null); });
    }
    function accountChanged(event: Event) {
      if (event instanceof CustomEvent && event.detail?.userId === userId) refresh();
    }
    function visibilityChanged() { if (document.visibilityState === 'visible') refresh(); }
    window.addEventListener('tongpin:account-changed', accountChanged);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibilityChanged);
    const unsubscribe = client.subscribeTaskEvents((event) => { if (event.type === 'account.changed') refresh(); });
    refresh();
    return () => {
      active = false; controller?.abort(); unsubscribe();
      window.removeEventListener('tongpin:account-changed', accountChanged);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [userId, online, client]);
  if (!online || authority?.userId !== userId || !authority.admin) return null;
  return <a href={authority.admin.href} aria-label="管理入口"><ShieldCheck size={19} aria-hidden="true" /></a>;
}