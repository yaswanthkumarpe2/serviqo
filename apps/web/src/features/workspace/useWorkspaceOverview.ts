import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { fetchConversations } from "@/features/inbox/inboxApi";

import type { InboxConversation } from "@/features/inbox/inboxApi";

/**
 * What the workspace overview reads (ADR-033 §3).
 *
 * One request — the first page of this tenant's conversations, the same list
 * the inbox opens with — and everything on the overview is derived from it.
 * Nothing here is sample data: if the figures say four open conversations,
 * four conversations came back open.
 *
 * Deliberately NOT `useAgentInbox`. That hook owns a socket, a selected
 * thread, unread bookkeeping and a send path, and the overview needs none of
 * them; mounting it twice would open a second socket for a panel nobody is
 * typing into. The overview is a snapshot, and it re-reads when you return to
 * it or press Refresh.
 *
 * The honesty problem this hook has to solve: the server pages, so the first
 * page is not necessarily the whole tenant. A count derived from one page
 * would be presented as a total and silently be wrong for any tenant past the
 * page size. `isComplete` is how the UI tells the two apart — it is true only
 * when the server said there is no next page, and the figures are exact
 * totals; when it is false they are counts over the most recent page and the
 * UI must say so (CONTRIBUTING.md: demo data must say what it is, and a
 * number that is not what it claims is worse than demo data).
 */

/** One customer this tenant has actually talked to, derived from its conversations. */
export interface WorkspaceContact {
  id: string;
  /** `null` for an anonymous visitor who never gave one — rendered as such, never invented. */
  name: string | null;
  email: string | null;
  conversationCount: number;
  /** When they were last in touch, from their most recent conversation. */
  lastMessageAt: string;
}

export interface WorkspaceCounts {
  total: number;
  open: number;
  closed: number;
  /** Assigned to the signed-in reader (ADR-026). */
  mine: number;
  unassigned: number;
  contacts: number;
}

export interface WorkspaceOverviewState {
  conversations: InboxConversation[];
  contacts: WorkspaceContact[];
  counts: WorkspaceCounts;
  /**
   * True when the figures cover every conversation this tenant has, rather
   * than the most recent page. See the note above — the UI changes what it
   * claims based on this.
   */
  isComplete: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  /**
   * A refusal this reader's role will never pass — `conversation.read`
   * missing. Its own state because retrying cannot help (ADR-025 §11).
   */
  isForbidden: boolean;
  error: string | null;
  reload: () => void;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your workspace. Please try again.";

const EMPTY_COUNTS: WorkspaceCounts = { total: 0, open: 0, closed: 0, mine: 0, unassigned: 0, contacts: 0 };

/**
 * Rolls the conversation list into the figures the overview shows.
 *
 * One pass, in one place, so the cards and the activity panel can never
 * disagree about what "open" means — they read the same object.
 */
function summarize(conversations: InboxConversation[], currentUserId: string | null): WorkspaceCounts {
  let open = 0;
  let closed = 0;
  let mine = 0;
  let unassigned = 0;
  const customerIds = new Set<string>();

  for (const conversation of conversations) {
    if (conversation.status === "open") open += 1;
    else if (conversation.status === "closed") closed += 1;

    if (conversation.assignedTo === null) unassigned += 1;
    else if (currentUserId !== null && conversation.assignedTo.id === currentUserId) mine += 1;

    if (conversation.customer !== null) customerIds.add(conversation.customer.id);
  }

  return { total: conversations.length, open, closed, mine, unassigned, contacts: customerIds.size };
}

/**
 * Collapses conversations into the people behind them.
 *
 * A contact is a `Customer` this tenant has a conversation with — Serviqo has
 * no contact book of its own, and inventing one here would be inventing data.
 * Conversations arrive newest-first, so the first sighting of a customer is
 * also their most recent, and their `lastMessageAt` needs no comparison.
 *
 * A conversation whose customer is `null` contributes nothing: that is a
 * customer who no longer resolves inside this tenant, and a contact row with
 * no identity is a row nobody can act on.
 */
function toContacts(conversations: InboxConversation[]): WorkspaceContact[] {
  const byId = new Map<string, WorkspaceContact>();

  for (const conversation of conversations) {
    const customer = conversation.customer;
    if (customer === null) continue;

    const existing = byId.get(customer.id);
    if (existing === undefined) {
      byId.set(customer.id, {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        conversationCount: 1,
        lastMessageAt: conversation.lastMessageAt,
      });
      continue;
    }

    existing.conversationCount += 1;
  }

  return [...byId.values()];
}

export function useWorkspaceOverview(
  organizationId: string,
  currentUserId: string | null,
): WorkspaceOverviewState {
  const { authorizedFetch } = useAuth();

  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isForbidden, setIsForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Guards against an older request landing after a newer one, the same way
   * the platform console does. Two presses of Refresh are two in-flight
   * requests and they can settle out of order.
   */
  const loadId = useRef(0);

  const load = useCallback(
    async (isRefresh: boolean) => {
      const id = loadId.current + 1;
      loadId.current = id;

      /*
        No state is written on the way IN for the first load, and that is a
        constraint rather than an omission: this runs from an effect, and a
        synchronous setState in an effect body cascades a render for no visible
        benefit — React's own lint rule refuses it, and `useAgentInbox` records
        the same reasoning. `isLoading` already starts `true`, so there is
        nothing to set.

        A refresh is different: it runs from a click, which is an event, so it
        may announce itself immediately.
      */
      if (isRefresh) setIsRefreshing(true);

      try {
        const page = await fetchConversations(authorizedFetch, organizationId);
        if (loadId.current !== id) return;

        setConversations(page.conversations);
        setIsComplete(page.nextCursor === null);
        setIsForbidden(false);
        setError(null);
      } catch (caught: unknown) {
        if (loadId.current !== id) return;

        /*
          A 403 is the reader's role lacking `conversation.read`. It is not an
          error to retry — it is a fact about this account — so it gets its own
          state and its own copy rather than "please try again".
        */
        if (caught instanceof AuthApiError && caught.status === 403) {
          setIsForbidden(true);
          setError(null);
        } else if (caught instanceof AuthApiError && caught.status === 401) {
          /*
            Already through `authorizedRequest`'s one refresh and one replay.
            The provider has cleared the session, so `ProtectedRoute` redirects
            on the next render — nothing to show and nothing to do here.
          */
          setError(null);
        } else {
          setError(GENERIC_FAILURE_MESSAGE);
        }
      } finally {
        if (loadId.current === id) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [authorizedFetch, organizationId],
  );

  /**
   * Guards the one load per tenant.
   *
   * StrictMode mounts, unmounts and remounts in development, and `load`'s
   * identity changes with the provider callbacks it closes over — which a
   * token refresh inside this very request would cause. Without this, a
   * successful refresh would re-run the effect that triggered it.
   */
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (loadedFor.current === organizationId) return;
    loadedFor.current = organizationId;

    void load(false);
  }, [load, organizationId]);

  const reload = useCallback(() => {
    void load(true);
  }, [load]);

  return {
    conversations,
    contacts: toContacts(conversations),
    counts: conversations.length === 0 ? EMPTY_COUNTS : summarize(conversations, currentUserId),
    isComplete,
    isLoading,
    isRefreshing,
    isForbidden,
    error,
    reload,
  };
}
