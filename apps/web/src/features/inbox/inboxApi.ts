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
  /** Optional contact detail the visitor gave (ADR-038 §5). */
  phone?: string | null;
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
  /** Customer messages nobody on the team has read (ADR-040 §4). Absent from older servers. */
  unreadCount?: number;
  /** When the team last read it. */
  agentLastReadAt?: string | null;
  /** When the customer last read it, for "Seen" under an agent's reply. */
  customerLastReadAt?: string | null;
  /** The team's labels (ADR-042 §3). Absent from servers before ADR-042. */
  tags?: string[];
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
  tags?: string[];
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
  /** Empty when the message is only files (ADR-041 §1). */
  body: string;
  /** Absent from servers before ADR-041. */
  attachments?: InboxAttachment[];
  createdAt: string;
}

/** A file sent in a message (ADR-041 §3). `url` is a path on this app's own API. */
export interface InboxAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export interface ConversationPage {
  conversations: InboxConversation[];
  nextCursor: string | null;
}

export interface MessagePage {
  messages: InboxMessage[];
  nextCursor: string | null;
}

/**
 * One page request, for either list (ADR-025 §5).
 *
 * `cursor` is the opaque `nextCursor` a previous page returned, passed back
 * verbatim — this client never parses or constructs one. The server validates
 * its shape strictly and answers a malformed value with a 400 rather than an
 * empty page, so a cursor that has been tampered with fails loudly instead of
 * looking like the end of the history.
 */
export interface PageRequest {
  /** `null` or absent means the first page. */
  cursor?: string | null;
  limit?: number;
}

/** What the conversation list is narrowed to (ADR-042 §3–4). Every field is optional. */
export interface ConversationFilters {
  q?: string;
  tag?: string;
  status?: InboxConversationStatus;
  assignee?: "me" | "unassigned";
}

/** An internal note: staff-only, never shown to the customer (ADR-042 §2). */
export interface InboxNote {
  id: string;
  conversationId: string;
  author: { id: string; name: string | null };
  body: string;
  mentions: { id: string; name: string | null }[];
  createdAt: string;
}

export interface SavedReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  updatedAt?: string;
}

export interface Teammate {
  id: string;
  name: string | null;
}

function conversationsPath(organizationId: string, suffix = ""): string {
  return `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/conversations${suffix}`;
}

/**
 * Appends `cursor` and `limit` to a path, omitting either when it has nothing
 * to say.
 *
 * An absent parameter and an empty one are NOT the same to the server: its
 * schema rejects `?cursor=` as malformed, so a first page must send no cursor
 * key at all rather than an empty one.
 */
function withPage(path: string, page: PageRequest | undefined): string {
  const params = new URLSearchParams();

  if (page?.cursor !== undefined && page.cursor !== null) params.set("cursor", page.cursor);
  if (page?.limit !== undefined) params.set("limit", String(page.limit));

  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

/**
 * Performs one inbox call and unwraps it.
 *
 * A transport failure becomes an `AuthApiError` with status 0 rather than a
 * raw `TypeError`, so every caller branches on one error type — the same
 * shape `widgetConfigApi.ts` uses, and what lets the UI tell "the server
 * refused" from "the server was not reachable".
 */
export async function callInbox<T>(authorizedFetch: AuthorizedFetch, path: string, init?: RequestInit): Promise<T> {
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
  request?: PageRequest,
  filters: ConversationFilters = {},
): Promise<ConversationPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.length > 0) params.set(key, value);
  }
  const base = withPage(conversationsPath(organizationId), request);
  const query = params.toString();
  const page = await callInbox<ConversationPage>(
    authorizedFetch,
    query.length === 0 ? base : `${base}${base.includes("?") ? "&" : "?"}${query}`,
  );
  const { items, nextCursor } = toPage<InboxConversation>(page, page?.conversations);
  return { conversations: items, nextCursor };
}

/**
 * Reads one page of a conversation's message history, oldest first
 * (ADR-025 §5).
 *
 * Pages FORWARD, and the direction is the opposite of `fetchConversations`'s
 * — worth stating here because the asymmetry is easy to get backwards and was
 * the cause of the bug this paging closes. The server sorts messages by
 * ascending `_id` and its cursor selects `_id > cursor`, so the first page is
 * the OLDEST messages and each subsequent page is NEWER. A caller that reads
 * one page and stops is showing the beginning of the conversation, not the
 * end.
 */
export async function fetchMessages(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  request?: PageRequest,
): Promise<MessagePage> {
  const page = await callInbox<MessagePage>(
    authorizedFetch,
    withPage(conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/messages`), request),
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
  attachmentIds: string[] = [],
): Promise<InboxMessage> {
  return callInbox<InboxMessage>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/messages`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attachmentIds.length > 0 ? { body, attachmentIds } : { body }),
    },
  );
}

/**
 * Uploads one file into a conversation, ready to send (ADR-041 §2). The file
 * is the whole body; its name travels URI-encoded in `X-Filename`.
 */
export function uploadInboxAttachment(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  file: File,
): Promise<InboxAttachment> {
  return callInbox<InboxAttachment>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/attachments`),
    {
      method: "POST",
      headers: { "Content-Type": file.type, "X-Filename": encodeURIComponent(file.name) },
      body: file,
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

// ---- agent productivity (ADR-042) ----

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchNotes(authorizedFetch: AuthorizedFetch, organizationId: string, conversationId: string): Promise<InboxNote[]> {
  const data = await callInbox<{ notes?: unknown }>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/notes`),
  );
  return Array.isArray(data?.notes) ? (data.notes as InboxNote[]) : [];
}

export function createNote(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  body: string,
  mentionedUserIds: string[],
): Promise<InboxNote> {
  return callInbox<InboxNote>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/notes`),
    json("POST", { body, mentionedUserIds }),
  );
}

export function updateConversationTags(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  conversationId: string,
  tags: string[],
): Promise<InboxConversation> {
  return callInbox<InboxConversation>(
    authorizedFetch,
    conversationsPath(organizationId, `/${encodeURIComponent(conversationId)}/tags`),
    json("PUT", { tags }),
  );
}

export async function fetchConversationTags(authorizedFetch: AuthorizedFetch, organizationId: string): Promise<string[]> {
  const data = await callInbox<{ tags?: unknown }>(authorizedFetch, conversationsPath(organizationId, "/tags"));
  return Array.isArray(data?.tags) ? (data.tags as string[]) : [];
}

function savedRepliesPath(organizationId: string, suffix = ""): string {
  return `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/saved-replies${suffix}`;
}

export async function fetchSavedReplies(authorizedFetch: AuthorizedFetch, organizationId: string): Promise<SavedReply[]> {
  const data = await callInbox<{ savedReplies?: unknown }>(authorizedFetch, savedRepliesPath(organizationId));
  return Array.isArray(data?.savedReplies) ? (data.savedReplies as SavedReply[]) : [];
}

export function createSavedReply(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  input: { shortcut: string; title: string; body: string },
): Promise<SavedReply> {
  return callInbox<SavedReply>(authorizedFetch, savedRepliesPath(organizationId), json("POST", input));
}

export function updateSavedReply(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  savedReplyId: string,
  input: Partial<{ shortcut: string; title: string; body: string }>,
): Promise<SavedReply> {
  return callInbox<SavedReply>(
    authorizedFetch,
    savedRepliesPath(organizationId, `/${encodeURIComponent(savedReplyId)}`),
    json("PATCH", input),
  );
}

export async function deleteSavedReply(authorizedFetch: AuthorizedFetch, organizationId: string, savedReplyId: string): Promise<void> {
  let response: Response;
  try {
    response = await authorizedFetch(savedRepliesPath(organizationId, `/${encodeURIComponent(savedReplyId)}`), { method: "DELETE" });
  } catch (error) {
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }
  if (!response.ok) await unwrapEnvelope(response);
}

export async function fetchTeammates(authorizedFetch: AuthorizedFetch, organizationId: string): Promise<Teammate[]> {
  const data = await callInbox<{ teammates?: unknown }>(
    authorizedFetch,
    `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/teammates`,
  );
  return Array.isArray(data?.teammates) ? (data.teammates as Teammate[]) : [];
}
