import { io } from "socket.io-client";

import type { InboxConversationUpdate, InboxCustomer, InboxMessage, InboxNote } from "./inboxApi";
import type { Socket } from "socket.io-client";

/**
 * The agent inbox's Socket.IO client (ADR-025 §11).
 *
 * The only module in the dashboard that imports `socket.io-client`, mirroring
 * `widget/realtime.ts`'s own isolation and for the identical reason: it is
 * what lets every test in this slice run against an injected fake with no
 * network.
 *
 * Deliberately much smaller than the widget's client. An agent socket JOINS
 * NOTHING and EMITS NOTHING (ADR-025 §8) — the server puts it in its tenant's
 * inbox room at handshake time, and replies go out over REST, whose
 * `requirePermission("conversation.reply")` is the only gate that makes
 * `senderType: "agent"` reachable. So there is no ack envelope here, no
 * join, and no send: this client only listens.
 */

/** ADR-023 §5's event name, restated client-side rather than imported across the server boundary. */
const EVENT_MESSAGE_NEW = "message:new";

/**
 * ADR-026 §10's event name. Delivered to the tenant's inbox room only — a
 * customer's socket never receives it, because the payload names a member of
 * the tenant's staff.
 */
const EVENT_CONVERSATION_UPDATED = "conversation:updated";

/** ADR-040 §3–4's event names, restated rather than imported across the server boundary. */
const EVENT_TYPING = "typing";
const EVENT_READ = "conversation:read";
const EVENT_NOTE_NEW = "note:new";

function isInboxCustomer(value: unknown): value is InboxCustomer {
  if (typeof value !== "object" || value === null) return false;
  const customer = value as Partial<InboxCustomer>;
  return (
    typeof customer.id === "string" &&
    (customer.name === null || typeof customer.name === "string") &&
    (customer.email === null || typeof customer.email === "string")
  );
}

function isInboxNote(value: unknown): value is InboxNote {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Partial<InboxNote>;
  return (
    typeof note.id === "string" &&
    typeof note.conversationId === "string" &&
    typeof note.body === "string" &&
    typeof note.createdAt === "string" &&
    typeof note.author === "object" &&
    note.author !== null &&
    typeof note.author.id === "string" &&
    Array.isArray(note.mentions)
  );
}

/** What the inbox shows about the connection. Mirrors the widget's states (ADR-024 §7). */
export type InboxRealtimeStatus = "connecting" | "connected" | "reconnecting" | "failed";

export interface InboxRealtimeCallbacks {
  /** A message arrived in this tenant. De-duplication is the caller's (ADR-024 §4, ADR-025 §8). */
  onMessage(message: InboxMessage): void;
  /**
   * A conversation in this tenant was claimed, released, closed, or reopened
   * — possibly by another agent (ADR-026 §10, §13).
   *
   * The caller merges the carried fields into the row it already holds. A
   * conversation the list has never seen is ignored, exactly as ADR-025 §13
   * decided for `onMessage`: the next fetch brings it in, and rows do not
   * appear under a reader's cursor.
   */
  onConversationUpdate(update: InboxConversationUpdate): void;
  onStatusChange(status: InboxRealtimeStatus): void;
  /** Someone started or stopped typing in a conversation of this organisation (ADR-040 §3). */
  onTyping?(conversationId: string, sender: "customer" | "agent", isTyping: boolean): void;
  /** Someone read a conversation (ADR-040 §4). */
  onRead?(conversationId: string, reader: "customer" | "agent", readAt: string): void;
  /** A teammate wrote an internal note (ADR-042 §2). Staff-only by the server's room choice. */
  onNote?(note: InboxNote): void;
  /** A customer's details changed or they were blocked (ADR-043). */
  onCustomerUpdated?(customer: InboxCustomer): void;
  /** Two customers were merged: rows for `sourceCustomerId` now belong to `customer` (ADR-043 §4). */
  onCustomerMerged?(sourceCustomerId: string, customer: InboxCustomer): void;
  /**
   * The handshake was refused. The inbox stops retrying rather than
   * re-presenting a credential the server has already rejected — an expired
   * access token is recovered by the provider's own refresh on the next REST
   * call, not by reconnecting in a loop.
   */
  onAuthFailure(): void;
}

export interface InboxRealtimeClient {
  connect(): void;
  /** Fire-and-forget; a lost typing event is harmless (ADR-040 §3). */
  typing(conversationId: string, isTyping: boolean): void;
  /** Fire-and-forget; the next read covers a lost one (ADR-040 §4). */
  markRead(conversationId: string): void;
  destroy(): void;
}

/** The `io` factory, injectable so tests drive a fake with no network. */
export type InboxSocketFactory = (origin: string, options: Record<string, unknown>) => Socket;

export interface InboxRealtimeOptions {
  /**
   * The tenant this socket is for. Sent in the handshake as the DISCRIMINATOR
   * that selects the server's agent branch (ADR-025 §9) — not as an
   * authorization. The server proves membership in this exact organization
   * before accepting the connection, so a value this client got wrong
   * produces a refusal, never access.
   */
  organizationId: string;
  /** The in-memory staff access token. Never persisted by this module. */
  token: string;
  callbacks: InboxRealtimeCallbacks;
  factory?: InboxSocketFactory;
}

/**
 * Same-origin by construction.
 *
 * The dashboard is served from the same origin as the API (in development
 * through Vite's proxy, in production behind one edge), and Socket.IO
 * attaches at the server root rather than under the REST prefix. Passing the
 * page's own origin rather than a configured URL means there is no second
 * place for the API location to be set and disagree with the `/api` proxy.
 */
function sameOrigin(): string {
  return window.location.origin;
}

/** Validates a `message:new` payload before it can reach the renderer. */
function isInboxMessage(value: unknown): value is InboxMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InboxMessage>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.conversationId === "string" &&
    typeof candidate.body === "string" &&
    typeof candidate.createdAt === "string" &&
    // `senderType` decides how a message is attributed in the UI, so a
    // value from the network is checked against the two it may be rather
    // than trusted to be one of them.
    (candidate.senderType === "customer" || candidate.senderType === "agent")
  );
}

/**
 * Validates the `assignedTo` half of a `conversation:updated` payload.
 *
 * `null` is a legitimate value — it is what a release broadcasts — so the
 * check distinguishes "unassigned" from "malformed" rather than treating both
 * as absent. `name` may be `null` and always is over this transport, because
 * a broadcast has no reader to run the `member.read` check against
 * (ADR-026 §11).
 */
function isAssignee(value: unknown): value is InboxConversationUpdate["assignedTo"] {
  if (value === null) return true;
  if (typeof value !== "object") return false;

  const candidate = value as { id?: unknown; name?: unknown };
  return typeof candidate.id === "string" && (candidate.name === null || typeof candidate.name === "string");
}

/**
 * Validates a `conversation:updated` payload before it can reach the
 * renderer.
 *
 * Checked at the boundary, once, for the same reason `isInboxMessage` is:
 * `status` decides whether the composer or the closed notice renders, and a
 * value from the network silently taking the wrong branch would show an agent
 * a composer whose sends the server will refuse.
 */
function isConversationUpdate(value: unknown): value is InboxConversationUpdate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InboxConversationUpdate>;

  return (
    typeof candidate.id === "string" &&
    (candidate.status === "open" || candidate.status === "closed") &&
    typeof candidate.lastMessageAt === "string" &&
    isAssignee(candidate.assignedTo) &&
    (candidate.tags === undefined || (Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === "string")))
  );
}

export function createInboxRealtimeClient({
  organizationId,
  token,
  callbacks,
  factory = io as unknown as InboxSocketFactory,
}: InboxRealtimeOptions): InboxRealtimeClient {
  let socket: Socket | null = null;
  let destroyed = false;

  function connect(): void {
    if (destroyed || socket !== null) return;

    callbacks.onStatusChange("connecting");

    socket = factory(sameOrigin(), {
      /*
        The credential travels in the handshake `auth` payload, never a query
        string (ADR-023 §3): a query string reaches proxy logs, server access
        logs, and browser history, and this value is a credential.
      */
      auth: { token, organizationId },

      // WebSocket only, matching the widget client (ADR-024 §1).
      transports: ["websocket"],

      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      timeout: 10_000,
    });

    socket.on("connect", () => {
      /*
        No re-join on reconnect, unlike the widget (ADR-024 §5): an agent
        socket's room membership is established by the SERVER at handshake
        time from the organization it proved, so a reconnect re-establishes it
        with no client participation. The inbox's own catch-up is the caller
        re-reading the selected thread over REST.
      */
      callbacks.onStatusChange("connected");
    });

    socket.on(EVENT_MESSAGE_NEW, (payload: unknown) => {
      if (isInboxMessage(payload)) callbacks.onMessage(payload);
    });

    socket.on(EVENT_CONVERSATION_UPDATED, (payload: unknown) => {
      if (isConversationUpdate(payload)) callbacks.onConversationUpdate(payload);
    });

    socket.on(EVENT_NOTE_NEW, (payload: unknown) => {
      if (isInboxNote(payload)) callbacks.onNote?.(payload);
    });

    socket.on("customer:updated", (payload: unknown) => {
      if (isInboxCustomer(payload)) callbacks.onCustomerUpdated?.(payload);
    });

    socket.on("customer:merged", (payload: unknown) => {
      const event = payload as { sourceCustomerId?: unknown; customer?: unknown } | null;
      if (event !== null && typeof event.sourceCustomerId === "string" && isInboxCustomer(event.customer)) {
        callbacks.onCustomerMerged?.(event.sourceCustomerId, event.customer);
      }
    });

    socket.on(EVENT_TYPING, (payload: unknown) => {
      const event = payload as { conversationId?: unknown; sender?: unknown; isTyping?: unknown } | null;
      if (
        typeof event?.conversationId === "string" &&
        (event.sender === "customer" || event.sender === "agent") &&
        typeof event.isTyping === "boolean"
      ) {
        callbacks.onTyping?.(event.conversationId, event.sender, event.isTyping);
      }
    });

    socket.on(EVENT_READ, (payload: unknown) => {
      const event = payload as { conversationId?: unknown; reader?: unknown; readAt?: unknown } | null;
      if (
        typeof event?.conversationId === "string" &&
        (event.reader === "customer" || event.reader === "agent") &&
        typeof event.readAt === "string"
      ) {
        callbacks.onRead?.(event.conversationId, event.reader, event.readAt);
      }
    });

    socket.on("disconnect", () => {
      if (destroyed) return;
      // The library retries underneath; the inbox stays readable while it
      // does, because everything already fetched is still on screen.
      callbacks.onStatusChange("reconnecting");
    });

    socket.on("connect_error", (error: Error) => {
      if (destroyed) return;

      /*
        The server refuses a bad credential with one of ADR-023 §3's two
        constants, and every agent-branch refusal — bad token, not a member,
        suspended tenant, insufficient role — arrives as one of them
        (ADR-025 §9). Matching on them is what stops the library retrying a
        connection that will fail identically forever.

        The error is NOT logged: a socket error's own `description` names
        internal hosts and ports (ADR-024 §9).
      */
      if (isAuthRefusal(error)) {
        callbacks.onStatusChange("failed");
        callbacks.onAuthFailure();
        socket?.disconnect();
        return;
      }

      callbacks.onStatusChange("reconnecting");
    });
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

  return { connect, typing, markRead, destroy };
}

/**
 * Whether a `connect_error` names a refused credential rather than a
 * transport failure.
 *
 * Matched against ADR-023 §3's two exact constants — the server sends the
 * message text as the entire refusal, so the text is the only signal
 * available. A transport failure ("websocket error", "timeout") matches
 * neither and is retried.
 */
function isAuthRefusal(error: Error): boolean {
  const message = error?.message ?? "";
  return message === "Authentication required" || message === "This chat widget is not available.";
}
