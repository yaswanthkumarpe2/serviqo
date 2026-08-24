import type { WidgetConversation, WidgetMessage, WidgetMessagePage } from "./types";

/**
 * The widget's client for the two conversation REST endpoints ADR-022
 * shipped (ADR-024 §3):
 *
 *   POST /widget/conversations                    → resolve or create
 *   GET  /widget/conversations/:id/messages       → history, cursor-paginated
 *
 * Both are called exactly as ADR-022 specified. Nothing here sends
 * `organizationId`, `customerId`, `senderType`, or `conversationId` in a
 * body — the widget has no way to know the first two and no reason to send
 * the rest, which is ADR-022 §5's rule holding by construction rather than
 * by care.
 *
 * The bearer token is the widget token ADR-019 §8 issued; there is no second
 * credential and no second header (ADR-024 §11).
 */

/**
 * Raised for every failure — refused, malformed, or a transport error that
 * never reached the server.
 *
 * One message, no status code, and no server text, matching
 * `WidgetSessionError`'s own posture and ADR-019 §12's reason for it: the
 * server's refusals are deliberately indistinguishable, so relaying detail
 * the widget does not have would be inventing it.
 */
export class WidgetConversationError extends Error {}

const GENERIC_ERROR_MESSAGE = "Chat is not available right now.";

/**
 * Distinguishes "this credential is no good" from every other failure, so
 * the caller can clear a stored token that the server has refused
 * (ADR-024 §8) instead of re-presenting it on every retry for the rest of
 * the tab's life.
 *
 * A flag on the error rather than a separate class: callers that do not care
 * (every path except the token-clearing one) keep a single `catch`.
 */
export class WidgetAuthError extends WidgetConversationError {}

interface SuccessEnvelope {
  success: true;
  data: unknown;
}

function isSuccessEnvelope(body: unknown): body is SuccessEnvelope {
  return typeof body === "object" && body !== null && (body as { success?: unknown }).success === true;
}

function isWidgetConversation(value: unknown): value is WidgetConversation {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<WidgetConversation>;
  return (
    typeof c.id === "string" &&
    (c.status === "open" || c.status === "closed") &&
    typeof c.createdAt === "string" &&
    typeof c.lastMessageAt === "string"
  );
}

/**
 * Validates one message's shape before it can reach the renderer.
 *
 * `senderType` is checked against the two values ADR-022 §4 defines rather
 * than accepted as any string: the renderer styles by it, and an unknown
 * value silently taking the "customer" branch would misattribute a message —
 * the one rendering mistake in a support conversation that actually matters.
 */
export function isWidgetMessage(value: unknown): value is WidgetMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<WidgetMessage>;
  return (
    typeof m.id === "string" &&
    typeof m.conversationId === "string" &&
    (m.senderType === "customer" || m.senderType === "agent") &&
    typeof m.body === "string" &&
    typeof m.createdAt === "string"
  );
}

function isWidgetMessagePage(value: unknown): value is WidgetMessagePage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Partial<WidgetMessagePage>;
  if (!Array.isArray(page.messages) || !page.messages.every(isWidgetMessage)) return false;
  return page.nextCursor === null || typeof page.nextCursor === "string";
}

function authHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

/**
 * Turns a settled response into the failure this module reports.
 *
 * `401` (`INVALID_WIDGET_TOKEN`) and `403` (`WIDGET_SESSION_REFUSED`) are the
 * two statuses ADR-022 §6 defines for a credential that is unusable or names
 * something that has stopped being valid; both mean "stop presenting this
 * token", so both raise `WidgetAuthError`. Every other status is an ordinary
 * failure the same token can be retried with.
 */
function failureFor(status: number): WidgetConversationError {
  if (status === 401 || status === 403) return new WidgetAuthError(GENERIC_ERROR_MESSAGE);
  return new WidgetConversationError(GENERIC_ERROR_MESSAGE);
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch {
    // The underlying error is neither attached nor logged: it can name
    // internal hosts, and it tells a visitor nothing actionable
    // (ADR-021 §6, ADR-024 §9).
    throw new WidgetConversationError(GENERIC_ERROR_MESSAGE);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || !isSuccessEnvelope(body)) {
    throw failureFor(response.status);
  }

  return body.data;
}

/**
 * Resolves the caller's open conversation, creating one if none exists.
 *
 * Always `201`, resumed or newly created alike (ADR-022 §13) — the widget
 * neither learns nor needs which branch the server took.
 */
export async function resolveConversation(apiBase: string, token: string): Promise<WidgetConversation> {
  const data = await requestJson(`${apiBase}/conversations`, {
    method: "POST",
    headers: authHeaders(token),
    // The endpoint takes no body (ADR-022 §7); `{}` is sent so the request
    // carries valid JSON for `express.json()` rather than an empty entity.
    body: JSON.stringify({}),
  });

  if (!isWidgetConversation(data)) throw new WidgetConversationError(GENERIC_ERROR_MESSAGE);
  return data;
}

export interface ListMessagesOptions {
  /**
   * Exclusive lower bound — the last message id already rendered
   * (ADR-022 §11). Used both for the initial history load (absent) and for
   * the catch-up after a re-join (present, ADR-024 §5).
   */
  cursor?: string;
  limit?: number;
}

/**
 * Reads one page of a conversation's history, oldest first.
 *
 * The caller pages by passing the previous response's `nextCursor` back in
 * (ADR-022 §11) — the widget loads history by walking pages forward until
 * `nextCursor` is `null`, which is the same walk the catch-up performs from
 * a later starting point.
 */
export async function listMessages(
  apiBase: string,
  token: string,
  conversationId: string,
  options: ListMessagesOptions = {},
): Promise<WidgetMessagePage> {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();

  const data = await requestJson(
    `${apiBase}/conversations/${encodeURIComponent(conversationId)}/messages${query.length > 0 ? `?${query}` : ""}`,
    { method: "GET", headers: authHeaders(token) },
  );

  if (!isWidgetMessagePage(data)) throw new WidgetConversationError(GENERIC_ERROR_MESSAGE);
  return data;
}

/**
 * The most pages one history load will walk.
 *
 * A bound rather than an unbounded `while`: a client that trusts the server
 * to eventually return `nextCursor: null` is a client that spins forever if
 * it does not. Twenty pages at ADR-022's default of thirty is six hundred
 * messages — far more than a support conversation, and a definite stop.
 */
export const MAX_HISTORY_PAGES = 20;

/**
 * Walks history forward from `cursor` (or the beginning) to the end,
 * returning every message in order.
 *
 * Used for both the initial load and the post-reconnect catch-up
 * (ADR-024 §3, §5) — one function, because they differ only in where they
 * start. Everything it returns still passes through the caller's
 * de-duplication check (ADR-024 §4), so a catch-up that re-returns an
 * already-rendered message is harmless by construction.
 */
export async function loadHistory(
  apiBase: string,
  token: string,
  conversationId: string,
  cursor?: string,
): Promise<WidgetMessage[]> {
  const collected: WidgetMessage[] = [];
  let next = cursor;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const result = await listMessages(apiBase, token, conversationId, next === undefined ? {} : { cursor: next });
    collected.push(...result.messages);

    if (result.nextCursor === null) break;
    next = result.nextCursor;
  }

  return collected;
}
