import { AuthApiError, NETWORK_ERROR, unwrapEnvelope } from "@/features/auth/authApi";

/**
 * Client for the signed-in customer's own chat (ADR-034 §5).
 *
 * Talks to `/api/v1/me`, the one prefix in the API that names neither a tenant
 * nor a resource: a customer's organization, conversations and messages are
 * all derived from their token. There is nothing here to pass an
 * `organizationId` to, and that is the point — a cross-tenant request is not
 * expressible from this surface rather than merely refused.
 *
 * The envelope reader and error type come from the auth feature, the same
 * reuse every other feature client makes.
 */

const ME_BASE = "/api/v1/me";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** One of the caller's own conversations. The same projection the widget receives. */
export interface CustomerConversation {
  id: string;
  status: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface CustomerMessage {
  id: string;
  conversationId: string;
  senderType: "customer" | "agent";
  body: string;
  createdAt: string;
}

async function callMe<T>(authorizedFetch: AuthorizedFetch, path: string, init?: RequestInit): Promise<T> {
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
 * The caller's own conversations, newest activity first.
 *
 * Defends against a well-formed envelope with no list, like every other list
 * client here: `unwrapEnvelope` proves the envelope's SHAPE and nothing about
 * its contents, and rendering code that mapped over `undefined` would throw
 * during render and take the page down.
 */
export async function fetchMyConversations(authorizedFetch: AuthorizedFetch): Promise<CustomerConversation[]> {
  const page = await callMe<{ conversations?: unknown }>(authorizedFetch, `${ME_BASE}/conversations`);

  return Array.isArray(page?.conversations) ? (page.conversations as CustomerConversation[]) : [];
}

/**
 * Opens the live chat, or returns the one already open.
 *
 * Safe to call on every visit: the server resolves rather than creates, and a
 * customer has at most one open conversation per tenant.
 */
export function startConversation(authorizedFetch: AuthorizedFetch): Promise<CustomerConversation> {
  return callMe<CustomerConversation>(authorizedFetch, `${ME_BASE}/conversations`, { method: "POST" });
}

export async function fetchMyMessages(
  authorizedFetch: AuthorizedFetch,
  conversationId: string,
): Promise<CustomerMessage[]> {
  const page = await callMe<{ messages?: unknown }>(
    authorizedFetch,
    `${ME_BASE}/conversations/${encodeURIComponent(conversationId)}/messages`,
  );

  return Array.isArray(page?.messages) ? (page.messages as CustomerMessage[]) : [];
}

/**
 * Sends a message as the customer.
 *
 * The body carries `body` and nothing else. There is deliberately no
 * `senderType` to send: the server assigns it as a literal, so no request can
 * make a customer's message claim to be an agent's.
 */
export function sendMyMessage(
  authorizedFetch: AuthorizedFetch,
  conversationId: string,
  body: string,
): Promise<CustomerMessage> {
  return callMe<CustomerMessage>(
    authorizedFetch,
    `${ME_BASE}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
}
