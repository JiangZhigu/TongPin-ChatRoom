import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, Clock3, RefreshCw, ShieldCheck, Wifi, WifiOff, X } from 'lucide-react';
import { api, APIError } from './lib/api';
import { ChatClient } from './lib/chat-client';
import { TaskClient } from './lib/tasks-client';
import type { TaskMeta, TaskSnapshot } from './lib/tasks-types';
import { TaskWorkspace, TaskDetail, TaskForm, TaskCardView, type TaskSourcePreview } from './tasks';
import { useTaskResource, useTaskState } from './tasks/TaskShared';
import type { Conversation, LocalAttachment, Message, QueuedMessage } from './lib/chat-types';
import type { MessageLocation } from './lib/interactions-types';
import { prepareLocalFiles, validateLocalFiles } from './lib/files';
import { Avatar } from './AttachmentViews';
import { FilesPage } from './FilesPage';
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
import { MessageActions } from './MessageActions';
import { MessageSearchPage } from './MessageSearchPage';
import { ReportsPage } from './ReportsPage';
import { ReportDialog } from './ReportDialog';
import type { ReportTarget } from './lib/interactions-types';
import './styles-rich.css';
import { Composer, emptyComposerContext, type ComposerContext } from './components/Composer';
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
const messageText = (message: Message) => message.taskCard && message.status === 'sent' ? '[待办卡片]' : message.status === 'recalled' ? '这条消息已撤回' : ['moderated', 'purged'].includes(message.status) ? '这条消息已不可用' : message.text || (message.attachments.length ? `[${message.attachments.length} 个附件]` : '');
type SavedPosition = { scrollTop: number; anchorId?: string; anchorOffset?: number; atBottom: boolean };
type CommittedContext = { replies: Set<string>; mentions: Set<string>; mentionAll: boolean };
const remainingContext = (value: ComposerContext, sent: CommittedContext): ComposerContext => ({ replyToMessageId: value.replyToMessageId && !sent.replies.has(value.replyToMessageId) ? value.replyToMessageId : null, mentionedUserIds: value.mentionedUserIds.filter((id) => !sent.mentions.has(id)), mentionAll: value.mentionAll && !sent.mentionAll });
type LogoutPrompt = { pending: number; drafts: number; taskDrafts: number };
type TaskPanel = { kind: 'detail'; taskId: string } | { kind: 'form'; initialGroupId?: string; source?: TaskSourcePreview; snapshot?: { messageId: string; value: TaskSnapshot } };
function cancelledLogout() { const error = new Error('已取消退出。'); error.name = 'LogoutCancelled'; return error; }

export function ChatWorkspace({ user, onUserChange, onSignedOut, invitationToken, onInvitationDismiss }: { user: UserView; onUserChange: (user: UserView) => void; onSignedOut: () => void; invitationToken?: string | null; onInvitationDismiss?: () => void }) {
  const [client] = useState(() => new ChatClient(user));
  const getLocalSummary = useCallback(() => client.getLocalSummary(), [client]);
  const [taskClient] = useState(() => new TaskClient(user.id, client));
  const taskState = useTaskState(taskClient);
  const taskMetaResource = useTaskResource(useCallback(() => taskClient.meta(), [taskClient]), taskState.online);
  const [lastTaskMeta, setLastTaskMeta] = useState<TaskMeta | null>(null);
  const taskMeta = taskMetaResource.data || lastTaskMeta;
  useEffect(() => { if (taskMetaResource.data?.actorId === user.id) setLastTaskMeta(taskMetaResource.data); }, [taskMetaResource.data, user.id]);
  const [taskPanel, setTaskPanel] = useState<TaskPanel | null>(null); const [taskOpening, setTaskOpening] = useState(false); const [taskGroupId, setTaskGroupId] = useState<string | undefined>();
  const taskObscured = useRef(false); const taskOpeningGeneration = useRef(0);
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const taskSource = taskPanel?.kind === 'form' ? taskPanel.source : undefined;
  const sourceMessageId = taskSource?.messageId; const sourceConversationId = taskSource?.conversationId;
  const [sourceAttempt, setSourceAttempt] = useState(0); const sourceGeneration = useRef(0);
  const sourceOnline = state.phase === 'online' || state.phase === 'degraded';
  useEffect(() => {
    if (!sourceMessageId || !sourceConversationId) return;
    let active = true; let controller: AbortController | null = null;
    const update = (value: Partial<TaskSourcePreview>) => setTaskPanel((current) => current?.kind === 'form' && current.source?.messageId === sourceMessageId && current.source.conversationId === sourceConversationId ? { ...current, source: { ...current.source, ...value } } : current);
    const refresh = (read = true) => {
      const generation = ++sourceGeneration.current; controller?.abort(); controller = null;
      update({ text: '', available: false, revision: generation });
      if (!read || !sourceOnline) return;
      const request = new AbortController(); controller = request;
      void api<MessageLocation>(`/api/v1/messages/${encodeURIComponent(sourceMessageId)}/context`, { actorContext: user.id, signal: request.signal }).then((location) => {
        if (!active || request.signal.aborted || generation !== sourceGeneration.current) return;
        const message = location.items.find((item) => item.id === sourceMessageId);
        const available = location.targetId === sourceMessageId && location.conversation.id === sourceConversationId && message?.conversationId === sourceConversationId && message.status === 'sent' && message.kind === 'user' && !message.taskCard;
        update({ text: available ? message.text : '', available: !!available, revision: generation });
      }).catch(() => { /* The cleared preview remains unavailable until an explicit retry or a newer authority event. */ });
    };
    const unsubscribe = client.subscribeTaskEvents((event) => {
      if (event.type === 'message.updated' && event.entityRef === sourceMessageId) refresh();
      else if (event.type === 'access.revoked' && event.conversationId === sourceConversationId) refresh(false);
      else if (event.type === 'account.changed' || event.type === 'conversation.updated' && event.conversationId === sourceConversationId) refresh();
    });
    refresh();
    return () => { active = false; sourceGeneration.current++; controller?.abort(); unsubscribe(); };
  }, [client, user.id, sourceMessageId, sourceConversationId, sourceAttempt, sourceOnline]);
  const [section, setSection] = useState<MainSection>('messages'); const [contactsTab, setContactsTab] = useState<ContactsTab>('friends');
  const [selectedId, setSelectedId] = useState<string | null>(null); const selectedRef = useRef<string | null>(null);
  const [draft, setDraft] = useState(''); const draftRef = useRef(''); const draftReady = useRef(false);
  const [draftFiles, setDraftFiles] = useState<LocalAttachment[]>([]); const draftFilesRef = useRef<LocalAttachment[]>([]); const [fileError, setFileError] = useState('');
  const draftRevision = useRef(new Map<string, number>()); const draftChain = useRef(Promise.resolve());
  const textRevision = useRef(new Map<string, number>());
  const committedDrafts = useRef(new Map<string, { files: Set<string>; textRevision: number; contextRevision: number; context: CommittedContext; savedDraftRevision: number }>());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [context, setContext] = useState<ComposerContext>(emptyComposerContext); const contextRef = useRef<ComposerContext>(emptyComposerContext()); const contextRevision = useRef(new Map<string, number>());
  const [replyLabel, setReplyLabel] = useState(''); const [searchOpen, setSearchOpen] = useState(false); const [reportsOpen, setReportsOpen] = useState(false); const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const contextHistoryEnd = useRef<{ id: string; seq: string } | null>(null);
  const targetToLocate = useRef<string | null>(null); const [locatedId, setLocatedId] = useState<string | null>(null);
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
    mounted.current = true; taskClient.start();
    void Promise.resolve(client.start()).catch((cause) => { if (mounted.current) setError(describeError(cause)); });
    return () => { mounted.current = false; selectionGeneration.current++; clearTimeout(draftTimer.current); taskOpeningGeneration.current++; taskClient.stop(); client.stop(); logoutResolver.current?.reject(cancelledLogout()); logoutResolver.current = null; };
  }, [client, taskClient]);
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
  function persistDraft(id: string, text: string, position?: SavedPosition, files: LocalAttachment[] = draftFilesRef.current) {
    const revision = textRevision.current.get(id) || 0;
    const rich = { ...contextRef.current, mentionedUserIds: [...contextRef.current.mentionedUserIds] };
    const fullRevision = draftRevision.current.get(id) || 0;
    const next = draftChain.current.catch(() => undefined).then(async () => {
      // A save captured before a queue commit may run after it. Normalize at
      // execution time, not only in the editor, so transferred blobs stay out.
      const committed = committedDrafts.current.get(id);
      // Reconciliation may already have persisted a newer text+files snapshot.
      // An older queued write must not regress either part of that snapshot.
      if (committed && fullRevision < committed.savedDraftRevision) return;
      await client.saveDraft(id, committed && revision <= committed.textRevision ? '' : text, { ...(committed ? remainingContext(rich, committed.context) : rich), ...(position ? { scrollTop: position.scrollTop, anchorId: position.anchorId } : {}), files: committed ? files.filter((file) => !committed.files.has(file.id)) : files });
      if (committed) committed.savedDraftRevision = Math.max(committed.savedDraftRevision, fullRevision);
    });
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
    setDraft(text); draftRef.current = text; setDraftNotice(''); client.typing?.(!!text.trim());
    if (!id || !draftReady.current) return;
    textRevision.current.set(id, (textRevision.current.get(id) || 0) + 1);
    const revision = (draftRevision.current.get(id) || 0) + 1; draftRevision.current.set(id, revision); const files = draftFilesRef.current;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (selectedRef.current !== id || !draftReady.current || draftRevision.current.get(id) !== revision) return;
      void persistDraft(id, text, capturePosition(), files).then(() => { if (mounted.current && selectedRef.current === id && draftRevision.current.get(id) === revision) setDraftNotice(text || files.length ? '草稿已保存到本机' : ''); }).catch((cause) => { if (mounted.current) { setDraftNotice('草稿未能保存到本机'); setError(describeError(cause)); } });
    }, 350);
  }
  function editContext(next: ComposerContext) {
    const id = selectedRef.current; if (!id || !draftReady.current) return;
    contextRef.current = next; setContext(next); contextRevision.current.set(id, (contextRevision.current.get(id) || 0) + 1); draftRevision.current.set(id, (draftRevision.current.get(id) || 0) + 1); clearTimeout(draftTimer.current);
    void persistDraft(id, draftRef.current, capturePosition()).catch((cause) => { if (mounted.current) setError(describeError(cause)); });
  }
  useEffect(() => { const id = context.replyToMessageId; const request = new AbortController(); if (!id) { setReplyLabel(''); return; } const live = serverMessages.find((message) => message.id === id); const label = (message: Message) => message.status === 'sent' ? `${message.sender?.nickname || '已注销账号'}：${message.text || '附件消息'}` : '原消息已不可用'; if (live) setReplyLabel(label(live)); else { setReplyLabel('正在核对原消息…'); void api<{ message: Message }>(`/api/v1/messages/${encodeURIComponent(id)}`, { signal: request.signal }).then((result) => { if (!request.signal.aborted) setReplyLabel(label(result.message)); }).catch(() => { if (!request.signal.aborted) setReplyLabel('原消息不可用'); }); } return () => request.abort(); }, [context.replyToMessageId, serverMessages]);
  function editFiles(files: LocalAttachment[]) {
    const id = selectedRef.current; if (!id || !draftReady.current) return;
    try { validateLocalFiles(files); } catch (cause) { setFileError(describeError(cause)); return; }
    draftFilesRef.current = files; setDraftFiles(files); setFileError(''); setDraftNotice('正在保存附件草稿…');
    const revision = (draftRevision.current.get(id) || 0) + 1; draftRevision.current.set(id, revision); clearTimeout(draftTimer.current);
    void persistDraft(id, draftRef.current, capturePosition(), files).then(() => {
      if (mounted.current && selectedRef.current === id && draftRevision.current.get(id) === revision) setDraftNotice(draftRef.current || files.length ? '草稿已保存到本机' : '');
    }).catch((cause) => { if (mounted.current && selectedRef.current === id) { setDraftNotice('附件尚未保存到本机，请保留此页面并重试'); setFileError(describeError(cause)); } });
  }
  function addFiles(files: File[]) { try { editFiles([...draftFilesRef.current, ...prepareLocalFiles(files)]); } catch (cause) { setFileError(describeError(cause)); } }
  useEffect(() => {
    const flush = () => { void saveCurrentDraft().catch((cause) => { if (mounted.current) setError(describeError(cause)); }); };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [client, taskClient]);

  async function selectConversation(id: string | null, positionMode: 'restore' | 'latest' = 'restore'): Promise<boolean> {
    if (positionMode === 'latest' && (!navigator.onLine || !['online', 'degraded'].includes(client.getSnapshot().phase))) { setError('请等待连接恢复后再返回最新消息，当前阅读位置和草稿已保留。'); return false; }
    const generation = ++selectionGeneration.current;
    selectionInFlight.current = generation;
    setError(''); setNotice(''); setDetailsOpen(false); setSearchOpen(false); setReportsOpen(false); setLocatedId(null); contextHistoryEnd.current = null; targetToLocate.current = null; client.typing?.(false);
    try {
      await saveCurrentDraft();
      if (!mounted.current || generation !== selectionGeneration.current) return false;
      // A scroll caused by history removal can schedule another save while
      // the awaited transaction is running. It belongs to the outgoing editor.
      clearTimeout(draftTimer.current);
      selectedRef.current = id; setSelectedId(id); draftReady.current = false; draftRef.current = ''; setDraft(''); draftFilesRef.current = []; setDraftFiles([]); contextRef.current = emptyComposerContext(); setContext(contextRef.current); setFileError(''); setDraftNotice(''); setDraftLoading(!!id); setNewMessages(0); setSection('messages'); layout.current = null; atBottom.current = true;
      const [, saved] = await Promise.all([client.selectConversation(id), id ? client.getDraft(id) : Promise.resolve(null)]);
      if (!mounted.current || generation !== selectionGeneration.current) return false;
      if (id) {
        const remembered = positions.current.get(id);
        let position: SavedPosition | undefined = positionMode === 'latest' ? { scrollTop: 0, atBottom: true } : remembered || (saved?.scrollTop !== undefined ? { scrollTop: saved.scrollTop, anchorId: saved.anchorId, atBottom: false } : undefined);
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
        textRevision.current.set(id, (textRevision.current.get(id) || 0) + 1);
        contextRevision.current.set(id, (contextRevision.current.get(id) || 0) + 1); contextRef.current = { replyToMessageId: saved?.replyToMessageId || null, mentionedUserIds: saved?.mentionedUserIds || [], mentionAll: saved?.mentionAll || false }; setContext(contextRef.current);
        draftRef.current = saved?.text || ''; setDraft(draftRef.current); draftFilesRef.current = saved?.files || []; setDraftFiles(draftFilesRef.current); draftReady.current = true;
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
  async function openTaskPanel(next: TaskPanel) {
    const generation = ++taskOpeningGeneration.current; taskObscured.current = true; setTaskOpening(true); capturePosition(); client.typing?.(false);
    try {
      await saveCurrentDraft();
      if (!mounted.current || generation !== taskOpeningGeneration.current) return;
      const meta = taskState.online ? await taskClient.meta() : taskMeta;
      if (!meta || meta.actorId !== user.id || !meta.enabled) throw new Error('待办功能当前不可用，请联网后重新核对。');
      if (next.kind === 'detail') await taskClient.get(next.taskId);
      if (!mounted.current || generation !== taskOpeningGeneration.current) return;
      setLastTaskMeta(meta); setTaskPanel(next.kind === 'form' && next.source ? { ...next, source: { ...next.source, text: '', available: false, revision: ++sourceGeneration.current } } : next);
    } catch (cause) { if (mounted.current && generation === taskOpeningGeneration.current) { taskObscured.current = !!taskPanel; setError(describeError(cause)); } }
    finally { if (mounted.current && generation === taskOpeningGeneration.current) setTaskOpening(false); }
  }
  function closeTaskPanel() {
    taskOpeningGeneration.current++; taskObscured.current = false; setTaskOpening(false); setTaskPanel(null);
    if (selectedRef.current) restorePosition.current = { id: selectedRef.current, position: positions.current.get(selectedRef.current) };
    setJumpVersion((value) => value + 1);
  }
  async function openTaskSource(messageId: string) {
    await jumpToMessage(messageId);
    if (mounted.current) { taskOpeningGeneration.current++; taskObscured.current = false; setTaskPanel(null); setTaskOpening(false); }
  }
  async function openGroupTasks(groupId: string) { setTaskGroupId(groupId); await navigate('tasks'); }
  async function navigate(next: MainSection, tab?: ContactsTab) {
    if (next === section && !(tab && next === 'contacts')) return;
    if (next === 'tasks') { taskObscured.current = true; capturePosition(); client.typing?.(false); }
    const generation = ++selectionGeneration.current;
    try { await saveCurrentDraft(); if (!mounted.current || generation !== selectionGeneration.current) return; if (tab) setContactsTab(tab); if (next === 'messages' && selectedRef.current) restorePosition.current = { id: selectedRef.current, position: positions.current.get(selectedRef.current) }; setSection(next); taskOpeningGeneration.current++; setTaskPanel(null); setTaskOpening(false); taskObscured.current = false; setSearchOpen(false); setReportsOpen(false); setDetailsOpen(false); client.typing?.(false); }
    catch (cause) { taskObscured.current = !!taskPanel; setError(`草稿保存失败，暂未切换页面。${describeError(cause)}`); }
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
    const id = selectedRef.current; const text = draftRef.current; const files = draftFilesRef.current; const rich = contextRef.current; const richRevision = id ? contextRevision.current.get(id) || 0 : 0;
    if (!id || !selected?.canSend || !draftReady.current || queueBusy.current || (!text.trim() && !files.length) || Array.from(text).length > 4000 || new TextEncoder().encode(text).byteLength > 16384) return;
    const revision = textRevision.current.get(id) || 0;
    queueBusy.current = true; setSending(true); setError(''); clearTimeout(draftTimer.current);
    try {
      // Earlier draft writes finish before the atomic transfer; later writes
      // wait for it and discard only the files/text revision actually sent.
      const submission = draftChain.current.catch(() => undefined).then(async () => {
        await client.queue(id, text, { files, ...rich });
        const previous = committedDrafts.current.get(id);
        const committed = { files: new Set([...(previous?.files || []), ...files.map((file) => file.id)]), textRevision: Math.max(previous?.textRevision ?? -1, revision), contextRevision: Math.max(previous?.contextRevision ?? -1, richRevision), context: { replies: new Set([...(previous?.context.replies || []), ...(rich.replyToMessageId ? [rich.replyToMessageId] : [])]), mentions: new Set([...(previous?.context.mentions || []), ...rich.mentionedUserIds]), mentionAll: !!previous?.context.mentionAll || rich.mentionAll }, savedDraftRevision: previous?.savedDraftRevision ?? -1 };
        committedDrafts.current.set(id, committed);
        if (!mounted.current) return;
        const current = selectedRef.current === id && draftReady.current;
        const saved = current ? { text: draftRef.current, files: draftFilesRef.current, ...contextRef.current } : await client.getDraft(id);
        if (!saved) return;
        const remainingFiles = (saved.files || []).filter((file) => !committed.files.has(file.id));
        const remainingText = (textRevision.current.get(id) || 0) > committed.textRevision ? saved.text : '';
        const leftoverContext = remainingContext({ replyToMessageId: saved.replyToMessageId || null, mentionedUserIds: saved.mentionedUserIds || [], mentionAll: saved.mentionAll || false }, committed.context);
        if (current) {
          contextRef.current = leftoverContext; setContext(leftoverContext); client.typing?.(false);
          clearTimeout(draftTimer.current); draftRevision.current.set(id, (draftRevision.current.get(id) || 0) + 1);
          draftRef.current = remainingText; setDraft(remainingText); draftFilesRef.current = remainingFiles; setDraftFiles(remainingFiles); setFileError(''); setDraftNotice('');
        }
        const position = positions.current.get(id);
        const savedRevision = draftRevision.current.get(id) || 0;
        await client.saveDraft(id, remainingText, { ...leftoverContext, ...(position ? { scrollTop: position.scrollTop, anchorId: position.anchorId } : {}), files: remainingFiles });
        if (current) committed.savedDraftRevision = Math.max(committed.savedDraftRevision, savedRevision);
      });
      draftChain.current = submission;
      await submission;
      if (!mounted.current) return;
      if (selectedRef.current === id) { forceJump.current = true; setJumpVersion((value) => value + 1); input.current?.focus(); }
    } catch (cause) { if (mounted.current) setError(describeError(cause)); }
    finally {
      // Only already captured writes need this filter. Drop its file IDs once
      // that tail drains, without removing a newer submission's filter.
      const committed = committedDrafts.current.get(id);
      if (committed) void draftChain.current.catch(() => undefined).then(() => { if (committedDrafts.current.get(id) === committed) committedDrafts.current.delete(id); });
      queueBusy.current = false; if (mounted.current) setSending(false);
    }
  }
  async function copyToDraft(item: QueuedMessage) {
    if (!await selectConversation(item.conversationId)) throw new Error('未能打开原会话，待发消息已保留。');
    const text = draftRef.current ? `${draftRef.current}\n${item.payload.text}` : item.payload.text;
    const files = [...draftFilesRef.current, ...item.files.map((file) => ({ ...file, id: crypto.randomUUID(), attachmentId: undefined, phase: undefined, error: undefined }))];
    validateLocalFiles(files); draftFilesRef.current = files; setDraftFiles(files);
    editContext({ replyToMessageId: item.payload.replyToMessageId || null, mentionedUserIds: item.payload.mentionedUserIds || [], mentionAll: item.payload.mentionAll || false }); editDraft(text); await saveCurrentDraft();
    setNotice('已复制到编辑器，原待发项仍保留。再次发送会创建一条新消息，请先确认原消息状态。'); input.current?.focus();
  }
  const reportRead = useCallback(() => {
    const element = viewport.current;
    if (taskObscured.current || taskPanel || taskOpening || !mounted.current || !draftReady.current || selectionInFlight.current !== null || state.historyAfter || searchOpen || reportsOpen || section !== 'messages' || !selectedId || state.selectedId !== selectedId || draftLoading || !atBottom.current || !element || element.scrollHeight - element.scrollTop - element.clientHeight > 32 || detailsOpen || createGroupOpen || joinGroupOpen || invitationToken || logoutPrompt || document.visibilityState !== 'visible' || !document.hasFocus() || document.querySelector('dialog[open]')) return;
    const last = state.messages.at(-1); if (!last || last.conversationId !== selectedId) return;
    const conversation = state.conversations.find((item) => item.id === selectedId);
    if (sequence(last.seq) <= sequence(conversation?.readSeq) || sequence(last.seq) <= sequence(readRequests.current.get(selectedId))) return;
    readRequests.current.set(selectedId, last.seq);
    void client.read(selectedId, last.seq).catch((cause) => { if (readRequests.current.get(selectedId) === last.seq) readRequests.current.delete(selectedId); if (mounted.current) setError(describeError(cause)); });
  }, [client, section, selectedId, state.selectedId, state.messages, state.conversations, draftLoading, detailsOpen, createGroupOpen, joinGroupOpen, invitationToken, logoutPrompt, state.historyAfter, searchOpen, reportsOpen, taskPanel, taskOpening]);
  useEffect(() => { window.addEventListener('focus', reportRead); document.addEventListener('visibilitychange', reportRead); return () => { window.removeEventListener('focus', reportRead); document.removeEventListener('visibilitychange', reportRead); }; }, [reportRead]);
  function scrolled() {
    const position = capturePosition(); const id = selectedRef.current;
    if (position) { atBottom.current = position.atBottom; if (position.atBottom) setNewMessages(0); }
    if (id && draftReady.current) {
      const text = draftRef.current; const files = draftFilesRef.current; const generation = selectionGeneration.current; const revision = draftRevision.current.get(id) || 0;
      clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        // Never combine an old conversation ID with a later editor's content,
        // nor restore a submitted draft after send cleared that editor.
        if (selectedRef.current !== id || !draftReady.current || selectionGeneration.current !== generation || draftRef.current !== text || draftFilesRef.current !== files || (draftRevision.current.get(id) || 0) !== revision) return;
        void persistDraft(id, text, position, files).catch((cause) => { if (mounted.current) setError(`阅读位置未能保存到本机。${describeError(cause)}`); });
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
    if (!element || !selectedId || section !== 'messages' || !showingCurrent || draftLoading || !draftReady.current) return;
    const lastSeq = serverMessages.at(-1)?.seq || '0';
    const target = targetToLocate.current;
    if (target) { const node = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find((item) => item.dataset.messageId === target); if (node) { element.scrollTop += node.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 3; targetToLocate.current = null; restorePosition.current = null; atBottom.current = false; forceJump.current = false; layout.current = { id: selectedId, height: element.scrollHeight, lastSeq }; return; } }
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
      // Context pages contain messages that already existed when locating.
      // Keep that fixed boundary even if a live event advances conversation.lastSeq
      // while a page is pending, so only genuinely later arrivals count.
      const historicalEnd = contextHistoryEnd.current?.id === selectedId ? sequence(contextHistoryEnd.current.seq) : 0n;
      const count = serverMessages.filter((message) => sequence(message.seq) > sequence(layout.current!.lastSeq) && sequence(message.seq) > historicalEnd).length;
      if (count) setNewMessages((value) => value + count);
    }
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
    if (atBottom.current) setNewMessages(0);
    layout.current = { id: selectedId, height: element.scrollHeight, lastSeq };
    capturePosition(); reportRead();
  }, [selectedId, section, showingCurrent, serverMessages, state.outbox, state.historyLoading, draftLoading, jumpVersion, reportRead]);

  async function jumpToMessage(id: string) {
    const generation = ++selectionGeneration.current; await saveCurrentDraft(); if (!mounted.current || generation !== selectionGeneration.current) return;
    clearTimeout(draftTimer.current); client.typing?.(false); setDraftLoading(true);
    try { await client.jumpToMessage(id); if (!mounted.current || generation !== selectionGeneration.current) return; const nextId = client.getSnapshot().selectedId; if (!nextId) throw new Error('无法定位消息。'); const saved = await client.getDraft(nextId); if (!mounted.current || generation !== selectionGeneration.current) return;
      selectedRef.current = nextId; setSelectedId(nextId); draftRef.current = saved?.text || ''; setDraft(draftRef.current); draftFilesRef.current = saved?.files || []; setDraftFiles(draftFilesRef.current); contextRef.current = { replyToMessageId: saved?.replyToMessageId || null, mentionedUserIds: saved?.mentionedUserIds || [], mentionAll: saved?.mentionAll || false }; setContext(contextRef.current); textRevision.current.set(nextId, (textRevision.current.get(nextId) || 0) + 1); contextRevision.current.set(nextId, (contextRevision.current.get(nextId) || 0) + 1); draftReady.current = true; contextHistoryEnd.current = { id: nextId, seq: client.getSnapshot().conversations.find((item) => item.id === nextId)?.lastSeq || client.getSnapshot().messages.at(-1)?.seq || '0' }; targetToLocate.current = id; setLocatedId(id); setSearchOpen(false); setSection('messages'); setDetailsOpen(false); restorePosition.current = null; forceJump.current = false; atBottom.current = false; setJumpVersion((value) => value + 1);
    } finally { if (mounted.current && generation === selectionGeneration.current) setDraftLoading(false); }
  }
  useEffect(() => { const open = (event: Event) => { const detail = (event as CustomEvent<{ userId?: string; messageId?: string }>).detail; if (detail?.userId === user.id && typeof detail.messageId === 'string') void jumpToMessage(detail.messageId).catch((cause) => { if (mounted.current) setError(describeError(cause)); }); }; window.addEventListener('tongpin:open-message', open); return () => window.removeEventListener('tongpin:open-message', open); }, [client, user.id]);
  async function openSearch() { await saveCurrentDraft(); if (mounted.current) { client.typing?.(false); setSearchOpen(true); setReportsOpen(false); } }
  async function requestLogout() {
    await saveCurrentDraft();
    const summary = await client.getLocalSummary();
    if (!summary.pending && !summary.drafts && !summary.taskDrafts) {
      taskOpeningGeneration.current++; setTaskPanel(null); taskClient.stop();
      try { await client.logout('keep'); } catch (cause) { if (mounted.current && client.getSnapshot().phase !== 'expired') taskClient.start(); throw cause; }
      return;
    }
    setLogoutError(''); setLogoutPrompt(summary);
    return new Promise<void>((resolve, reject) => { logoutResolver.current = { resolve, reject }; });
  }
  function cancelLogout() { if (logoutBusy) return; setLogoutPrompt(null); logoutResolver.current?.reject(cancelledLogout()); logoutResolver.current = null; }
  async function completeLogout(choice: 'keep' | 'delete') {
    if (logoutBusy) return; setLogoutBusy(true); setLogoutError('');
    taskOpeningGeneration.current++; setTaskPanel(null); taskClient.stop();
    try { await client.logout(choice); setLogoutPrompt(null); logoutResolver.current?.resolve(); logoutResolver.current = null; }
    catch (cause) { if (mounted.current && client.getSnapshot().phase !== 'expired') taskClient.start(); setLogoutError(describeError(cause)); }
    finally { if (mounted.current) setLogoutBusy(false); }
  }
  async function changeConversationPreference(key: keyof Conversation['preferences'], value: boolean) {
    if (!selected) return;
    await api(`/api/v1/conversations/${encodeURIComponent(selected.id)}/preferences`, { method: 'PATCH', body: { [key]: value } }); await client.refresh();
  }
  const conversationViews: ConversationView[] = useMemo(() => state.conversations.map((conversation) => ({ id: conversation.id, title: conversation.title, avatarUrl: conversation.avatarUrl, preview: conversation.lastMessage ? messageText(conversation.lastMessage) : '还没有消息', timeLabel: conversation.lastMessage ? shortTime(conversation.lastMessage.createdAt) : undefined, unreadCount: conversation.unreadCount, unreadLabel: conversation.unreadCount ? String(conversation.unreadCount) : undefined, pinned: conversation.preferences.pinned, muted: conversation.preferences.muted, archived: conversation.preferences.archived, online: conversation.peer?.online })).sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned)), [state.conversations]);
  const visibleMessages: MessageView[] = serverMessages.map((message) => ({ id: message.id, author: message.sender?.nickname || '系统', own: message.senderId === user.id, system: message.kind === 'system', text: message.taskCard && message.status === 'sent' ? '[待办卡片]' : message.status === 'sent' && message.attachments.length ? message.text : messageText(message), taskCard: message.status === 'sent' && message.taskCard ? <TaskCardView client={taskClient} messageId={message.id} onOpenTask={(taskId) => void openTaskPanel({ kind: 'detail', taskId })} onSaveSnapshot={(snapshot) => void openTaskPanel({ kind: 'form', snapshot })} /> : undefined, attachments: message.status === 'sent' ? message.attachments : [], avatarUrl: message.sender?.avatarUrl, tombstone: message.status !== 'sent', timeLabel: shortTime(message.createdAt), statusLabel: message.senderId === user.id && message.status === 'sent' ? selected?.kind === 'direct' && selected.peerReadSeq !== null && sequence(selected.peerReadSeq) >= sequence(message.seq) ? '已读' : '已发送' : undefined, located: message.id === locatedId, onQuote: message.reply?.status === 'available' ? () => void perform(() => jumpToMessage(message.reply!.id)) : undefined, actions: <MessageActions message={message.taskCard ? { ...message, text: '' } : message} onCreateTask={taskState.enabled && !message.taskCard ? () => openTaskPanel({ kind: 'form', source: { messageId: message.id, conversationId: message.conversationId, text: message.text } }) : undefined} userId={user.id} onBeginUpdate={() => client.beginMessageUpdate()} onBookmarked={(id, bookmarked, token) => client.applyBookmark(id, bookmarked, token)} onUpdated={(updated, token) => client.applyMessage(updated, token)} onReply={() => { editContext({ ...contextRef.current, replyToMessageId: message.id }); input.current?.focus(); }} />, quote: message.status === 'sent' && message.reply ? message.reply.status === 'available' ? `${message.reply.author}：${message.reply.text}` : '引用的原消息不可用' : undefined }));
  for (const item of state.outbox.filter((message) => message.conversationId === selectedId && !serverMessages.some((server) => server.clientMessageId === message.payload.clientMessageId))) visibleMessages.push({ id: `pending:${item.payload.clientMessageId}`, author: user.nickname, own: true, text: item.payload.text, localFiles: item.files, avatarUrl: user.avatarUrl, timeLabel: shortTime(item.createdAt), statusLabel: item.state === 'queued' ? '已存本机 · 等待投递' : item.state === 'sending' ? '发送中 · 等待服务器确认' : '发送失败', error: item.error || undefined, actions: <>{item.state !== 'sending' && <button disabled={operationBusy} onClick={() => void perform(() => client.retry(item.payload.clientMessageId))}>重试</button>}<button disabled={operationBusy} onClick={() => void perform(() => client.cancel(item.payload.clientMessageId), '已停止本机重试，不会撤回服务器已收到的消息。')}>停止本机重试</button></> });
  const connection = { connecting: ['正在连接', '正在连接聊天服务。'], syncing: ['正在同步', '正在更新消息与权限。'], online: ['已连接', '消息与权限持续同步。'], degraded: ['实时连接中断', '正通过 HTTP 同步，消息可能稍有延迟。'], offline: ['当前离线', '消息可先保存到本机，恢复网络后继续投递。'], expired: ['登录已失效', '请重新登录后继续。'] }[state.phase];
  const activeNotificationCount = state.notificationCount;
  const contactsProps = { contacts: state.contacts, requests: state.requests, nextContacts: state.nextContacts, nextRequests: state.nextRequests, onRefresh: () => client.refresh(), onOpenConversation: openDirect, onLoadMoreContacts: () => client.loadMoreContacts(), onLoadMoreRequests: () => client.loadMoreRequests() };
  let content: React.ReactNode;
  if (searchOpen) content = <MessageSearchPage conversations={state.conversations} initialConversationId={selectedId || undefined} onJump={jumpToMessage} onClose={() => setSearchOpen(false)} />;
  else if (reportsOpen) content = <ReportsPage onClose={() => setReportsOpen(false)} />;
  else if (section === 'tasks') content = <TaskWorkspace client={taskClient} userId={user.id} conversations={state.conversations} contacts={state.contacts} initialMeta={taskMeta || undefined} initialGroupId={taskGroupId} hasMoreConversations={!!state.nextConversations} onLoadMoreConversations={() => client.loadMoreConversations()} onOpenSource={openTaskSource} onClose={() => void navigate('messages')} />;
  else if (section === 'contacts') content = <ContactsPage key={contactsTab} {...contactsProps} initialTab={contactsTab} />;
  else if (section === 'notifications') content = <NotificationsPage actorContext={user.id} items={state.notifications} hasMore={!!state.nextNotifications} onLoadMore={() => client.loadMoreNotifications()} onRefresh={() => client.refresh()} onOpenMessage={jumpToMessage} onOpenTask={(taskId) => openTaskPanel({ kind: 'detail', taskId })} onOpenReports={() => setReportsOpen(true)} onOpenRequests={() => void navigate('contacts', 'requests')} onOpenGroup={(id) => openGroup(id, true)} />;
  else if (section === 'queue') content = <OfflineQueuePage items={state.outbox} onRetry={(id) => client.retry(id)} onCancel={(id) => client.cancel(id)} onCopyToDraft={copyToDraft} />;
  else if (section === 'settings') content = <AccountSettings onGetLocalSummary={getLocalSummary} user={user} onUserChange={onUserChange} onSignedOut={onSignedOut} onLogout={requestLogout} onOpenReports={() => setReportsOpen(true)} onBeforeDelete={async () => { await saveCurrentDraft(); taskOpeningGeneration.current++; setTaskPanel(null); taskClient.stop(); await client.prepareAccountDeletion(); }} onDeleteFailed={() => { client.resumeAccountAfterDeletionFailure(); if (mounted.current && client.getSnapshot().phase !== 'expired') taskClient.start(); }} onPreserveAndSignOut={async () => { await client.finishAccountDeletion('keep'); onSignedOut(); }} onDeleted={async (choice) => { await client.finishAccountDeletion(choice); onSignedOut(); }} />;
  else if (section === 'files') content = <FilesPage conversations={state.conversations} />;
  return <div className={`chat-workspace ${searchOpen || reportsOpen ? 'rich-mode' : ''}`}><div className={`connection-bar ${state.phase}`} role="status"><span className="connection-copy">{state.phase === 'offline' ? <WifiOff size={15} /> : state.phase === 'online' ? <Wifi size={15} /> : <RefreshCw size={15} />}<strong>{connection[0]}</strong><span>{connection[1]}</span></span><button className="text-button" disabled={operationBusy} onClick={() => void perform(() => client.refresh())}>重新同步</button>{state.outbox.length > 0 && <button className="text-button" onClick={() => void navigate('queue')}><Clock3 size={14} />本机待发 {state.outbox.length}</button>}</div>{(error || state.error) && <div className="workspace-error" role="alert"><span>{error || state.error}</span>{error && <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button>}</div>}{notice && <div className="workspace-notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭操作提示" onClick={() => setNotice('')}><X size={16} /></button></div>}{state.onlineNotice && state.onlineNotice.id !== dismissedOnlineNotice && <div className="online-notice" role="status"><span>{state.onlineNotice.user.nickname} 上线了</span><button className="text-button" onClick={() => setDismissedOnlineNotice(state.onlineNotice!.id)}>关闭</button></div>}<AppShell failedCount={state.outbox.filter((item) => item.state === 'failed').length} conversations={conversationViews} selectedId={selectedId || undefined} onSelectConversation={(id) => void selectConversation(id)} activeSection={section} onNavigate={(next) => void navigate(next)} badges={{ messages: state.conversations.filter((item) => !item.preferences.muted).reduce((sum, item) => sum + item.unreadCount, 0), contacts: state.requests.filter((item) => item.direction === 'incoming' && item.status === 'pending').length, notifications: activeNotificationCount, queue: state.outbox.length }} listContent={<ConversationList onSearchMessages={() => void perform(openSearch)} conversations={conversationViews} selectedId={selectedId || undefined} onSelect={(id) => void selectConversation(id)} onAdd={() => void navigate('contacts', 'search')} onCreateGroup={() => setCreateGroupOpen(true)} onJoinGroup={() => setJoinGroupOpen(true)} hasMore={!!state.nextConversations} loading={operationBusy} onLoadMore={() => void perform(() => client.loadMoreConversations())} />} accountFooter={<div className="account-footer"><Avatar url={user.avatarUrl} label={user.nickname} /><div><strong>{user.nickname}</strong><small>@{user.username}</small></div><a href="/admin" aria-label="管理入口"><ShieldCheck size={19} /></a></div>} sectionContent={content}>{searchOpen || reportsOpen ? content : selectedId ? <><ChatHeader onOpenTasks={selected?.kind === 'group' ? () => void openGroupTasks(selected.id) : undefined} onCreateTask={selected?.kind === 'group' && taskState.enabled ? () => void openTaskPanel({ kind: 'form', initialGroupId: selected.id }) : undefined} onSearch={() => void perform(openSearch)} avatarUrl={selected?.avatarUrl} group={selected?.kind === 'group'} title={revokedSelection?.id === selectedId ? '会话访问已失效' : selected?.title || '正在加载会话'} description={selected?.peer ? selected.peer.online ? '在线' : '未显示在线' : selected?.description} onBack={() => void selectConversation(null)} onToggleDetails={selected ? () => setDetailsOpen(true) : undefined} detailsOpen={detailsOpen} /><div className="timeline-container"><MessageTimeline messages={visibleMessages} viewportRef={viewport} onScroll={scrolled} hasOlder={showingCurrent && !!state.historyBefore} loading={state.historyLoading || draftLoading} onLoadOlder={() => void loadOlder()} />{(locatedId || newMessages > 0) && <div className="timeline-actions">{locatedId && <div className="history-context-bar"><span>已定位到目标消息</span>{state.historyAfter && <button className="text-button" disabled={state.historyLoading} onClick={() => void perform(() => client.loadNewer())}>加载较新的消息</button>}<button className="text-button" onClick={() => void selectConversation(selectedId, 'latest')}>返回最新消息</button></div>}{newMessages > 0 && <button className="new-messages-button" onClick={() => { forceJump.current = true; setJumpVersion((value) => value + 1); }}><ArrowDown size={15} />{newMessages} 条新消息</button>}</div>}</div>{revokedSelection?.id === selectedId && <button className="load-more-button" disabled={revokedSelection.saving} onClick={() => returnFromRevoked(revokedSelection)}>{revokedSelection.saving ? '正在保存草稿并返回…' : '重试保存草稿并返回'}</button>}{!draftLoading && !draftReady.current && <button className="load-more-button" onClick={() => void selectConversation(selectedId)}>重新加载会话和草稿</button>}{showingCurrent && !!state.typingUsers?.length && <p className="typing-notice" role="status">{state.typingUsers.map((item) => item.nickname).join('、')} 正在输入…</p>}<Composer onCreateTask={taskState.enabled ? () => void openTaskPanel({ kind: 'form', initialGroupId: selected?.kind === 'group' ? selected.id : undefined }) : undefined} onOpenTasks={selected?.kind === 'group' ? () => void openGroupTasks(selected.id) : undefined} taskDisabledReason={taskOpening ? '正在核对任务入口…' : undefined} userId={user.id} conversationId={selectedId || undefined} groupRole={selected?.kind === 'group' ? selected.role : undefined} context={context} onContextChange={editContext} replyLabel={replyLabel} files={draftFiles} onAddFiles={addFiles} onRemoveFile={(id) => editFiles(draftFilesRef.current.filter((file) => file.id !== id))} fileError={fileError} value={draft} onChange={editDraft} onSend={() => void send()} sending={sending} inputRef={input} disabledReason={draftLoading ? '正在加载会话草稿…' : !draftReady.current ? '会话或草稿尚未就绪' : !selected?.canSend ? selected?.sendDisabledReason || '当前会话不允许发送新消息，草稿已保留。' : undefined} notice={state.phase === 'offline' ? '离线发送将保存到本机' : draftNotice || undefined} /></> : <EmptyState title="欢迎来到同频" description="选择一段会话继续交流，或添加好友开始新的对话。" action={<button className="primary-button" onClick={() => void navigate('contacts', 'search')}>查找好友</button>} />}</AppShell>{taskOpening && <p className="workspace-notice" role="status">正在保存聊天草稿并核对待办入口…</p>}{taskPanel && taskMeta && (taskPanel.kind === 'detail' ? <TaskDetail client={taskClient} userId={user.id} taskId={taskPanel.taskId} meta={taskMeta} conversations={state.conversations} contacts={state.contacts} hasMoreConversations={!!state.nextConversations} onLoadMoreConversations={() => client.loadMoreConversations()} onOpenTask={(taskId) => void openTaskPanel({ kind: 'detail', taskId })} onOpenSource={openTaskSource} onClose={closeTaskPanel} /> : <TaskForm client={taskClient} userId={user.id} meta={taskMeta} conversations={state.conversations} hasMoreConversations={!!state.nextConversations} onLoadMoreConversations={() => client.loadMoreConversations()} {...taskPanel} onRefreshSource={() => setSourceAttempt((value) => value + 1)} onSaved={(task) => { setTaskPanel({ kind: 'detail', taskId: task.id }); }} onClose={closeTaskPanel} />)}{reportTarget && <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)} />}{createGroupOpen && <CreateGroupDialog friends={state.contacts} hasMore={!!state.nextContacts} onLoadMore={() => client.loadMoreContacts()} onClose={() => setCreateGroupOpen(false)} onCreated={openGroup} />}{(joinGroupOpen || invitationToken) && <GroupInviteEntry key={invitationToken || 'manual'} token={invitationToken} userId={user.id} onClose={() => { setJoinGroupOpen(false); onInvitationDismiss?.(); }} onOpenGroup={async (id) => { await openGroup(id); setJoinGroupOpen(false); onInvitationDismiss?.(); }} />}{detailsOpen && selected?.kind === 'group' && <GroupManagementPanel key={selected.id} conversationId={selected.id} userId={user.id} friends={state.contacts} hasMoreFriends={!!state.nextContacts} onLoadMoreFriends={() => client.loadMoreContacts()} onClose={() => setDetailsOpen(false)} onRefresh={() => client.refresh()} onBeforeLeave={saveCurrentDraft} onLeft={async () => { await client.refresh(); await selectConversation(null); }} ><section aria-label="群会话偏好"><button className="text-button" onClick={() => setReportTarget({ kind: 'group', id: selected.id, label: selected.title })}>举报群聊</button>{([ { key: 'onlyMentions', label: '仅提醒提及我的消息' },{ key: 'pinned', label: '置顶会话' }, { key: 'muted', label: '消息免打扰' }, { key: 'archived', label: '归档会话' }] as const).map(({ key, label }) => <label className="preference-row" key={key}><strong>{label}</strong><input type="checkbox" checked={selected.preferences[key]} disabled={operationBusy} onChange={(event) => void perform(() => changeConversationPreference(key, event.target.checked))} /></label>)}</section></GroupManagementPanel>}<Modal open={detailsOpen && selected?.kind !== 'group'} title="会话设置" dismissible={!operationBusy} onClose={() => setDetailsOpen(false)}>{selected && <><div className="contact-detail"><span className="avatar">{selected.title.slice(0, 1)}</span><h3>{selected.title}</h3>{selected.peer && <p>@{selected.peer.username}</p>}</div>{([{ key: 'pinned', label: '置顶会话', help: '在会话列表优先显示。' }, { key: 'muted', label: '消息免打扰', help: '保留未读记录，减少提醒。' }, { key: 'archived', label: '归档会话', help: '会话移入“已归档”，不会删除消息。' }] as const).map(({ key, label, help }) => <label className="preference-row" key={key}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={selected.preferences[key]} disabled={operationBusy} onChange={(event) => void perform(() => changeConversationPreference(key, event.target.checked))} /></label>)}{!selected.canSend && <p className="warning-note">{selected.sendDisabledReason || '当前会话不能发送新消息。'}</p>}{detailsOpen && error && <p className="form-error" role="alert">{error}</p>}</>}</Modal><Modal open={!!logoutPrompt} title="退出前，处理本机内容" dismissible={!logoutBusy} onClose={cancelLogout}><p>当前账号在本机有 {logoutPrompt?.pending} 条待发消息、{logoutPrompt?.drafts} 份聊天草稿、{logoutPrompt?.taskDrafts} 份任务草稿。其他账号不会看到这些内容。</p><p>保留后，聊天待发消息可在下次验证身份并联网后继续投递；任务草稿必须本人联网核对后确认提交，不会自动补发。删除会同时清理此账号的聊天与任务本机内容，不删除服务器实体。</p>{logoutError && <p className="form-error" role="alert">{logoutError}</p>}<div className="logout-options"><button className="primary-button" disabled={logoutBusy} onClick={() => void completeLogout('keep')}>保留，待下次登录继续</button><button className="secondary-button danger-text" disabled={logoutBusy} onClick={() => void completeLogout('delete')}>删除本机内容并退出</button><button className="text-button" disabled={logoutBusy} onClick={cancelLogout}>取消退出</button></div></Modal></div>;
}
