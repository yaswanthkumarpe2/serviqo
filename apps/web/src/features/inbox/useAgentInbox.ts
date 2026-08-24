import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import {
  fetchConversations,
  fetchMessages,
  sendAgentMessage,
  updateAssignment,
  updateConversationStatus,
} from "./inboxApi";
import { createInboxRealtimeClient } from "./inboxRealtime";

import type { InboxConversation, InboxConversationStatus, InboxMessage } from "./inboxApi";
import type { InboxRealtimeStatus, InboxSocketFactory } from "./inboxRealtime";

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
export type ConversationActionKind = "claim" | "release" | "close" | "reopen";

export interface UseAgentInboxOptions {
  organizationId: string;
  /** Injected by tests so the socket layer runs against a fake (ADR-025 §11). */
  socketFactory?: InboxSocketFactory;
}

export interface AgentInbox {
  status: InboxStatus;
  error: string | null;
  conversations: InboxConversation[];

  selectedConversationId: string | null;
  selectConversation: (conversationId: string) => void;

  threadStatus: ThreadStatus;
  threadError: string | null;
  messages: InboxMessage[];

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
  send: (body: string) => Promise<void>;

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
}

const GENERIC_LIST_ERROR = "Could not load conversations. Please try again.";
const GENERIC_THREAD_ERROR = "Could not load this conversation. Please try again.";
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

export function useAgentInbox({ organizationId, socketFactory }: UseAgentInboxOptions): AgentInbox {
  const { authorizedFetch, session } = useAuth();

  const [status, setStatus] = useState<InboxStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<InboxConversation[]>([]);

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [threadStatus, setThreadStatus] = useState<ThreadStatus>("idle");
  const [threadError, setThreadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);

  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [realtimeStatus, setRealtimeStatus] = useState<InboxRealtimeStatus>("connecting");

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<ConversationActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const loadConversations = useCallback(async () => {
    try {
      const page = await fetchConversations(authorizedFetch, organizationId);
      setConversations(page.conversations);
      setStatus("ready");
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
  }, [authorizedFetch, organizationId]);

  useEffect(() => {
    if (loadedFor.current === organizationId) return;
    loadedFor.current = organizationId;

    void loadConversations();
  }, [loadConversations, organizationId]);

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

    // A new thread starts with a fresh identity set: ids from the previous
    // conversation would otherwise suppress nothing useful and grow forever.
    seenMessageIds.current = new Set();

    // Selecting is what clears the indicator. Nothing is reported to the
    // server — this is a local hint, not a read receipt (ADR-025 §12).
    setUnreadCounts((counts) => {
      if (counts[conversationId] === undefined) return counts;
      const next = { ...counts };
      delete next[conversationId];
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectedConversationId === null) return;

    let cancelled = false;

    void fetchMessages(authorizedFetch, organizationId, selectedConversationId)
      .then((page) => {
        if (cancelled) return;
        for (const message of page.messages) seenMessageIds.current.add(message.id);
        setMessages(page.messages);
        setThreadStatus("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof AuthApiError && caught.status === 401) return;

        setMessages([]);
        setThreadError(
          caught instanceof AuthApiError && caught.status === 404
            ? "That conversation is no longer available."
            : GENERIC_THREAD_ERROR,
        );
        setThreadStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [authorizedFetch, organizationId, selectedConversationId]);

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
          if (message.conversationId === selectedRef.current) {
            if (seenMessageIds.current.has(message.id)) return;
            seenMessageIds.current.add(message.id);
            setMessages((current) => [...current, message]);
          } else {
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
              };
            }),
          );
        },
      },
    });

    client.connect();
    return () => client.destroy();
  }, [accessToken, organizationId, socketFactory]);

  // ---- sending ----

  const send = useCallback(
    async (body: string) => {
      const conversationId = selectedConversationId;
      if (conversationId === null) return;

      const trimmed = body.trim();
      if (trimmed.length === 0) return;

      setIsSending(true);
      setSendError(null);

      try {
        const message = await sendAgentMessage(authorizedFetch, organizationId, conversationId, trimmed);

        // Through the same id check as the socket path: the broadcast for
        // this very message may already have arrived.
        if (!seenMessageIds.current.has(message.id)) {
          seenMessageIds.current.add(message.id);
          setMessages((current) => [...current, message]);
        }
      } catch (caught: unknown) {
        if (caught instanceof AuthApiError && caught.status === 401) return;

        /*
          The server's own message is not shown. A 429 in particular carries
          text about Serviqo's defences, and a 403/404 is deliberately opaque
          — the UI renders its own copy for all of them (ADR-019 §12's
          posture, applied to a staff surface).
        */
        setSendError(GENERIC_SEND_ERROR);
      } finally {
        setIsSending(false);
      }
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
    selectedConversationId,
    selectConversation,
    threadStatus,
    threadError,
    messages,
    unreadCounts,
    realtimeStatus,
    isSending,
    sendError,
    send,
    /*
      From the session the provider holds, which came from the login response
      — the same id the server compares `assignedTo` against. Used only to
      render "Assigned to you" versus a colleague; it authorizes nothing,
      because the server re-proves every request regardless (ADR-017 §10).
    */
    currentUserId: session?.user.id ?? null,
    pendingAction,
    actionError,
    claim,
    release,
    setConversationStatus,
  };
}
