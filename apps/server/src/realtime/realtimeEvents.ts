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
} as const;

/** One machine-readable code per ack failure, mirroring the REST error codes this transport parallels. */
export type SocketErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "NOT_JOINED" | "TOO_MANY_REQUESTS" | "INTERNAL_ERROR";

export interface SocketErrorPayload {
  code: SocketErrorCode;
  message: string;
}

export type SocketAck<T> = (response: { ok: true; data: T } | { ok: false; error: SocketErrorPayload }) => void;

export interface ConversationJoinPayload {
  conversationId?: unknown;
}

export interface MessageSendPayload {
  conversationId?: unknown;
  body?: unknown;
}

/** One message per code, shared by every handler so a caller cannot distinguish two causes of one code by wording. */
export const SOCKET_ERROR_MESSAGES: Record<SocketErrorCode, string> = {
  VALIDATION_ERROR: "Request validation failed",
  NOT_FOUND: "Conversation not found",
  NOT_JOINED: "Join the conversation before sending messages",
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
