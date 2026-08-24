import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { fetchConversations, fetchMessages, sendAgentMessage } from "./inboxApi";
import { createInboxRealtimeClient } from "./inboxRealtime";

import type { InboxConversation, InboxMessage } from "./inboxApi";
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
}

const GENERIC_LIST_ERROR = "Could not load conversations. Please try again.";
const GENERIC_THREAD_ERROR = "Could not load this conversation. Please try again.";
const GENERIC_SEND_ERROR = "Message not sent. Please try again.";

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
  };
}
