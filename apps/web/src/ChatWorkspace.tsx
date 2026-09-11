import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, Clock3, RefreshCw, ShieldCheck, Wifi, WifiOff, X } from 'lucide-react';
import { api, APIError } from './lib/api';
import { ChatClient } from './lib/chat-client';
import type { Conversation, Message, QueuedMessage } from './lib/chat-types';
import type { UserView } from './auth-types';
import { AccountSettings } from './AccountSettings';
import { ContactsPage, type ContactsTab } from './ContactsPage';
import { NotificationsPage } from './NotificationsPage';
import { OfflineQueuePage } from './OfflineQueuePage';
import { CreateGroupDialog } from './CreateGroupDialog';
import { GroupInviteEntry } from './GroupInviteEntry';
import { GroupManagementPanel } from './GroupManagementPanel';
import { AppShell } from './components/AppShell';
import { ChatHeader } from './components/ChatHeader';
import { Composer } from './components/Composer';
import { ConversationList, type ConversationView } from './components/ConversationList';
import { EmptyState } from './components/EmptyState';
import { MessageTimeline, type MessageView } from './components/MessageTimeline';
import { Modal } from './components/Modal';
import type { MainSection } from './components/NavigationRail';
import './styles-chat.css';
import './styles-groups.css';

const describeError = (cause: unknown) => cause instanceof APIError ? [cause.message, ...Object.values(cause.fieldErrors || {}), cause.retryAfterMs ? `请在 ${Math.ceil(cause.retryAfterMs / 1000)} 秒后重试。` : ''].filter(Boolean).join(' ') : cause instanceof Error ? cause.message : '操作失败，请重试。';
const sequence = (value?: string | null) => { try { return BigInt(value || '0'); } catch { return 0n; } };
const shortTime = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const messageText = (message: Message) => message.status === 'recalled' ? '这条消息已撤回' : ['moderated', 'purged'].includes(message.status) ? '这条消息已不可用' : message.text || (message.attachments.length ? `[${message.attachments.length} 个附件]` : '');
type SavedPosition = { scrollTop: number; anchorId?: string; anchorOffset?: number; atBottom: boolean };
type LogoutPrompt = { pending: number; drafts: number };
function cancelledLogout() { const error = new Error('已取消退出。'); error.name = 'LogoutCancelled'; return error; }

export function ChatWorkspace({ user, onUserChange, onSignedOut, invitationToken, onInvitationDismiss }: { user: UserView; onUserChange: (user: UserView) => void; onSignedOut: () => void; invitationToken?: string | null; onInvitationDismiss?: () => void }) {
  const [client] = useState(() => new ChatClient(user));
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [section, setSection] = useState<MainSection>('messages'); const [contactsTab, setContactsTab] = useState<ContactsTab>('friends');
  const [selectedId, setSelectedId] = useState<string | null>(null); const selectedRef = useRef<string | null>(null);
  const [draft, setDraft] = useState(''); const draftRef = useRef(''); const draftReady = useRef(false);
  const draftRevision = useRef(new Map<string, number>()); const draftChain = useRef(Promise.resolve());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [draftLoading, setDraftLoading] = useState(false); const [draftNotice, setDraftNotice] = useState('');
  const [sending, setSending] = useState(false); const queueBusy = useRef(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [operationBusy, setOperationBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false); const [newMessages, setNewMessages] = useState(0);
  const [createGroupOpen, setCreateGroupOpen] = useState(false); const [joinGroupOpen, setJoinGroupOpen] = useState(false);
  const [jumpVersion, setJumpVersion] = useState(0); const forceJump = useRef(false);
  const [dismissedOnlineNotice, setDismissedOnlineNotice] = useState<string | null>(null);
  const [logoutPrompt, setLogoutPrompt] = useState<LogoutPrompt | null>(null); const [logoutBusy, setLogoutBusy] = useState(false); const [logoutError, setLogoutError] = useState('');
  const logoutResolver = useRef<{ resolve: () => void; reject: (cause: Error) => void } | null>(null);
  const mounted = useRef(false); const selectionGeneration = useRef(0);
  const selectionInFlight = useRef<number | null>(null); const [selectionSettled, setSelectionSettled] = useState(0);
  const confirmedSelection = useRef<{ id: string; title: string } | null>(null);
  const [revokedSelection, setRevokedSelection] = useState<{ id: string; title: string; saving: boolean } | null>(null);
  const viewport = useRef<HTMLElement | null>(null); const input = useRef<HTMLTextAreaElement | null>(null);
  const positions = useRef(new Map<string, SavedPosition>()); const restorePosition = useRef<{ id: string; position?: SavedPosition } | null>(null);
  const atBottom = useRef(true); const layout = useRef<{ id: string; height: number; lastSeq: string } | null>(null);
  const historyAnchor = useRef<{ id: string; height: number; top: number } | null>(null);
  const readRequests = useRef(new Map<string, string>());

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve(client.start()).catch((cause) => { if (mounted.current) setError(describeError(cause)); });
    return () => { mounted.current = false; selectionGeneration.current++; clearTimeout(draftTimer.current); client.stop(); logoutResolver.current?.reject(cancelledLogout()); logoutResolver.current = null; };
  }, [client]);
  useEffect(() => { client.updateUser(user); }, [client, user]);
  useEffect(() => { if (state.phase === 'expired') onSignedOut(); }, [state.phase, onSignedOut]);

  const selected = state.conversations.find((item) => item.id === selectedId);
  const showingCurrent = !!selectedId && state.selectedId === selectedId;
  const serverMessages = showingCurrent ? state.messages : [];

  function capturePosition(): SavedPosition | undefined {
    const element = viewport.current; const id = selectedRef.current;
    if (!element || !id) return id ? positions.current.get(id) : undefined;
    const top = element.getBoundingClientRect().top;
    const first = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find((node) => node.getBoundingClientRect().bottom > top + 2);
    const position = { scrollTop: element.scrollTop, anchorId: first?.dataset.messageId, anchorOffset: first ? first.getBoundingClientRect().top - top : undefined, atBottom: element.scrollHeight - element.scrollTop - element.clientHeight <= 32 };
    positions.current.set(id, position); return position;
  }
  function persistDraft(id: string, text: string, position?: SavedPosition) {
    const next = draftChain.current.catch(() => undefined).then(() => client.saveDraft(id, text, position ? { scrollTop: position.scrollTop, anchorId: position.anchorId } : undefined));
    draftChain.current = next;
    return next;
  }
  async function saveCurrentDraft() {
    clearTimeout(draftTimer.current);
    const id = selectedRef.current;
    if (!id || !draftReady.current) return;
    await persistDraft(id, draftRef.current, capturePosition());
  }
  function editDraft(text: string) {
    const id = selectedRef.current;
    setDraft(text); draftRef.current = text; setDraftNotice('');
    if (!id || !draftReady.current) return;
    const revision = (draftRevision.current.get(id) || 0) + 1; draftRevision.current.set(id, revision);
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      void persistDraft(id, text, capturePosition()).then(() => { if (mounted.current && selectedRef.current === id && draftRevision.current.get(id) === revision) setDraftNotice(text ? '草稿已保存到本机' : ''); }).catch((cause) => { if (mounted.current) { setDraftNotice('草稿未能保存到本机'); setError(describeError(cause)); } });
    }, 350);
  }
  useEffect(() => {
    const flush = () => { void saveCurrentDraft().catch((cause) => { if (mounted.current) setError(describeError(cause)); }); };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [client]);

  async function selectConversation(id: string | null): Promise<boolean> {
    const generation = ++selectionGeneration.current;
    selectionInFlight.current = generation;
    setError(''); setNotice(''); setDetailsOpen(false);
    try {
      await saveCurrentDraft();
      if (!mounted.current || generation !== selectionGeneration.current) return false;
      // A scroll caused by history removal can schedule another save while
      // the awaited transaction is running. It belongs to the outgoing editor.
      clearTimeout(draftTimer.current);
      selectedRef.current = id; setSelectedId(id); draftReady.current = false; draftRef.current = ''; setDraft(''); setDraftNotice(''); setDraftLoading(!!id); setNewMessages(0); setSection('messages'); layout.current = null; atBottom.current = true;
      const [, saved] = await Promise.all([client.selectConversation(id), id ? client.getDraft(id) : Promise.resolve(null)]);
      if (!mounted.current || generation !== selectionGeneration.current) return false;
      if (id) {
        const remembered = positions.current.get(id);
        let position: SavedPosition | undefined = remembered || (saved?.scrollTop !== undefined ? { scrollTop: saved.scrollTop, anchorId: saved.anchorId, atBottom: false } : undefined);
        // Server history is not stored permanently. Restore a saved anchor with
        // a bounded number of pages, leaving manual history loading available.
        if (position?.anchorId && !position.atBottom) {
          let pages = 0;
          while (pages < 8 && client.getSnapshot().historyBefore && !client.getSnapshot().messages.some((message) => message.id === position?.anchorId)) {
            await client.loadOlder(); pages++;
            if (!mounted.current || generation !== selectionGeneration.current) return false;
          }
          if (!client.getSnapshot().messages.some((message) => message.id === position?.anchorId)) {
            position = { scrollTop: 0, atBottom: false };
            setNotice('未能在当前已加载历史中定位上次阅读位置。你可以继续加载更早的消息。');
          }
        }
        restorePosition.current = { id, position };
        draftRef.current = saved?.text || ''; setDraft(draftRef.current); draftReady.current = true;
      }
      setDraftLoading(false); return true;
    } catch (cause) { if (mounted.current && generation === selectionGeneration.current) { setError(describeError(cause)); setDraftLoading(false); } return false; }
    finally { if (selectionInFlight.current === generation) { selectionInFlight.current = null; if (mounted.current) setSelectionSettled((value) => value + 1); } }
  }
  function returnFromRevoked(conversation: { id: string; title: string }) {
    // Reuse the same serialized draft save and selection-generation guard as
    // ordinary navigation. A later user selection must win this transition.
    const returning = selectConversation(null);
    const generation = selectionGeneration.current;
    setRevokedSelection({ ...conversation, saving: true });
    setNotice(`“${conversation.title}”的访问权限已失效，正在保存本机草稿。`);
    void returning.then((completed) => {
      if (!mounted.current || generation !== selectionGeneration.current) return;
      if (completed) { setRevokedSelection(null); setNotice(`“${conversation.title}”的访问权限已失效，已返回会话列表。本机草稿已保留。`); }
      else { setRevokedSelection({ ...conversation, saving: false }); setNotice('会话访问已失效。草稿暂未保存，仍保留在编辑器中，请重试保存后返回。'); }
    });
  }
  useEffect(() => {
    if (!selectedId) { confirmedSelection.current = null; return; }
    if (revokedSelection && revokedSelection.id !== selectedId) setRevokedSelection(null);
    if (selectionInFlight.current !== null || draftLoading || state.phase === 'expired') return;
    if (selected && state.selectedId === selectedId) { confirmedSelection.current = { id: selectedId, title: selected.title }; return; }
    // A list can be temporarily incomplete during snapshot/selection loading.
    // Only reconcile a previously opened conversation which core has cleared.
    const confirmed = confirmedSelection.current;
    if (confirmed?.id === selectedId && !selected && state.selectedId === null && !state.historyLoading && !revokedSelection) returnFromRevoked(confirmed);
  }, [selectedId, selected, state.selectedId, state.historyLoading, state.phase, draftLoading, selectionSettled, revokedSelection]);
  async function navigate(next: MainSection, tab?: ContactsTab) {
    if (next === section && !(tab && next === 'contacts')) return;
    const generation = ++selectionGeneration.current;
    try { await saveCurrentDraft(); if (!mounted.current || generation !== selectionGeneration.current) return; if (tab) setContactsTab(tab); if (next === 'messages' && selectedRef.current) restorePosition.current = { id: selectedRef.current, position: positions.current.get(selectedRef.current) }; setSection(next); setDetailsOpen(false); }
    catch (cause) { setError(`草稿保存失败，暂未切换页面。${describeError(cause)}`); }
  }
  async function perform(action: () => Promise<unknown>, success?: string) {
    if (operationBusy) return; setOperationBusy(true); setError('');
    try { await action(); if (mounted.current && success) setNotice(success); }
    catch (cause) { if (mounted.current) setError(describeError(cause)); }
    finally { if (mounted.current) setOperationBusy(false); }
  }
  async function openDirect(friendId: string) {
    const generation = ++selectionGeneration.current;
    const conversation = await api<Conversation>('/api/v1/conversations/direct', { method: 'POST', body: { friendUserId: friendId } });
    await client.refresh();
    if (!mounted.current || generation !== selectionGeneration.current) return;
    if (!await selectConversation(conversation.id)) throw new Error('会话或草稿未能加载，请重新打开。');
  }
  async function openGroup(id: string, details = false) {
    await client.refresh();
    if (!mounted.current) return;
    if (!await selectConversation(id)) throw new Error('群聊或草稿未能加载，请重新打开。');
    if (details) setDetailsOpen(true);
  }
  async function send() {
    const id = selectedRef.current; const text = draftRef.current;
    if (!id || !selected?.canSend || !draftReady.current || queueBusy.current || !text.trim() || Array.from(text).length > 4000 || new TextEncoder().encode(text).byteLength > 16384) return;
    const revision = draftRevision.current.get(id) || 0;
    queueBusy.current = true; setSending(true); setError(''); clearTimeout(draftTimer.current);
    try {
      await client.queue(id, text);
      if (!mounted.current) return;
      if ((draftRevision.current.get(id) || 0) === revision) {
        if (selectedRef.current === id) { draftRef.current = ''; setDraft(''); setDraftNotice(''); }
        await persistDraft(id, '', positions.current.get(id));
      }
      if (selectedRef.current === id) { forceJump.current = true; setJumpVersion((value) => value + 1); input.current?.focus(); }
    } catch (cause) { if (mounted.current) setError(describeError(cause)); }
    finally { queueBusy.current = false; if (mounted.current) setSending(false); }
  }
  async function copyToDraft(item: QueuedMessage) {
    if (!await selectConversation(item.conversationId)) throw new Error('未能打开原会话，待发消息已保留。');
    const text = draftRef.current ? `${draftRef.current}\n${item.payload.text}` : item.payload.text;
    editDraft(text); await saveCurrentDraft();
    setNotice('已复制到编辑器，原待发项仍保留。再次发送会创建一条新消息，请先确认原消息状态。'); input.current?.focus();
  }
  const reportRead = useCallback(() => {
    const element = viewport.current;
    if (!mounted.current || section !== 'messages' || !selectedId || state.selectedId !== selectedId || draftLoading || !atBottom.current || !element || element.scrollHeight - element.scrollTop - element.clientHeight > 32 || detailsOpen || createGroupOpen || joinGroupOpen || invitationToken || logoutPrompt || document.visibilityState !== 'visible' || !document.hasFocus() || document.querySelector('dialog[open]')) return;
    const last = state.messages.at(-1); if (!last || last.conversationId !== selectedId) return;
    const conversation = state.conversations.find((item) => item.id === selectedId);
    if (sequence(last.seq) <= sequence(conversation?.readSeq) || sequence(last.seq) <= sequence(readRequests.current.get(selectedId))) return;
    readRequests.current.set(selectedId, last.seq);
    void client.read(selectedId, last.seq).catch((cause) => { if (readRequests.current.get(selectedId) === last.seq) readRequests.current.delete(selectedId); if (mounted.current) setError(describeError(cause)); });
  }, [client, section, selectedId, state.selectedId, state.messages, state.conversations, draftLoading, detailsOpen, createGroupOpen, joinGroupOpen, invitationToken, logoutPrompt]);
  useEffect(() => { window.addEventListener('focus', reportRead); document.addEventListener('visibilitychange', reportRead); return () => { window.removeEventListener('focus', reportRead); document.removeEventListener('visibilitychange', reportRead); }; }, [reportRead]);
  function scrolled() {
    const position = capturePosition(); const id = selectedRef.current;
    if (position) { atBottom.current = position.atBottom; if (position.atBottom) setNewMessages(0); }
    if (id && draftReady.current) {
      const text = draftRef.current; const generation = selectionGeneration.current; const revision = draftRevision.current.get(id) || 0;
      clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        // Never combine an old conversation ID with a later editor's content,
        // nor restore a submitted draft after send cleared that editor.
        if (selectedRef.current !== id || !draftReady.current || selectionGeneration.current !== generation || draftRef.current !== text || (draftRevision.current.get(id) || 0) !== revision) return;
        void persistDraft(id, text, position).catch((cause) => { if (mounted.current) setError(`阅读位置未能保存到本机。${describeError(cause)}`); });
      }, 350);
    }
    reportRead();
  }
  async function loadOlder() {
    if (!selectedId || state.historyLoading || !state.historyBefore) return;
    const element = viewport.current;
    if (element) historyAnchor.current = { id: selectedId, height: element.scrollHeight, top: element.scrollTop };
    try { await client.loadOlder(); } catch (cause) { historyAnchor.current = null; setError(describeError(cause)); }
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !selectedId || section !== 'messages' || !showingCurrent || draftLoading) return;
    const lastSeq = serverMessages.at(-1)?.seq || '0';
    const restoration = restorePosition.current;
    if (restoration?.id === selectedId) {
      if (!restoration.position || restoration.position.atBottom) element.scrollTop = element.scrollHeight;
      else {
        const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find((node) => node.dataset.messageId === restoration.position?.anchorId);
        element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - (restoration.position.anchorOffset || 0) : restoration.position.scrollTop;
      }
      restorePosition.current = null;
    } else if (historyAnchor.current?.id === selectedId) {
      if (!state.historyLoading) { element.scrollTop = historyAnchor.current.top + element.scrollHeight - historyAnchor.current.height; historyAnchor.current = null; }
    } else if (forceJump.current || atBottom.current || !layout.current || layout.current.id !== selectedId) {
      element.scrollTop = element.scrollHeight; forceJump.current = false;
    } else if (sequence(lastSeq) > sequence(layout.current.lastSeq)) {
      const count = serverMessages.filter((message) => sequence(message.seq) > sequence(layout.current!.lastSeq)).length;
      if (count) setNewMessages((value) => value + count);
    }
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
    if (atBottom.current) setNewMessages(0);
    layout.current = { id: selectedId, height: element.scrollHeight, lastSeq };
    capturePosition(); reportRead();
  }, [selectedId, section, showingCurrent, serverMessages, state.outbox, state.historyLoading, draftLoading, jumpVersion, reportRead]);

  async function requestLogout() {
    await saveCurrentDraft();
    const summary = await client.getLocalSummary();
    if (!summary.pending && !summary.drafts) { await client.logout('keep'); return; }
    setLogoutError(''); setLogoutPrompt(summary);
    return new Promise<void>((resolve, reject) => { logoutResolver.current = { resolve, reject }; });
  }
  function cancelLogout() { if (logoutBusy) return; setLogoutPrompt(null); logoutResolver.current?.reject(cancelledLogout()); logoutResolver.current = null; }
  async function completeLogout(choice: 'keep' | 'delete') {
    if (logoutBusy) return; setLogoutBusy(true); setLogoutError('');
    try { await client.logout(choice); setLogoutPrompt(null); logoutResolver.current?.resolve(); logoutResolver.current = null; }
    catch (cause) { setLogoutError(describeError(cause)); }
    finally { if (mounted.current) setLogoutBusy(false); }
  }
  async function changeConversationPreference(key: keyof Conversation['preferences'], value: boolean) {
    if (!selected) return;
    await api(`/api/v1/conversations/${encodeURIComponent(selected.id)}/preferences`, { method: 'PATCH', body: { [key]: value } }); await client.refresh();
  }
  const conversationViews: ConversationView[] = useMemo(() => state.conversations.map((conversation) => ({ id: conversation.id, title: conversation.title, preview: conversation.lastMessage ? messageText(conversation.lastMessage) : '还没有消息', timeLabel: conversation.lastMessage ? shortTime(conversation.lastMessage.createdAt) : undefined, unreadCount: conversation.unreadCount, unreadLabel: conversation.unreadCount ? String(conversation.unreadCount) : undefined, pinned: conversation.preferences.pinned, muted: conversation.preferences.muted, archived: conversation.preferences.archived, online: conversation.peer?.online })).sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned)), [state.conversations]);
  const visibleMessages: MessageView[] = serverMessages.map((message) => ({ id: message.id, author: message.sender?.nickname || '系统', own: message.senderId === user.id, system: message.kind === 'system', text: messageText(message), tombstone: message.status !== 'sent', timeLabel: shortTime(message.createdAt), statusLabel: message.senderId === user.id && message.status === 'sent' ? selected?.kind === 'direct' && selected.peerReadSeq !== null && sequence(selected.peerReadSeq) >= sequence(message.seq) ? '已读' : '已发送' : undefined, quote: message.status === 'sent' && message.reply ? message.reply.status === 'available' ? `${message.reply.author}：${message.reply.text}` : '引用的原消息不可用' : undefined }));
  for (const item of state.outbox.filter((message) => message.conversationId === selectedId && !serverMessages.some((server) => server.clientMessageId === message.payload.clientMessageId))) visibleMessages.push({ id: `pending:${item.payload.clientMessageId}`, author: user.nickname, own: true, text: item.payload.text, timeLabel: shortTime(item.createdAt), statusLabel: item.state === 'queued' ? '已存本机 · 等待投递' : item.state === 'sending' ? '发送中 · 等待服务器确认' : '发送失败', error: item.error || undefined, actions: <>{item.state !== 'sending' && <button disabled={operationBusy} onClick={() => void perform(() => client.retry(item.payload.clientMessageId))}>重试</button>}<button disabled={operationBusy} onClick={() => void perform(() => client.cancel(item.payload.clientMessageId), '已停止本机重试，不会撤回服务器已收到的消息。')}>停止本机重试</button></> });
  const connection = { connecting: ['正在连接', '正在连接聊天服务。'], syncing: ['正在同步', '正在更新消息与权限。'], online: ['已连接', '消息与权限持续同步。'], degraded: ['实时连接中断', '正通过 HTTP 同步，消息可能稍有延迟。'], offline: ['当前离线', '消息可先保存到本机，恢复网络后继续投递。'], expired: ['登录已失效', '请重新登录后继续。'] }[state.phase];
  const activeNotificationCount = state.notificationCount;
  const contactsProps = { contacts: state.contacts, requests: state.requests, nextContacts: state.nextContacts, nextRequests: state.nextRequests, onRefresh: () => client.refresh(), onOpenConversation: openDirect, onLoadMoreContacts: () => client.loadMoreContacts(), onLoadMoreRequests: () => client.loadMoreRequests() };
  let content: React.ReactNode;
  if (section === 'contacts') content = <ContactsPage key={contactsTab} {...contactsProps} initialTab={contactsTab} />;
  else if (section === 'notifications') content = <NotificationsPage items={state.notifications} hasMore={!!state.nextNotifications} onLoadMore={() => client.loadMoreNotifications()} onRefresh={() => client.refresh()} onOpenRequests={() => void navigate('contacts', 'requests')} onOpenGroup={(id) => openGroup(id, true)} />;
  else if (section === 'queue') content = <OfflineQueuePage items={state.outbox} onRetry={(id) => client.retry(id)} onCancel={(id) => client.cancel(id)} onCopyToDraft={copyToDraft} />;
  else if (section === 'settings') content = <AccountSettings user={user} onUserChange={onUserChange} onSignedOut={onSignedOut} onLogout={requestLogout} />;
  return <div className="chat-workspace"><div className={`connection-bar ${state.phase}`} role="status"><span className="connection-copy">{state.phase === 'offline' ? <WifiOff size={15} /> : state.phase === 'online' ? <Wifi size={15} /> : <RefreshCw size={15} />}<strong>{connection[0]}</strong><span>{connection[1]}</span></span><button className="text-button" disabled={operationBusy} onClick={() => void perform(() => client.refresh())}>重新同步</button>{state.outbox.length > 0 && <button className="text-button" onClick={() => void navigate('queue')}><Clock3 size={14} />本机待发 {state.outbox.length}</button>}</div>{(error || state.error) && <div className="workspace-error" role="alert"><span>{error || state.error}</span>{error && <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button>}</div>}{notice && <div className="workspace-notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭操作提示" onClick={() => setNotice('')}><X size={16} /></button></div>}{state.onlineNotice && state.onlineNotice.id !== dismissedOnlineNotice && <div className="online-notice" role="status"><span>{state.onlineNotice.user.nickname} 上线了</span><button className="text-button" onClick={() => setDismissedOnlineNotice(state.onlineNotice!.id)}>关闭</button></div>}<AppShell conversations={conversationViews} selectedId={selectedId || undefined} onSelectConversation={(id) => void selectConversation(id)} activeSection={section} onNavigate={(next) => void navigate(next)} badges={{ messages: state.conversations.filter((item) => !item.preferences.muted).reduce((sum, item) => sum + item.unreadCount, 0), contacts: state.requests.filter((item) => item.direction === 'incoming' && item.status === 'pending').length, notifications: activeNotificationCount, queue: state.outbox.length }} listContent={<ConversationList conversations={conversationViews} selectedId={selectedId || undefined} onSelect={(id) => void selectConversation(id)} onAdd={() => void navigate('contacts', 'search')} onCreateGroup={() => setCreateGroupOpen(true)} onJoinGroup={() => setJoinGroupOpen(true)} hasMore={!!state.nextConversations} loading={operationBusy} onLoadMore={() => void perform(() => client.loadMoreConversations())} />} accountFooter={<div className="account-footer"><span className="avatar">{user.nickname.slice(0, 1)}</span><div><strong>{user.nickname}</strong><small>@{user.username}</small></div><a href="/admin" aria-label="管理入口"><ShieldCheck size={19} /></a></div>} sectionContent={content}>{selectedId ? <><ChatHeader group={selected?.kind === 'group'} title={revokedSelection?.id === selectedId ? '会话访问已失效' : selected?.title || '正在加载会话'} description={selected?.peer ? selected.peer.online ? '在线' : '未显示在线' : selected?.description} onBack={() => void selectConversation(null)} onToggleDetails={selected ? () => setDetailsOpen(true) : undefined} detailsOpen={detailsOpen} /><div className="timeline-container"><MessageTimeline messages={visibleMessages} viewportRef={viewport} onScroll={scrolled} hasOlder={showingCurrent && !!state.historyBefore} loading={state.historyLoading || draftLoading} onLoadOlder={() => void loadOlder()} />{newMessages > 0 && <button className="new-messages-button" onClick={() => { forceJump.current = true; setJumpVersion((value) => value + 1); }}><ArrowDown size={15} />{newMessages} 条新消息</button>}</div>{revokedSelection?.id === selectedId && <button className="load-more-button" disabled={revokedSelection.saving} onClick={() => returnFromRevoked(revokedSelection)}>{revokedSelection.saving ? '正在保存草稿并返回…' : '重试保存草稿并返回'}</button>}{!draftLoading && !draftReady.current && <button className="load-more-button" onClick={() => void selectConversation(selectedId)}>重新加载会话和草稿</button>}<Composer value={draft} onChange={editDraft} onSend={() => void send()} sending={sending} inputRef={input} disabledReason={draftLoading ? '正在加载会话草稿…' : !draftReady.current ? '会话或草稿尚未就绪' : !selected?.canSend ? selected?.sendDisabledReason || '当前会话不允许发送新消息，草稿已保留。' : undefined} notice={state.phase === 'offline' ? '离线发送将保存到本机' : draftNotice || undefined} /></> : <EmptyState title="欢迎来到同频" description="选择一段会话继续交流，或添加好友开始新的对话。" action={<button className="primary-button" onClick={() => void navigate('contacts', 'search')}>查找好友</button>} />}</AppShell>{createGroupOpen && <CreateGroupDialog friends={state.contacts} hasMore={!!state.nextContacts} onLoadMore={() => client.loadMoreContacts()} onClose={() => setCreateGroupOpen(false)} onCreated={openGroup} />}{(joinGroupOpen || invitationToken) && <GroupInviteEntry key={invitationToken || 'manual'} token={invitationToken} userId={user.id} onClose={() => { setJoinGroupOpen(false); onInvitationDismiss?.(); }} onOpenGroup={async (id) => { await openGroup(id); setJoinGroupOpen(false); onInvitationDismiss?.(); }} />}{detailsOpen && selected?.kind === 'group' && <GroupManagementPanel key={selected.id} conversationId={selected.id} userId={user.id} friends={state.contacts} hasMoreFriends={!!state.nextContacts} onLoadMoreFriends={() => client.loadMoreContacts()} onClose={() => setDetailsOpen(false)} onRefresh={() => client.refresh()} onBeforeLeave={saveCurrentDraft} onLeft={async () => { await client.refresh(); await selectConversation(null); }} ><section aria-label="群会话偏好">{([{ key: 'pinned', label: '置顶会话' }, { key: 'muted', label: '消息免打扰' }, { key: 'archived', label: '归档会话' }] as const).map(({ key, label }) => <label className="preference-row" key={key}><strong>{label}</strong><input type="checkbox" checked={selected.preferences[key]} disabled={operationBusy} onChange={(event) => void perform(() => changeConversationPreference(key, event.target.checked))} /></label>)}</section></GroupManagementPanel>}<Modal open={detailsOpen && selected?.kind !== 'group'} title="会话设置" dismissible={!operationBusy} onClose={() => setDetailsOpen(false)}>{selected && <><div className="contact-detail"><span className="avatar">{selected.title.slice(0, 1)}</span><h3>{selected.title}</h3>{selected.peer && <p>@{selected.peer.username}</p>}</div>{([{ key: 'pinned', label: '置顶会话', help: '在会话列表优先显示。' }, { key: 'muted', label: '消息免打扰', help: '保留未读记录，减少提醒。' }, { key: 'archived', label: '归档会话', help: '会话移入“已归档”，不会删除消息。' }] as const).map(({ key, label, help }) => <label className="preference-row" key={key}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={selected.preferences[key]} disabled={operationBusy} onChange={(event) => void perform(() => changeConversationPreference(key, event.target.checked))} /></label>)}{!selected.canSend && <p className="warning-note">{selected.sendDisabledReason || '当前会话不能发送新消息。'}</p>}{detailsOpen && error && <p className="form-error" role="alert">{error}</p>}</>}</Modal><Modal open={!!logoutPrompt} title="退出前，处理本机内容" dismissible={!logoutBusy} onClose={cancelLogout}><p>当前账号在本机有 {logoutPrompt?.pending} 条待发消息、{logoutPrompt?.drafts} 份草稿。其他账号不会看到这些内容。</p><p>保留后可在下次登录此账号时继续；删除只影响本机内容，不删除服务器已经收到的消息。</p>{logoutError && <p className="form-error" role="alert">{logoutError}</p>}<div className="logout-options"><button className="primary-button" disabled={logoutBusy} onClick={() => void completeLogout('keep')}>保留，待下次登录继续</button><button className="secondary-button danger-text" disabled={logoutBusy} onClick={() => void completeLogout('delete')}>删除本机内容并退出</button><button className="text-button" disabled={logoutBusy} onClick={cancelLogout}>取消退出</button></div></Modal></div>;
}
