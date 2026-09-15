/**
 * The Socket.IO event contract (ADR-023 §5). One file names every event and
 * every payload shape, so the server handlers and any future client
 * implementation read one source of truth rather than agreeing on string
 * literals by convention.
 */

export const SOCKET_EVENTS = {
  /** Client → server. Join the caller's own conversation room. */
  CONVERSATION_JOIN: "conversation:join",
  /** Client → server. Send a customer message into an already-joined conversation. */
  MESSAGE_SEND: "message:send",
  /** Server → room. A persisted message, broadcast to every socket that joined its conversation. */
  MESSAGE_NEW: "message:new",
  /**
   * Server → the tenant's inbox room ONLY. A conversation's assignment or
   * status changed (ADR-026 §10).
   *
   * Deliberately not broadcast to the conversation room, unlike
   * `MESSAGE_NEW`. The payload carries `assignedTo`, which names a member of
   * the tenant's staff, and which employee is handling a ticket is internal
   * operational detail that must not cross to the customer.
   */
  CONVERSATION_UPDATED: "conversation:updated",
  /** Whether anyone is available to answer, sent to an organisation's visitors (ADR-040 §2). */
  PRESENCE_UPDATE: "presence:update",
  /** Someone started or stopped typing in a conversation (ADR-040 §3). Both directions. */
  TYPING: "typing",
  /** A side read a conversation; clears unread counts and shows "Seen" (ADR-040 §4). Both directions. */
  CONVERSATION_READ: "conversation:read",
  /** A new internal note, to the organisation's inbox room only (ADR-042 §2). */
  NOTE_NEW: "note:new",
} as const;

/** One machine-readable code per ack failure, mirroring the REST error codes this transport parallels. */
export type SocketErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "NOT_JOINED"
  | "CONVERSATION_CLOSED"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_ERROR";

export interface SocketErrorPayload {
  code: SocketErrorCode;
  message: string;
}

export type SocketAck<T> = (response: { ok: true; data: T } | { ok: false; error: SocketErrorPayload }) => void;

export interface ConversationJoinPayload {
  conversationId?: unknown;
}

export interface TypingPayload {
  conversationId?: unknown;
  isTyping?: unknown;
}

export interface ConversationReadPayload {
  conversationId?: unknown;
}

export interface MessageSendPayload {
  conversationId?: unknown;
  body?: unknown;
  /** Files uploaded beforehand (ADR-041 §1). */
  attachmentIds?: unknown;
}

/** One message per code, shared by every handler so a caller cannot distinguish two causes of one code by wording. */
export const SOCKET_ERROR_MESSAGES: Record<SocketErrorCode, string> = {
  VALIDATION_ERROR: "Request validation failed",
  NOT_FOUND: "Conversation not found",
  NOT_JOINED: "Join the conversation before sending messages",
  /*
    The socket half of ADR-026 §6's refusal, worded identically to the REST
    one so the two transports refuse the same write with the same words —
    the property ADR-023 §6 established by having this handler reuse
    `messageService.create` verbatim rather than reimplementing it.

    The widget branches on this CODE to recover (ADR-026 §8), which is the
    reason it is a distinct code rather than folded into `NOT_FOUND`: a client
    that cannot tell "closed" from "gone" cannot resolve a new conversation.
  */
  CONVERSATION_CLOSED: "This conversation has been closed",
  TOO_MANY_REQUESTS: "Too many requests. Please wait a few minutes and try again.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
};

/** Builds one ack error payload — the single place a `{ code, message }` pair is assembled. */
export function socketError(code: SocketErrorCode): SocketErrorPayload {
  return { code, message: SOCKET_ERROR_MESSAGES[code] };
}

/**
 * Calls an ack callback if the client supplied one, and does nothing if it
 * did not — a client that emits without a callback (a fire-and-forget send)
 * must not crash the handler for lacking one.
 */
export function safeAck<T>(ack: unknown, response: Parameters<SocketAck<T>>[0]): void {
  if (typeof ack === "function") {
    (ack as SocketAck<T>)(response);
  }
}
