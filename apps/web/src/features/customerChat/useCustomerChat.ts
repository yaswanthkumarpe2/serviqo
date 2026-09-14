import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";

import { fetchMyMessages, sendMyMessage, startConversation } from "./customerChatApi";

import type { CustomerMessage } from "./customerChatApi";

/**
 * The customer's live chat with support (ADR-034 §6).
 *
 * Opens (or resumes) the one conversation this customer has, loads its
 * history, and keeps it current.
 *
 * **Polling, not a socket, and that is a deliberate limitation rather than an
 * oversight.** Serviqo's realtime transport authenticates a customer with a
 * WIDGET token (ADR-023), which a signed-in customer does not hold — wiring
 * this to the socket means teaching the handshake a second customer credential,
 * which is its own slice with its own security argument. A three-second poll
 * is indistinguishable from live at support-chat pace, costs one small request
 * per tick, and stops entirely when the tab is hidden. The socket path is the
 * upgrade, and nothing here has to change shape for it: this hook already owns
 * "how messages arrive".
 */

/** How often the open conversation is re-read while the tab is visible. */
const POLL_INTERVAL_MS = 3000;

export interface CustomerChatState {
  conversationId: string | null;
  messages: CustomerMessage[];
  /** True until the first load settles. Nothing real is known before it does. */
  isLoading: boolean;
  isSending: boolean;
  /**
   * Set when the deployment has no organization yet — the tenant a customer
   * would be talking to does not exist. Its own state because it is not the
   * reader's fault and retrying cannot fix it.
   */
  isUnavailable: boolean;
  error: string | null;
  sendError: string | null;
  send: (body: string) => Promise<void>;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your chat. Please try again.";
const GENERIC_SEND_MESSAGE = "Your message could not be sent. Please try again.";

export function useCustomerChat(): CustomerChatState {
  const { authorizedFetch, signOut } = useAuth();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CustomerMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  /**
   * Ids already rendered.
   *
   * The poll returns the whole history each time, and a customer's own message
   * arrives twice by design — once from the send, once from the next poll. This
   * is what makes the merge idempotent instead of duplicating every line the
   * customer types.
   */
  const seenIds = useRef<Set<string>>(new Set());

  /** Guards the one open-or-resume per mount, the way every other hook here does. */
  const hasOpened = useRef(false);

  const merge = useCallback((incoming: CustomerMessage[]) => {
    const fresh = incoming.filter((message) => !seenIds.current.has(message.id));
    if (fresh.length === 0) return;

    for (const message of fresh) seenIds.current.add(message.id);
    setMessages((current) => [...current, ...fresh]);
  }, []);

  /**
   * Opens the conversation and loads its history.
   *
   * Writes no state synchronously — it runs from an effect, and a synchronous
   * setState in an effect body cascades a render, which React's own lint rule
   * refuses. `isLoading` already starts `true`.
   */
  const open = useCallback(async () => {
    try {
      const conversation = await startConversation(authorizedFetch);
      setConversationId(conversation.id);
      merge(await fetchMyMessages(authorizedFetch, conversation.id));
      setIsUnavailable(false);
      setError(null);
    } catch (caught: unknown) {
      /*
        A 401 has already been through one refresh and one replay. Surviving
        that means this browser is not signed in — signing out is the correct
        response and reaches the login page through the route guard, with no
        imperative navigation from inside a data hook.
      */
      if (caught instanceof AuthApiError && caught.status === 401) {
        void signOut();
        return;
      }

      // No organization exists yet, so there is nobody to talk to.
      if (caught instanceof AuthApiError && caught.status === 404) {
        setIsUnavailable(true);
        setError(null);
        return;
      }

      setError(GENERIC_FAILURE_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  }, [authorizedFetch, merge, signOut]);

  useEffect(() => {
    if (hasOpened.current) return;
    hasOpened.current = true;
    void open();
  }, [open]);

  /**
   * Keeps the thread current while the tab is visible.
   *
   * Paused when hidden, which is most of the time for most tabs: a background
   * tab polling every three seconds forever is a battery and bandwidth cost
   * paid for nothing, since nobody is reading it. The listener re-reads
   * immediately on return, so coming back to the tab shows the current thread
   * rather than one up to three seconds stale.
   */
  useEffect(() => {
    if (conversationId === null) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = () => {
      void fetchMyMessages(authorizedFetch, conversationId)
        .then(merge)
        /*
          A failed poll is deliberately silent. The thread on screen is still
          correct, the next tick may well succeed, and an error banner that
          appears and disappears every few seconds is worse than a thread that
          is briefly a few seconds behind.
        */
        .catch(() => undefined);
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(poll, POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        poll();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [authorizedFetch, conversationId, merge]);

  const send = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (trimmed.length === 0 || conversationId === null || isSending) return;

      setIsSending(true);
      setSendError(null);

      try {
        /*
          The sent message is merged from the RESPONSE rather than added
          optimistically. An optimistic line has no server id, so the poll that
          follows cannot recognise it as already-shown and renders it twice —
          and a message that appears, duplicates, then settles is worse than one
          that appears a few hundred milliseconds late.
        */
        merge([await sendMyMessage(authorizedFetch, conversationId, trimmed)]);
      } catch (caught: unknown) {
        if (caught instanceof AuthApiError && caught.status === 401) {
          void signOut();
          return;
        }
        setSendError(GENERIC_SEND_MESSAGE);
      } finally {
        setIsSending(false);
      }
    },
    [authorizedFetch, conversationId, isSending, merge, signOut],
  );

  return { conversationId, messages, isLoading, isSending, isUnavailable, error, sendError, send };
}
