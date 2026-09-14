import { io } from "socket.io-client";

import { isWidgetMessage } from "./conversation";

import type { WidgetMessage } from "./types";
import type { Socket } from "socket.io-client";

/**
 * The widget's Socket.IO client (ADR-024 §2).
 *
 * The only module that imports `socket.io-client`. `widget.ts` renders and
 * calls this handle; it never touches `io()` — the same isolation
 * `session.ts` gives the one REST call ADR-021 made, and what lets every
 * test in this slice run against an injected fake with no network.
 *
 * Every event name and payload shape here is ADR-023 §5's contract,
 * unchanged. This module adds no protocol of its own.
 */

/** ADR-023 §5's event names, restated client-side rather than imported across the server boundary. */
const EVENT_CONVERSATION_JOIN = "conversation:join";
const EVENT_MESSAGE_SEND = "message:send";
const EVENT_MESSAGE_NEW = "message:new";
/** ADR-040 §2–4, restated rather than imported across the server boundary. */
const EVENT_PRESENCE = "presence:update";
const EVENT_TYPING = "typing";
const EVENT_READ = "conversation:read";

/**
 * What the widget shows about the connection (ADR-024 §7). The panel stays
 * usable in every state except `failed`, which is the only one where no path
 * to the server exists.
 */
export type RealtimeStatus = "connecting" | "connected" | "reconnecting" | "failed";

/** ADR-023 §5's ack envelope. */
type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface RealtimeCallbacks {
  /** A message arrived over `message:new`. De-duplication is the caller's (ADR-024 §4). */
  onMessage(message: WidgetMessage): void;
  onStatusChange(status: RealtimeStatus): void;
  /**
   * The socket connected (first time or after a reconnect) and the caller
   * should re-join and catch up (ADR-023 §10, ADR-024 §5).
   *
   * Fired from the `connect` handler on every connection, so the first and
   * the thousandth take the identical code path and no "reconnect" branch
   * exists that could rot from never running in development.
   */
  onConnected(): void;
  /**
   * The handshake was refused as an authentication failure. The caller
   * clears the stored token (ADR-024 §8) rather than re-presenting a
   * credential the server has already rejected.
   */
  onAuthFailure(): void;
  /** Whether an agent of this organisation is connected (ADR-040 §2). */
  onPresence?(agentsOnline: boolean): void;
  /** An agent started or stopped typing in a conversation (ADR-040 §3). */
  onAgentTyping?(conversationId: string, isTyping: boolean): void;
  /** The team read a conversation (ADR-040 §4). */
  onAgentRead?(conversationId: string, readAt: string): void;
}

export interface RealtimeClient {
  connect(): void;
  join(conversationId: string): Promise<void>;
  send(conversationId: string, body: string): Promise<WidgetMessage>;
  /** Fire-and-forget: a lost typing event is harmless (ADR-040 §3). */
  typing(conversationId: string, isTyping: boolean): void;
  /** Fire-and-forget: the next read covers a lost one (ADR-040 §4). */
  markRead(conversationId: string): void;
  destroy(): void;
}

/**
 * Raised when a socket operation does not succeed. Carries the ack's `code`
 * for the caller to branch on, and never the server's message text — the
 * widget renders its own copy (ADR-024 §7, ADR-019 §12).
 */
export class RealtimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Realtime operation failed");
    this.code = code;
  }
}

/**
 * How long an ack may take before the caller gives up.
 *
 * Bounded rather than open-ended: a socket that is connected at the TCP
 * level but whose server has stopped answering would otherwise leave the
 * composer disabled forever, which is the one failure a visitor cannot
 * recover from without reloading the page.
 */
const ACK_TIMEOUT_MS = 10_000;

/** The `io` factory, injectable so tests drive a fake with no network (ADR-024 §2). */
export type SocketFactory = (origin: string, options: Record<string, unknown>) => Socket;

export interface RealtimeOptions {
  socketOrigin: string;
  token: string;
  callbacks: RealtimeCallbacks;
  /** Defaults to the real `socket.io-client` factory. */
  factory?: SocketFactory;
}

export function createRealtimeClient({
  socketOrigin,
  token,
  callbacks,
  factory = io as unknown as SocketFactory,
}: RealtimeOptions): RealtimeClient {
  let socket: Socket | null = null;
  let destroyed = false;

  function connect(): void {
    if (destroyed || socket !== null) return;

    callbacks.onStatusChange("connecting");

    socket = factory(socketOrigin, {
      /*
        The credential travels in the handshake `auth` payload, never a query
        string (ADR-023 §3, ADR-024 §8): a query string reaches proxy logs,
        server access logs, and browser history, and this value is a
        credential.
      */
      auth: { token },

      /*
        WebSocket only, no HTTP long-polling fallback (ADR-024 §1). Avoids
        repeated cross-origin requests to `/socket.io/` against a router
        whose CORS posture is deliberately permissive because the TOKEN is
        the boundary (ADR-023 §9) — correct for one handshake, needlessly
        larger as a transport.

        This is a RUNTIME choice, not a bundle-size one: the Manager imports
        every transport statically, so the polling code ships either way and
        passing the transport class instead of this string was measured to
        change the bundle by nothing (ADR-024 §1 records the number).
      */
      transports: ["websocket"],

      /*
        The library's own reconnection is left enabled: it is the retry
        mechanism ADR-023 §10 assumes the client has. The widget's own
        contribution is re-joining on every `connect` (below), not
        re-implementing backoff.
      */
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      timeout: 10_000,
    });

    socket.on("connect", () => {
      callbacks.onStatusChange("connected");
      callbacks.onConnected();
    });

    socket.on(EVENT_MESSAGE_NEW, (payload: unknown) => {
      // Validated before it can reach the renderer: this is data from the
      // network, and `senderType` decides how a message is attributed.
      if (isWidgetMessage(payload)) callbacks.onMessage(payload);
    });

    socket.on(EVENT_PRESENCE, (payload: unknown) => {
      const agentsOnline = (payload as { agentsOnline?: unknown } | null)?.agentsOnline;
      if (typeof agentsOnline === "boolean") callbacks.onPresence?.(agentsOnline);
    });

    socket.on(EVENT_TYPING, (payload: unknown) => {
      const event = payload as { conversationId?: unknown; sender?: unknown; isTyping?: unknown } | null;
      if (typeof event?.conversationId === "string" && event.sender === "agent" && typeof event.isTyping === "boolean") {
        callbacks.onAgentTyping?.(event.conversationId, event.isTyping);
      }
    });

    socket.on(EVENT_READ, (payload: unknown) => {
      const event = payload as { conversationId?: unknown; reader?: unknown; readAt?: unknown } | null;
      if (typeof event?.conversationId === "string" && event.reader === "agent" && typeof event.readAt === "string") {
        callbacks.onAgentRead?.(event.conversationId, event.readAt);
      }
    });

    socket.on("disconnect", () => {
      if (destroyed) return;
      // The library retries underneath; the conversation stays readable
      // while it does (ADR-024 §7).
      callbacks.onStatusChange("reconnecting");
    });

    socket.on("connect_error", (error: Error) => {
      if (destroyed) return;

      /*
        The server refuses a bad credential with one of ADR-023 §3's two
        constants. Matching on them is what lets the widget clear a token the
        server has rejected (ADR-024 §8) rather than retrying it forever.

        The error is NOT logged, here or anywhere: a socket error's own
        `description` names internal hosts and ports (ADR-024 §9).
      */
      if (isAuthRefusal(error)) {
        callbacks.onStatusChange("failed");
        callbacks.onAuthFailure();
        // Stop the library retrying a credential already refused — every
        // attempt would fail identically for the life of the tab.
        socket?.disconnect();
        return;
      }

      callbacks.onStatusChange("reconnecting");
    });
  }

  /**
   * Emits with an ack and a bound wait (see `ACK_TIMEOUT_MS`).
   *
   * One helper for both `conversation:join` and `message:send`, since
   * ADR-023 §5 gave them the identical ack envelope.
   */
  function emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const active = socket;
      if (active === null || !active.connected) {
        reject(new RealtimeError("NOT_CONNECTED"));
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new RealtimeError("TIMEOUT"));
      }, ACK_TIMEOUT_MS);

      active.emit(event, payload, (ack: Ack<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (ack !== null && typeof ack === "object" && ack.ok === true) {
          resolve(ack.data);
          return;
        }

        const code =
          ack !== null && typeof ack === "object" && ack.ok === false && typeof ack.error?.code === "string"
            ? ack.error.code
            : "UNKNOWN";
        reject(new RealtimeError(code));
      });
    });
  }

  async function join(conversationId: string): Promise<void> {
    await emitWithAck(EVENT_CONVERSATION_JOIN, { conversationId });
  }

  async function send(conversationId: string, body: string): Promise<WidgetMessage> {
    const data = await emitWithAck<unknown>(EVENT_MESSAGE_SEND, { conversationId, body });
    if (!isWidgetMessage(data)) throw new RealtimeError("MALFORMED_ACK");
    return data;
  }

  function typing(conversationId: string, isTyping: boolean): void {
    if (socket?.connected) socket.emit(EVENT_TYPING, { conversationId, isTyping });
  }

  function markRead(conversationId: string): void {
    if (socket?.connected) socket.emit(EVENT_READ, { conversationId }, () => undefined);
  }

  function destroy(): void {
    destroyed = true;
    if (socket !== null) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
  }

  return { connect, join, send, typing, markRead, destroy };
}

/**
 * Whether a `connect_error` names a refused credential rather than a
 * transport failure.
 *
 * Matched against ADR-023 §3's two exact constants — the server sends the
 * message text as the entire refusal, so the text is the only signal
 * available. A transport failure ("xhr poll error", "timeout",
 * "websocket error") matches neither and is retried.
 */
function isAuthRefusal(error: Error): boolean {
  const message = error?.message ?? "";
  return message === "Authentication required" || message === "This chat widget is not available.";
}
