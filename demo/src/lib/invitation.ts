import { demoPath, demoSearch } from '../sandbox/navigation';
let pendingToken: string | null = null;
const tokenPattern = /^[A-Za-z0-9_-]{40,128}$/;

export function parseInvitation(value: string): string | null {
  const trimmed = value.trim();
  if (tokenPattern.test(trimmed)) return trimmed;
  try { const url = new URL(trimmed, window.location.href); const token = new URLSearchParams(url.hash.slice(1)).get('invite'); return url.origin === window.location.origin && token && tokenPattern.test(token) ? token : null; }
  catch { return null; }
}

// Keep this outside component initialization so StrictMode's repeated reads do
// not consume the fragment twice. Nothing is written to browser storage.
export function readInvitation(): string | null {
  if (window.location.hash.startsWith('#invite=')) {
    pendingToken = parseInvitation(window.location.href);
    window.history.replaceState(window.history.state, '', demoPath().split('?')[0] + demoSearch());
  }
  return pendingToken;
}

export function dismissInvitation(): void { pendingToken = null; }
export function invitationLink(token: string): string { if (!tokenPattern.test(token)) throw new Error('邀请链接无效。'); return window.location.href.split('#')[0] + '#invite=' + token; }
