import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import {
  createNote,
  fetchConversationTags,
  fetchConversations,
  fetchMessages,
  fetchNotes,
  fetchSavedReplies,
  fetchTeammates,
  updateConversationTags,
  sendAgentMessage,
  uploadInboxAttachment,
  updateAssignment,
  updateConversationStatus,
} from "./inboxApi";
import { useInboxNotifications } from "./inboxNotifications";
import { createInboxRealtimeClient } from "./inboxRealtime";

import type { InboxNotifications } from "./inboxNotifications";

import type {
  ConversationFilters,
  InboxAttachment,
  InboxConversation,
  InboxConversationStatus,
  InboxMessage,
  InboxNote,
  MessagePage,
  SavedReply,
  Teammate,
} from "./inboxApi";
import type { InboxRealtimeClient, InboxRealtimeStatus, InboxSocketFactory } from "./inboxRealtime";

/**
 * All of the agent inbox's state and effects, kept out of the component
 * (CONTRIBUTING.md: "No business logic in JSX").
 *
 * The whole hook is scoped to ONE organization, and the component that uses
 * it is mounted with a `key` of that organization's id (ADR-025 §11) — so
 * switching tenants discards this state entirely, socket included, rather
 * than reconciling one tenant's conversations into a hook that just finished
 * holding another's. That is what makes the isolation structural instead of
 * a filter someone has to remember.
 */

/** The list's own load state. `forbidden` is separate because it is not retryable (ADR-025 §11). */
export type InboxStatus = "loading" | "ready" | "error" | "forbidden";

/** The selected thread's load state. Independent of the list's. */
export type ThreadStatus = "idle" | "loading" | "ready" | "error";

/**
 * Which state-changing action is in flight on the selected conversation
 * (ADR-026 §13).
 *
 * One value rather than a boolean per action: the four are mutually exclusive
 * on one conversation, and a set of independent booleans is a state where two
 * can be true at once and the UI has to decide what that means.
 */
export type ConversationActionKind = "claim" | "release" | "close" | "reopen" | "tag";

export interface UseAgentInboxOptions {
  organizationId: string;
  /** Injected by tests so the socket layer runs against a fake (ADR-025 §11). */
  socketFactory?: InboxSocketFactory;
  /**
   * A conversation to open as soon as the first page has loaded (ADR-033 §7).
   *
   * Set when the reader clicked a row on the workspace overview, which lives
   * in a sibling view — so the intent is formed before this hook exists and
   * has to arrive as an option rather than as a call.
   *
   * Applied inside the load's promise callback rather than in an effect that
   * watches it, for the reason `loadedFor` records below: a synchronous
   * setState in an effect body cascades a render, and React's own lint rule
   * refuses it.
   */
  initialConversationId?: string | null;
}

export interface AgentInbox {
  status: InboxStatus;
  error: string | null;
  conversations: InboxConversation[];

  /**
   * Whether older conversations exist beyond the ones loaded (ADR-025 §5).
   *
   * The list pages BACKWARDS — the server sorts by `lastMessageAt` descending
   * — so "more" here means older, and the first page is the tenant's most
   * recently active conversations.
   */
  hasOlderConversations: boolean;
  isLoadingOlderConversations: boolean;
  /** A failure to extend the list. Separate from `error`, which is about the list existing at all. */
  olderConversationsError: string | null;
  loadOlderConversations: () => Promise<void>;

  selectedConversationId: string | null;
  selectConversation: (conversationId: string) => void;

  threadStatus: ThreadStatus;
  threadError: string | null;
  messages: InboxMessage[];

  /**
   * Whether the thread was truncated by `MAX_THREAD_PAGES` and NEWER messages
   * remain unread (ADR-025 §5).
   *
   * Reachable only in a conversation longer than `MAX_THREAD_PAGES` pages,
   * which is far outside ordinary support traffic — it exists so that nothing
   * is unreachable, not as a control agents are expected to meet.
   */
  hasMoreMessages: boolean;
  isLoadingMoreMessages: boolean;
  loadMoreMessages: () => Promise<void>;

  /**
   * Conversation id → count of messages that arrived over the socket while
   * that conversation was not the selected one.
   *
   * Session-local and never persisted (ADR-025 §12): persisting it would mean
   * deciding what "read" means for a conversation several agents share, which
   * is read-receipt design and explicitly out of scope.
   */
  unreadCounts: Record<string, number>;

  realtimeStatus: InboxRealtimeStatus;

  isSending: boolean;
  sendError: string | null;
  /** Sends a reply with any uploaded files; resolves whether it was sent (ADR-041 §1). */
  send: (body: string, attachmentIds?: string[]) => Promise<boolean>;
  /** Uploads a file into the selected conversation, ready to send (ADR-041 §2). */
  upload: (file: File) => Promise<InboxAttachment>;

  /** Conversations whose customer is typing right now (ADR-040 §3). */
  customerTyping: Record<string, true>;
  /** Conversations a colleague is replying to right now, so two agents do not answer at once (ADR-040 §3). */
  colleagueTyping: Record<string, true>;
  /** Call as the agent types in the composer; throttled, and "stopped" follows on its own. */
  notifyTyping: () => void;
  /** Sound and desktop notification switches (ADR-040 §5). */
  notifications: InboxNotifications;

  /** The signed-in agent's own user id, for telling their assignments from a colleague's (ADR-026 §11). */
  currentUserId: string | null;

  /** Which claim/release/close/reopen is in flight, or `null`. */
  pendingAction: ConversationActionKind | null;
  /** The last state-change failure, in this client's own words (ADR-026 §13). */
  actionError: string | null;

  claim: () => Promise<void>;
  release: () => Promise<void>;
  /**
   * Closes or reopens the selected conversation.
   *
   * Named `setConversationStatus` rather than `setStatus` because this hook
   * already holds a `status` of its own — the LIST's load state — and two
   * setters a letter apart is the kind of pair a reader picks wrong.
   */
  setConversationStatus: (status: InboxConversationStatus) => Promise<void>;

  // ---- agent productivity (ADR-042) ----

  /** What the list is narrowed to: search, tag, status, assignee. */
  filters: ConversationFilters;
  /** Replaces the filters and reloads the list from the server. */
  setFilters: (next: ConversationFilters) => void;
  /** A filtered reload is in flight; the previous rows stay on screen meanwhile. */
  isFiltering: boolean;
  /** Internal notes on the selected conversation, oldest first. */
  notes: InboxNote[];
  addNote: (body: string, mentionedUserIds: string[]) => Promise<boolean>;
  noteError: string | null;
  /** Replaces the selected conversation's tags. */
  setTags: (tags: string[]) => Promise<void>;
  /** Every tag in use in the organisation, for the filter and the tag picker. */
  organizationTags: string[];
  savedReplies: SavedReply[];
  teammates: Teammate[];
  /** Moves the selection one row down (1) or up (-1): the j/k shortcuts. */
  selectAdjacentConversation: (direction: 1 | -1) => void;
}

/** Adds notes by id, keeping the thread in time order. */
function mergeNotes(current: InboxNote[], incoming: InboxNote[]): InboxNote[] {
  const byId = new Map(current.map((note) => [note.id, note]));
  for (const note of incoming) byId.set(note.id, note);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const NOTE_ERROR = "Note not saved. Please try again.";

/**
 * The page size both reads ask for, and the server's own maximum
 * (`CONVERSATION_PAGE_MAX_LIMIT` / `MESSAGE_PAGE_MAX_LIMIT`).
 *
 * Asking for the ceiling rather than accepting the default is what keeps
 * `loadThread` below to a small number of round trips: a 250-message
 * conversation is three requests at 100, and nine at the server's default of
 * 30.
 */
const PAGE_LIMIT = 100;

/**
 * How many message pages one thread load will follow before stopping.
 *
 * There IS a cap, because the loop below is unbounded otherwise and a
 * pathological conversation would issue a request per hundred messages while
 * an agent waits. There is a cap this HIGH — 100 pages, ten thousand messages
 * — because of which end the cap truncates: messages page oldest-first, so
 * stopping early withholds the NEWEST messages, which are the ones an agent
 * needs. Nothing is lost, `loadMoreMessages` continues from the cursor, but
 * the threshold is set where no real support conversation will meet it.
 */
const MAX_THREAD_PAGES = 100;

const GENERIC_LIST_ERROR = "Could not load conversations. Please try again.";
const GENERIC_THREAD_ERROR = "Could not load this conversation. Please try again.";
const GENERIC_OLDER_ERROR = "Could not load older conversations. Please try again.";
const GENERIC_SEND_ERROR = "Message not sent. Please try again.";

/**
 * The state-change failures, in this client's own words (ADR-026 §13).
 *
 * The server's text is never shown, matching how `send` already treats its
 * own failures (ADR-019 §12's posture). Two of these are the exception the
 * inbox makes to "say only what is known": `CONVERSATION_ALREADY_ASSIGNED`
 * and `CONVERSATION_REOPEN_CONFLICT` are the two refusals an agent can
 * actually act on, so the reason is worth stating.
 */
const GENERIC_ACTION_ERROR = "That did not work. Please try again.";
const ALREADY_ASSIGNED_ERROR = "Another agent is handling this conversation.";
const REOPEN_CONFLICT_ERROR = "This customer already has a newer open conversation.";
const ACTION_FORBIDDEN_ERROR = "Your role cannot change this conversation.";
const CONVERSATION_GONE_ERROR = "That conversation is no longer available.";

/**
 * Maps a state-change failure to what the agent is told.
 *
 * Branches on the envelope's `code` rather than on the status alone: both
 * conflicts are 409s and they mean different things, and the code is the
 * machine-readable half the server provides precisely so a client does not
 * have to parse prose.
 */
function actionErrorFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return GENERIC_ACTION_ERROR;

  if (caught.code === "CONVERSATION_ALREADY_ASSIGNED") return ALREADY_ASSIGNED_ERROR;
  if (caught.code === "CONVERSATION_REOPEN_CONFLICT") return REOPEN_CONFLICT_ERROR;
  if (caught.status === 403) return ACTION_FORBIDDEN_ERROR;
  if (caught.status === 404) return CONVERSATION_GONE_ERROR;

  return GENERIC_ACTION_ERROR;
}

export function useAgentInbox({
  organizationId,
  socketFactory,
  initialConversationId = null,
}: UseAgentInboxOptions): AgentInbox {
  const { authorizedFetch, session } = useAuth();

  const [status, setStatus] = useState<InboxStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<InboxConversation[]>([]);

  /** The cursor for the NEXT (older) page of conversations, or `null` at the end of the history. */
  const [conversationsCursor, setConversationsCursor] = useState<string | null>(null);
  const [isLoadingOlderConversations, setIsLoadingOlderConversations] = useState(false);
  const [olderConversationsError, setOlderConversationsError] = useState<string | null>(null);

  /** The cursor for the NEXT (newer) page of the selected thread, or `null` when it is whole. */
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [threadStatus, setThreadStatus] = useState<ThreadStatus>("idle");
  const [threadError, setThreadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);

  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [customerTyping, setCustomerTyping] = useState<Record<string, true>>({});
  const [colleagueTyping, setColleagueTyping] = useState<Record<string, true>>({});
  const notifications = useInboxNotifications();
  const notify = notifications.notify;

  /** The live socket client, so selection and the composer can emit through it (ADR-040 §3–4). */
  const realtimeRef = useRef<InboxRealtimeClient | null>(null);
  /** Clears a "typing" nobody said stopped, keyed by `${sender}:${conversationId}`. */
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentAt = useRef(0);
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Titles by conversation id, so a notification can name the customer. */
  const titlesRef = useRef<Map<string, string>>(new Map());
  const [realtimeStatus, setRealtimeStatus] = useState<InboxRealtimeStatus>("connecting");

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<ConversationActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [filters, setFiltersState] = useState<ConversationFilters>({});
  /** Read by the loaders, so a page request always carries the filters the reader last chose. */
  const filtersRef = useRef<ConversationFilters>({});
  const [isFiltering, setIsFiltering] = useState(false);
  /** Increments per list load, so a slow response to an older filter cannot overwrite a newer one. */
  const listRequest = useRef(0);
  const [notes, setNotes] = useState<InboxNote[]>([]);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [organizationTags, setOrganizationTags] = useState<string[]>([]);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const currentUserIdRef = useRef<string | null>(session?.user.id ?? null);
  useEffect(() => {
    currentUserIdRef.current = session?.user.id ?? null;
  }, [session]);

  /**
   * Every message id currently rendered in the thread — THE de-duplication
   * mechanism, exactly as `widget.ts` uses one (ADR-024 §4, ADR-025 §8).
   *
   * A ref rather than derived from `messages`, so the socket handler can
   * check it without depending on the latest render's closure — which is what
   * would otherwise drop a message that arrived between two renders.
   *
   * `Message._id` is server-assigned, immutable, and globally unique, which
   * is what makes it the right identity here rather than the body or an
   * array position.
   */
  const seenMessageIds = useRef<Set<string>>(new Set());

  /**
   * Mirrors `selectedConversationId` for the socket handler, same reason as
   * above.
   *
   * Written in `selectConversation` rather than during render — a ref write
   * during render can leave the value stale relative to what actually
   * committed. `selectConversation` is the only thing that ever changes the
   * selection, so the handler is both the correct and the complete place for
   * it.
   */
  const selectedRef = useRef<string | null>(null);

  // ---- the conversation list ----

  // ---- the selected thread ----

  /**
   * Selecting is an EVENT, so every state transition it causes happens here
   * rather than in the effect that follows it.
   *
   * That is not only a lint accommodation: the loading state, the cleared
   * errors, and the reset identity set are all consequences of the click, and
   * putting them in an effect would mean the UI briefly showed the previous
   * conversation's messages under the new conversation's title.
   */
  const selectConversation = useCallback((conversationId: string) => {
    selectedRef.current = conversationId;
    setSelectedConversationId(conversationId);
    setThreadStatus("loading");
    setThreadError(null);
    setSendError(null);
    // A refusal about the previous conversation must not sit under the new
    // one's controls, where it would read as a statement about a conversation
    // it says nothing about.
    setActionError(null);
    setMessages([]);
    setNotes([]);
    setNoteError(null);
    // Whatever remained of the previous thread says nothing about this one.
    setThreadCursor(null);

    // A new thread starts with a fresh identity set: ids from the previous
    // conversation would otherwise suppress nothing useful and grow forever.
    seenMessageIds.current = new Set();

    // Selecting reads the conversation for the whole team (ADR-040 §4).
    realtimeRef.current?.markRead(conversationId);
    setUnreadCounts((counts) => {
      if (counts[conversationId] === undefined) return counts;
      const next = { ...counts };
      delete next[conversationId];
      return next;
    });
  }, []);

  /**
   * Guards against re-fetching the organization already loaded, the same
   * pattern `OrganizationSwitcher.tsx` uses.
   *
   * It is also what lets the effect below call NO setState synchronously:
   * `status` already starts as `"loading"`, so there is nothing to reset on
   * the way in, and every state write happens in a promise callback once the
   * server has answered. A synchronous setState in an effect body cascades a
   * render for no visible benefit — and React's own lint rule says so.
   */
  const loadedFor = useRef<string | null>(null);

  /**
   * The conversation the overview asked for, consumed once.
   *
   * A ref rather than a dependency of the loader: it must not re-trigger a
   * load when it changes, and it must not make a reader who navigated away and
   * back reopen a thread they had already closed.
   */
  const pendingSelection = useRef<string | null>(initialConversationId);

  const loadConversations = useCallback(async () => {
    try {
      const request = ++listRequest.current;
      const page = await fetchConversations(authorizedFetch, organizationId, { limit: PAGE_LIMIT }, filtersRef.current);
      if (request !== listRequest.current) return;
      setConversations(page.conversations);
      setConversationsCursor(page.nextCursor);
      // Unread counts are stored on the server now, so they survive a reload (ADR-040 §4).
      setUnreadCounts(unreadFrom(page.conversations));
      for (const conversation of page.conversations) titlesRef.current.set(conversation.id, titleOf(conversation));
      setStatus("ready");

      /*
        Open the requested conversation, if it is really in the list. Selecting
        an id the page does not contain would leave the thread pane loading a
        conversation this reader cannot see — a stale click is better ignored
        than obeyed.
      */
      const requested = pendingSelection.current;
      pendingSelection.current = null;
      if (requested !== null && page.conversations.some((conversation) => conversation.id === requested)) {
        selectConversation(requested);
      }
    } catch (caught: unknown) {
      // A 401 is a sign-out already in progress; ProtectedRoute redirects.
      if (caught instanceof AuthApiError && caught.status === 401) return;

      if (caught instanceof AuthApiError && caught.status === 403) {
        // Not retryable: this role will get the same answer forever
        // (ADR-025 §11), so it is a state rather than an error message with
        // a "try again" beside it.
        setStatus("forbidden");
        return;
      }

      /*
        A 404 here means the tenant itself was refused — suspended, or a
        membership revoked since the switcher loaded. Deliberately
        indistinguishable from "no such organization" (ADR-017 §6), so the
        message says only what is actually known.
      */
      setError(
        caught instanceof AuthApiError && caught.status === 404
          ? "That organization is no longer available to you."
          : GENERIC_LIST_ERROR,
      );
      setStatus("error");
    }
  }, [authorizedFetch, organizationId, selectConversation]);

  useEffect(() => {
    if (loadedFor.current === organizationId) return;
    loadedFor.current = organizationId;

    void loadConversations();
  }, [loadConversations, organizationId]);

  /**
   * Extends the list with the next page of OLDER conversations (ADR-025 §5).
   *
   * Appends rather than replaces, and de-duplicates by id on the way in. The
   * de-duplication is not defensive tidiness: the sort key is `lastMessageAt`,
   * so a conversation that receives a message between two page reads moves to
   * the front of the order and can be returned again in a later page. Keeping
   * the copy already held — rather than the one just read — preserves whatever
   * the socket has since merged into that row.
   *
   * A failure leaves the conversations already loaded exactly as they are.
   * Losing a screen of history to a network blip on a "load older" click would
   * be a far worse answer than a message beside the button.
   */
  const loadOlderConversations = useCallback(async () => {
    const cursor = conversationsCursor;
    if (cursor === null || isLoadingOlderConversations) return;

    setIsLoadingOlderConversations(true);
    setOlderConversationsError(null);

    try {
      const page = await fetchConversations(
        authorizedFetch,
        organizationId,
        { cursor, limit: PAGE_LIMIT },
        filtersRef.current,
      );

      setConversations((current) => {
        const held = new Set(current.map((conversation) => conversation.id));
        return [...current, ...page.conversations.filter((conversation) => !held.has(conversation.id))];
      });
      setUnreadCounts((counts) => ({ ...unreadFrom(page.conversations), ...counts }));
      for (const conversation of page.conversations) titlesRef.current.set(conversation.id, titleOf(conversation));
      setConversationsCursor(page.nextCursor);
    } catch (caught: unknown) {
      // A 401 is a sign-out already in progress; ProtectedRoute redirects.
      if (caught instanceof AuthApiError && caught.status === 401) return;

      setOlderConversationsError(GENERIC_OLDER_ERROR);
    } finally {
      setIsLoadingOlderConversations(false);
    }
  }, [authorizedFetch, conversationsCursor, isLoadingOlderConversations, organizationId]);

  // ---- the selected thread ----


  /**
   * Loads the whole selected thread, following the cursor to its end.
   *
   * One page is not a conversation. Messages page oldest-first (see
   * `fetchMessages`), so reading a single page and stopping shows the FIRST
   * thirty messages of a long exchange and hides everything since — including
   * the message the customer is waiting on a reply to. That is what this loop
   * exists to prevent, and it is why the loop follows the cursor rather than
   * offering an "older messages" control: there is no useful state in which an
   * agent is looking at the start of a conversation and must ask for the rest.
   *
   * Each page is committed as it arrives, and the thread is `ready` after the
   * first, so a long history fills in visibly instead of holding a spinner
   * until the last page lands.
   *
   * Pages are appended through the same `seenMessageIds` check every other
   * source uses (ADR-024 §4, ADR-025 §8), so a message the socket delivered
   * mid-load is not written twice when the page carrying it arrives.
   */
  useEffect(() => {
    if (selectedConversationId === null) return;

    let cancelled = false;

    async function loadThread(conversationId: string) {
      try {
        let cursor: string | null = null;
        let pages = 0;

        do {
          const page: MessagePage = await fetchMessages(authorizedFetch, organizationId, conversationId, {
            cursor,
            limit: PAGE_LIMIT,
          });
          if (cancelled) return;

          const fresh = page.messages.filter((message) => !seenMessageIds.current.has(message.id));
          for (const message of fresh) seenMessageIds.current.add(message.id);

          // Functional update: the socket may have appended to this thread
          // between two pages, and that message must survive the merge.
          if (fresh.length > 0) setMessages((current) => [...current, ...fresh]);

          // Ready after the FIRST page — the rest fills in underneath.
          if (pages === 0) setThreadStatus("ready");

          cursor = page.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < MAX_THREAD_PAGES);

        if (cancelled) return;
        // Non-null only for a conversation past MAX_THREAD_PAGES, which
        // `loadMoreMessages` continues from.
        setThreadCursor(cursor);
      } catch (caught: unknown) {
        if (cancelled) return;
        if (caught instanceof AuthApiError && caught.status === 401) return;

        setMessages([]);
        setThreadError(
          caught instanceof AuthApiError && caught.status === 404
            ? "That conversation is no longer available."
            : GENERIC_THREAD_ERROR,
        );
        setThreadStatus("error");
      }
    }

    void loadThread(selectedConversationId);

    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId, selectedConversationId]);

  /**
   * Continues a thread that stopped at `MAX_THREAD_PAGES`, one page further.
   *
   * The counterpart to `loadOlderConversations`, and the reason the cap above
   * costs nothing: the messages beyond it are reachable, just not fetched
   * unasked.
   */
  const loadMoreMessages = useCallback(async () => {
    const cursor = threadCursor;
    const conversationId = selectedConversationId;
    if (cursor === null || conversationId === null || isLoadingMoreMessages) return;

    setIsLoadingMoreMessages(true);

    try {
      const page = await fetchMessages(authorizedFetch, organizationId, conversationId, {
        cursor,
        limit: PAGE_LIMIT,
      });

      // The selection may have moved while this was in flight; those messages
      // belong to a conversation nobody is looking at any more.
      if (selectedRef.current !== conversationId) return;

      const fresh = page.messages.filter((message) => !seenMessageIds.current.has(message.id));
      for (const message of fresh) seenMessageIds.current.add(message.id);

      if (fresh.length > 0) setMessages((current) => [...current, ...fresh]);
      setThreadCursor(page.nextCursor);
    } catch (caught: unknown) {
      if (caught instanceof AuthApiError && caught.status === 401) return;

      setThreadError(GENERIC_THREAD_ERROR);
    } finally {
      setIsLoadingMoreMessages(false);
    }
  }, [authorizedFetch, isLoadingMoreMessages, organizationId, selectedConversationId, threadCursor]);

  // ---- typing (ADR-040 §3) ----

  const clearTyping = useCallback((kind: "customer" | "colleague", conversationId: string) => {
    const key = `${kind}:${conversationId}`;
    const existing = typingTimers.current.get(key);
    if (existing !== undefined) clearTimeout(existing);
    typingTimers.current.delete(key);
    const setter = kind === "customer" ? setCustomerTyping : setColleagueTyping;
    setter((current) => {
      if (!current[conversationId]) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }, []);

  const setTyping = useCallback(
    (kind: "customer" | "colleague", conversationId: string) => {
      const setter = kind === "customer" ? setCustomerTyping : setColleagueTyping;
      setter((current) => (current[conversationId] ? current : { ...current, [conversationId]: true }));
      const key = `${kind}:${conversationId}`;
      const existing = typingTimers.current.get(key);
      if (existing !== undefined) clearTimeout(existing);
      // A lost "stopped" must not leave the indicator on forever.
      typingTimers.current.set(key, setTimeout(() => clearTyping(kind, conversationId), 6000));
    },
    [clearTyping],
  );

  // ---- real-time ----

  const accessToken = session?.accessToken ?? null;

  useEffect(() => {
    if (accessToken === null) return;

    const client = createInboxRealtimeClient({
      organizationId,
      token: accessToken,
      factory: socketFactory,
      callbacks: {
        onStatusChange: setRealtimeStatus,
        onAuthFailure: () => {
          /*
            Deliberately does NOT sign the user out. A refused socket
            handshake can mean a merely expired access token, which the
            provider's own refresh repairs on the next REST call — tearing
            down the session from here would log someone out for a transport
            failure they could not see.
          */
        },
        onMessage: (message) => {
          /*
            THE single append point (ADR-024 §4, ADR-025 §8). Every message
            from every source — history, the socket, and an agent's own send
            ack — funnels through the same id check, so one guard covers all
            three duplication paths at once. That matters most for the
            sender's own reply, which arrives twice by design: once as the
            REST 201 and once as the inbox broadcast.
          */
          const isSelected = message.conversationId === selectedRef.current;
          const isVisible = typeof document === "undefined" || document.visibilityState === "visible";

          if (message.senderType === "customer") {
            // A message ends "typing" for that conversation.
            clearTyping("customer", message.conversationId);
            if (!isSelected || !isVisible) {
              notify(
                `New message from ${titlesRef.current.get(message.conversationId) ?? "a customer"}`,
                message.body.length > 0 ? message.body : "Sent a file",
              );
            }
          }

          if (isSelected) {
            if (seenMessageIds.current.has(message.id)) return;
            seenMessageIds.current.add(message.id);
            setMessages((current) => [...current, message]);
            if (message.senderType === "customer" && isVisible) client.markRead(message.conversationId);
          } else if (message.senderType === "customer") {
            // Only customer messages are unread for the team; a colleague's reply is not.
            setUnreadCounts((counts) => ({
              ...counts,
              [message.conversationId]: (counts[message.conversationId] ?? 0) + 1,
            }));
          }

          /*
            Keep the row's timestamp current without re-sorting the list under
            the reader's cursor — ADR-025 §13 records that continuous
            live re-ordering is its own UX decision. A conversation the list
            has never seen is left alone; the next fetch brings it in.
          */
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === message.conversationId
                ? { ...conversation, lastMessageAt: message.createdAt }
                : conversation,
            ),
          );
        },
        onTyping: (conversationId, sender, isTyping) => {
          if (isTyping) setTyping(sender === "customer" ? "customer" : "colleague", conversationId);
          else clearTyping(sender === "customer" ? "customer" : "colleague", conversationId);
        },
        onRead: (conversationId, reader, readAt) => {
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id !== conversationId
                ? conversation
                : reader === "customer"
                  ? { ...conversation, customerLastReadAt: readAt }
                  : { ...conversation, agentLastReadAt: readAt, unreadCount: 0 },
            ),
          );
          // A colleague opening it reads it for everyone.
          if (reader === "agent") {
            setUnreadCounts((counts) => {
              if (counts[conversationId] === undefined) return counts;
              const next = { ...counts };
              delete next[conversationId];
              return next;
            });
          }
        },
        onNote: (note) => {
          if (note.conversationId === selectedRef.current) setNotes((current) => mergeNotes(current, [note]));
          // Being @mentioned is worth an alert even when the sound is for customers (ADR-042 §2).
          const me = currentUserIdRef.current;
          if (me !== null && note.author.id !== me && note.mentions.some((mention) => mention.id === me)) {
            notify(`${note.author.name ?? "A teammate"} mentioned you`, note.body);
          }
        },
        onConversationUpdate: (update) => {
          /*
            Another agent claimed, released, closed, or reopened something in
            this tenant (ADR-026 §10, §13).

            Merged by id into the row already held — `status` and `assignedTo`
            replaced, `customer` left alone because it did not change and the
            broadcast does not carry it. A conversation the list has never seen
            is left alone entirely: the next fetch brings it in, and rows must
            not appear under a reader's cursor (ADR-025 §13's rule, applied to
            a second event).

            The assignee's `name` is always `null` over this transport, because
            a broadcast has no reader to run the `member.read` check against
            (ADR-026 §11). Preserving the name already on the row when the id
            is unchanged keeps a colleague's name from blinking out of the UI
            on an unrelated status change.
          */
          setConversations((current) =>
            current.map((conversation) => {
              if (conversation.id !== update.id) return conversation;

              const keepsAssignee =
                update.assignedTo !== null && conversation.assignedTo?.id === update.assignedTo.id;

              return {
                ...conversation,
                status: update.status,
                lastMessageAt: update.lastMessageAt,
                assignedTo: keepsAssignee ? conversation.assignedTo : update.assignedTo,
                tags: update.tags ?? conversation.tags,
              };
            }),
          );
        },
      },
    });

    realtimeRef.current = client;
    client.connect();
    return () => {
      realtimeRef.current = null;
      client.destroy();
    };
  }, [accessToken, organizationId, socketFactory, notify, setTyping, clearTyping]);

  // ---- agent productivity (ADR-042) ----

  /*
    The organisation's saved replies, teammates and tags, read once. Each is a
    convenience on top of the inbox: a failure leaves that feature empty and
    the inbox fully usable.
  */
  useEffect(() => {
    let cancelled = false;
    const ignore = () => undefined;
    fetchSavedReplies(authorizedFetch, organizationId).then((loaded) => !cancelled && setSavedReplies(loaded), ignore);
    fetchTeammates(authorizedFetch, organizationId).then((loaded) => !cancelled && setTeammates(loaded), ignore);
    fetchConversationTags(authorizedFetch, organizationId).then((loaded) => !cancelled && setOrganizationTags(loaded), ignore);
    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId]);

  useEffect(() => {
    if (selectedConversationId === null) return;
    let cancelled = false;
    fetchNotes(authorizedFetch, organizationId, selectedConversationId).then(
      (loaded) => {
        if (!cancelled) setNotes((current) => mergeNotes(current, loaded));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId, selectedConversationId]);

  const setFilters = useCallback(
    (next: ConversationFilters) => {
      filtersRef.current = next;
      setFiltersState(next);
      setIsFiltering(true);
      void loadConversations().finally(() => setIsFiltering(false));
    },
    [loadConversations],
  );

  const addNote = useCallback(
    async (body: string, mentionedUserIds: string[]) => {
      const conversationId = selectedConversationId;
      if (conversationId === null || body.trim().length === 0) return false;

      setIsSending(true);
      setNoteError(null);
      try {
        const note = await createNote(authorizedFetch, organizationId, conversationId, body.trim(), mentionedUserIds);
        setNotes((current) => mergeNotes(current, [note]));
        return true;
      } catch (caught: unknown) {
        if (caught instanceof AuthApiError && caught.status === 401) return false;
        setNoteError(NOTE_ERROR);
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [authorizedFetch, organizationId, selectedConversationId],
  );

  const selectAdjacentConversation = useCallback(
    (direction: 1 | -1) => {
      if (conversations.length === 0) return;
      const index = conversations.findIndex((conversation) => conversation.id === selectedRef.current);
      const nextIndex = index === -1 ? 0 : Math.min(conversations.length - 1, Math.max(0, index + direction));
      const target = conversations[nextIndex];
      if (target !== undefined && target.id !== selectedRef.current) selectConversation(target.id);
    },
    [conversations, selectConversation],
  );

  useEffect(() => {
    const timers = typingTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      if (typingIdleTimer.current !== null) clearTimeout(typingIdleTimer.current);
    };
  }, []);

  const stopTyping = useCallback(() => {
    if (typingIdleTimer.current !== null) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = null;
    if (lastTypingSentAt.current === 0) return;
    lastTypingSentAt.current = 0;
    const conversationId = selectedRef.current;
    if (conversationId !== null) realtimeRef.current?.typing(conversationId, false);
  }, []);

  const notifyTyping = useCallback(() => {
    const conversationId = selectedRef.current;
    if (conversationId === null) return;
    const now = Date.now();
    if (now - lastTypingSentAt.current > 2500) {
      realtimeRef.current?.typing(conversationId, true);
      lastTypingSentAt.current = now;
    }
    if (typingIdleTimer.current !== null) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(stopTyping, 3000);
  }, [stopTyping]);

  // Coming back to the tab reads what arrived meanwhile in the open conversation.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && selectedRef.current !== null) {
        realtimeRef.current?.markRead(selectedRef.current);
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // ---- sending ----

  const send = useCallback(
    async (body: string, attachmentIds: string[] = []) => {
      const conversationId = selectedConversationId;
      if (conversationId === null) return false;

      const trimmed = body.trim();
      if (trimmed.length === 0 && attachmentIds.length === 0) return false;

      setIsSending(true);
      setSendError(null);
      stopTyping();

      try {
        const message = await sendAgentMessage(authorizedFetch, organizationId, conversationId, trimmed, attachmentIds);

        // Through the same id check as the socket path: the broadcast for
        // this very message may already have arrived.
        if (!seenMessageIds.current.has(message.id)) {
          seenMessageIds.current.add(message.id);
          setMessages((current) => [...current, message]);
        }
        return true;
      } catch (caught: unknown) {
        if (caught instanceof AuthApiError && caught.status === 401) return false;

        /*
          The server's own message is not shown. A 429 in particular carries
          text about Serviqo's defences, and a 403/404 is deliberately opaque
          — the UI renders its own copy for all of them (ADR-019 §12's
          posture, applied to a staff surface).
        */
        setSendError(GENERIC_SEND_ERROR);
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [authorizedFetch, organizationId, selectedConversationId, stopTyping],
  );

  const upload = useCallback(
    (file: File) => {
      const conversationId = selectedConversationId;
      if (conversationId === null) return Promise.reject(new Error("No conversation selected"));
      return uploadInboxAttachment(authorizedFetch, organizationId, conversationId, file);
    },
    [authorizedFetch, organizationId, selectedConversationId],
  );

  // ---- assignment and status ----

  /**
   * Runs one state-changing call and folds the server's answer back into the
   * list (ADR-026 §13).
   *
   * Shared by claim, release, close, and reopen because all four differ only
   * in which request they make: the pending state, the error mapping, and the
   * row merge are identical, and four copies of them would be four places for
   * the merge to drift.
   *
   * The response is the SAME projection the list read returns, which is why
   * this needs no refetch — and why the row it replaces keeps its `customer`
   * rather than losing it to a narrower shape.
   */
  const runAction = useCallback(
    async (kind: ConversationActionKind, call: (conversationId: string) => Promise<InboxConversation>) => {
      const conversationId = selectedConversationId;
      if (conversationId === null) return;

      setPendingAction(kind);
      setActionError(null);

      try {
        const updated = await call(conversationId);

        setConversations((current) =>
          current.map((conversation) => (conversation.id === updated.id ? updated : conversation)),
        );
      } catch (caught: unknown) {
        // A 401 is a sign-out already in progress; ProtectedRoute redirects.
        if (caught instanceof AuthApiError && caught.status === 401) return;

        setActionError(actionErrorFor(caught));
      } finally {
        setPendingAction(null);
      }
    },
    [selectedConversationId],
  );

  const claim = useCallback(
    () => runAction("claim", (id) => updateAssignment(authorizedFetch, organizationId, id, "claim")),
    [authorizedFetch, organizationId, runAction],
  );

  const release = useCallback(
    () => runAction("release", (id) => updateAssignment(authorizedFetch, organizationId, id, "release")),
    [authorizedFetch, organizationId, runAction],
  );

  const setTags = useCallback(
    async (tags: string[]) => {
      await runAction("tag", (id) => updateConversationTags(authorizedFetch, organizationId, id, tags));
      setOrganizationTags((current) => [...new Set([...current, ...tags])].sort((a, b) => a.localeCompare(b)));
    },
    [authorizedFetch, organizationId, runAction],
  );

  const setConversationStatus = useCallback(
    (next: InboxConversationStatus) =>
      runAction(next === "closed" ? "close" : "reopen", (id) =>
        updateConversationStatus(authorizedFetch, organizationId, id, next),
      ),
    [authorizedFetch, organizationId, runAction],
  );

  return {
    status,
    error,
    conversations,
    hasOlderConversations: conversationsCursor !== null,
    isLoadingOlderConversations,
    olderConversationsError,
    loadOlderConversations,
    selectedConversationId,
    selectConversation,
    threadStatus,
    threadError,
    messages,
    hasMoreMessages: threadCursor !== null,
    isLoadingMoreMessages,
    loadMoreMessages,
    unreadCounts,
    realtimeStatus,
    isSending,
    sendError,
    send,
    upload,
    /*
      From the session the provider holds, which came from the login response
      — the same id the server compares `assignedTo` against. Used only to
      render "Assigned to you" versus a colleague; it authorizes nothing,
      because the server re-proves every request regardless (ADR-017 §10).
    */
    customerTyping,
    colleagueTyping,
    notifyTyping,
    notifications,
    currentUserId: session?.user.id ?? null,
    filters,
    setFilters,
    isFiltering,
    notes,
    addNote,
    noteError,
    setTags,
    organizationTags,
    savedReplies,
    teammates,
    selectAdjacentConversation,
    pendingAction,
    actionError,
    claim,
    release,
    setConversationStatus,
  };
}

/** Seeds the unread badges from the server's stored counts (ADR-040 §4). */
function unreadFrom(conversations: InboxConversation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const conversation of conversations) {
    if ((conversation.unreadCount ?? 0) > 0) counts[conversation.id] = conversation.unreadCount!;
  }
  return counts;
}

function titleOf(conversation: InboxConversation): string {
  return conversation.customer?.name ?? conversation.customer?.email ?? "a visitor";
}
