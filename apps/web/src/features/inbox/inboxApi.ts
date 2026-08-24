import { AuthApiError, NETWORK_ERROR, unwrapEnvelope } from "@/features/auth/authApi";

/**
 * Client for the agent inbox endpoints (ADR-025 §3).
 *
 * The envelope reader and its error type come from the auth feature — the
 * same reuse `organizationsApi.ts` and `widgetConfigApi.ts` already
 * established, so there is one definition of what a Serviqo response looks
 * like rather than a fourth copy per feature folder.
 */

const ORGANIZATIONS_BASE = "/api/v1/organizations";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** What the staff projection reports about the customer a conversation is with (ADR-025 §7). */
export interface InboxCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * The staff member handling a conversation (ADR-026 §11).
 *
 * `id` is always present; `name` is `null` unless the signed-in reader's role
 * holds `member.read`. The client never decides that — the server does, from
 * the role it read on this request — so a `null` name here means "not
 * disclosed to you", and the UI says "another agent" rather than inventing
 * one.
 *
 * The `id` is what lets the UI tell the reader's own work from a colleague's
 * without knowing who the colleague is.
 */
export interface InboxAssignee {
  id: string;
  name: string | null;
}

/** `open` while the exchange is live, `closed` once an agent has finished it (ADR-026 §7). */
export type InboxConversationStatus = "open" | "closed";

export interface InboxConversation {
  id: string;
  status: string;
  createdAt: string;
  lastMessageAt: string;
  /** `null` for a conversation whose customer no longer resolves inside this tenant. */
  customer: InboxCustomer | null;
  /** `null` when nobody has claimed it (ADR-026 §1). */
  assignedTo: InboxAssignee | null;
}

/**
 * The narrow projection `conversation:updated` carries (ADR-026 §9).
 *
 * Deliberately smaller than `InboxConversation`: no customer, because it did
 * not change and the row already has it, and no assignee NAME, because a
 * broadcast has no single reader to run the `member.read` check against. The
 * client merges these fields into the row it already holds.
 */
export interface InboxConversationUpdate {
  id: string;
  status: string;
  lastMessageAt: string;
  assignedTo: InboxAssignee | null;
}

/**
 * Shared by both transports (ADR-023 §7): the REST history read and the
 * socket's `message:new` payload carry the identical shape, which is what
 * lets the inbox funnel both through one append path.
 */
export interface InboxMessage {
  id: string;
  conversationId: string;
  senderType: "customer" | "agent";
  body: string;
  createdAt: string;
}

export interface ConversationPage {
  conversations: InboxConversation[];
  nextCursor: string | null;
}

export interface MessagePage {
  messages: InboxMessage[];
  nextCursor: string | null;
}

function conversationsPath(organizationId: string, suffix = ""): string {
  return `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/conversations${suffix}`;
}

/**
 * Performs one inbox call and unwraps it.
 *
 * A transport failure becomes an `AuthApiError` with status 0 rather than a
 * raw `TypeError`, so every caller branches on one error type — the same
 * shape `widgetConfigApi.ts` uses, and what lets the UI tell "the server
 * refused" from "the server was not reachable".
 */
async function callInbox<T>(authorizedFetch: AuthorizedFetch, path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await authorizedFetch(path, init);
  } catch (error) {
    // The refresh behind the retry failed, and it already described itself.
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<T>(response);
}

/**
 * Normalizes a page whose list may not have arrived as one.
 *
 * `unwrapEnvelope` proves the envelope's SHAPE — `success: true` and a `data`
 * key — and nothing about what is inside it, because it is generic over every
 * endpoint. So a response that is well-formed at the envelope level but
 * missing its list still reaches this client, and rendering code that spreads
 * or `.find`s the result would throw during render and take the whole
 * dashboard down with it.
 *
 * Defaulting to an empty list is the same posture the socket path already
 * takes by validating `message:new` before it reaches the renderer: data from
 * the network is checked at the boundary, once, rather than trusted by every
 * consumer. An empty inbox is a legible state; a render-time crash is not.
 */
function toPage<T>(page: { nextCursor?: unknown } | null | undefined, items: unknown): { items: T[]; nextCursor: string | null } {
  return {
    items: Array.isArray(items) ? (items as T[]) : [],
    nextCursor: typeof page?.nextCursor === "string" ? page.nextCursor : null,
  };
}

/**
 * Lists the tenant's conversations, most recently active first
 * (ADR-025 §5).
 *
 * Behind `conversation.read`. A caller whose role lacks it receives a 403,
 * which the UI renders as its own state rather than as a transport failure —
 * it is the one refusal that will never succeed on a retry (ADR-025 §11).
 */
export async function fetchConversations(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
): Promise<ConversationPage> {
  const page = await callInbox<ConversationPage>(authorizedFetch, conversationsPath(organizationId));
  const { items, nextCursor } = toPage<InboxConversation>(page, page?.conversations);
  return { conversations: items, nextCursor };
}

/** Reads one conversation's message history, oldest first (ADR-025 §5). */
export async function fetchMessages(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
): Promise<MessagePage> {
  const page = await callInbox<MessagePage>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/messages`),
  );
  const { items, nextCursor } = toPage<InboxMessage>(page, page?.messages);
  return { messages: items, nextCursor };
}

/**
 * Sends a reply as the organization (ADR-025 §6).
 *
 * The body carries `body` and nothing else. There is deliberately no
 * `senderType` to pass — it is assigned server-side as a literal, and a value
 * sent here would be stripped by the request schema before any handler saw
 * it. Sending one would be this client pretending to a say it does not have.
 */
export function sendAgentMessage(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  body: string,
): Promise<InboxMessage> {
  return callInbox<InboxMessage>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/messages`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
}

/**
 * Claims or releases a conversation (ADR-026 §2, §4).
 *
 * The body carries `action` and nothing else. There is deliberately no
 * `assignedTo` to send: the subject of both verbs is the authenticated caller,
 * resolved server-side from the access token, and a user id sent here would be
 * stripped by the request schema before any handler saw it. Sending one would
 * be this client claiming an authority it does not have.
 *
 * Behind `conversation.assign`. A role without it receives a 403; a
 * conversation another agent holds produces a 409 the caller renders in its
 * own words (ADR-026 §13).
 */
export function updateAssignment(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  action: "claim" | "release",
): Promise<InboxConversation> {
  return callInbox<InboxConversation>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/assignment`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
}

/**
 * Opens or closes a conversation (ADR-026 §2, §7).
 *
 * A SEPARATE endpoint from the assignment one above, not a second field on a
 * shared `PATCH`, because the two are gated by different permissions
 * server-side — `conversation.reply` here, `conversation.assign` there — and a
 * route names exactly one.
 *
 * Reopening can answer 409 when the customer has since opened a newer
 * conversation (ADR-026 §7); that is the one refusal in this client whose
 * cause the UI states, because it is the one an agent can act on.
 */
export function updateConversationStatus(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  status: InboxConversationStatus,
): Promise<InboxConversation> {
  return callInbox<InboxConversation>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/status`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
}
