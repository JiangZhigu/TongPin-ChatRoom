// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissInvitation, invitationLink, parseInvitation, readInvitation } from './invitation';
import { api } from './api';

const token = 'a'.repeat(43);
beforeEach(() => { dismissInvitation(); history.replaceState(null, '', '/'); vi.restoreAllMocks(); });
describe('invitation fragment and transport boundary', () => {
  it('removes the fragment while repeated StrictMode reads preserve only memory state', () => {
    history.replaceState(null, '', '/#invite=' + token);
    expect(readInvitation()).toBe(token); expect(location.hash).toBe(''); expect(readInvitation()).toBe(token);
    dismissInvitation(); expect(readInvitation()).toBeNull();
  });
  it('accepts same-origin links and tokens, excluding a different website and malformed values', () => {
    expect(parseInvitation(invitationLink(token))).toBe(token); expect(parseInvitation(token)).toBe(token);
    expect(parseInvitation('https://unrelated.invalid/#invite=' + token)).toBeNull(); expect(parseInvitation('short')).toBeNull();
  });
  it('sends the invite through a header without putting it in the URL or request body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: { state: 'available' } }) } as Response);
    await api('/api/v1/group-invites/preview', { inviteToken: token });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/group-invites/preview'); expect(request?.body).toBeUndefined();
    expect((request?.headers as Record<string, string>)['X-Group-Invite']).toBe(token);
  });
});
