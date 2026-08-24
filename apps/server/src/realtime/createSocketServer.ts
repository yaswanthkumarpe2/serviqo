import { Server } from "socket.io";

import {
  SOCKET_CONNECTION_LIMIT,
  SOCKET_CONNECTION_WINDOW_MS,
  SOCKET_MESSAGE_WRITE_LIMIT,
  SOCKET_MESSAGE_WRITE_WINDOW_MS,
} from "../config/constants";
import { env } from "../lib/env";
import { ConversationClosedError, ConversationNotAccessibleError } from "../lib/errors";
import { logger } from "../lib/logger";
import { INVALID_TOKEN_MESSAGE, SESSION_REFUSED_MESSAGE } from "../middleware/requireWidgetToken";
import { conversationEvents } from "../modules/conversations/conversationEvents";
import { conversationRepository } from "../modules/conversations/conversation.repository";
import { messageEvents } from "../modules/messages/messageEvents";
import { createMessageService } from "../modules/messages/message.service";
import { OBJECT_ID_PATTERN, createMessageSchema } from "../modules/widget/widgetConversation.validation";
import { toConversationResponse, toMessageResponse } from "../modules/widget/widgetResponses";
import { conversationRoomName, organizationInboxRoomName } from "./conversationRoom";
import { SOCKET_EVENTS, safeAck, socketError } from "./realtimeEvents";
import { authenticateSocketHandshake } from "./socketAuthentication";
import { SocketRateLimiter } from "./socketRateLimit";

import type { AuthLogger } from "../modules/auth/authLogging";
import type { ConversationUpdatedEvent } from "../modules/conversations/conversationEvents";
import type { MessageCreatedEvent } from "../modules/messages/messageEvents";
import type { AgentSocketPrincipal } from "./socketAuthentication";
import type { WidgetPrincipal } from "../modules/widget/widgetToken";
import type { ConversationJoinPayload, MessageSendPayload } from "./realtimeEvents";
import type { Server as HttpServer } from "node:http";
import type { DefaultEventsMap, Server as IOServer, Socket as IOSocket } from "socket.io";

/**
 * The Socket.IO real-time transport (ADR-023, extended by ADR-025). Attaches
 * to an already-constructed `http.Server` — the same "build without starting"
 * shape `createApp` follows, so the socket suites can bind an ephemeral port
 * and drive real `socket.io-client` connections with no dependency on
 * `main.ts`.
 *
 * As of ADR-025 this file is also the ONLY subscriber to the message domain
 * event, and therefore the only place in the codebase that decides who hears
 * about a message. Services publish; this broadcasts.
 */

/**
 * Everything a socket knows about itself once authenticated. The principal is
 * set exactly once, at handshake time, from the verified credential
 * (`socketAuthentication.ts`) — no event handler ever reads identity from a
 * client-supplied payload (ADR-023 §5, §7; ADR-025 §9).
 *
 * A discriminated union rather than optional fields on one shape: a customer
 * socket has no `userId` and an agent socket has no `customerId`, and making
 * that structural means a handler cannot read the wrong one from the wrong
 * principal type by forgetting a check.
 */
type SocketIdentity =
  | {
      kind: "widget";
      principal: WidgetPrincipal;
      /**
       * Conversations THIS socket has proven it may join, tracked locally so
       * `message:send` can refuse a conversation the socket never joined
       * before any database call (ADR-023 §5). Process-local and never
       * trusted as a substitute for `messageService.create`'s own ownership
       * check.
       */
      joinedConversationIds: Set<string>;
    }
  | { kind: "agent"; principal: AgentSocketPrincipal };

interface SocketData {
  identity: SocketIdentity;
}

type AppServer = IOServer<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type AppSocket = IOSocket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/** Kept local rather than imported from `lib/rateLimit`, whose message is scoped to HTTP responses. */
const TOO_MANY_CONNECTIONS_MESSAGE = "Too many connection attempts. Please wait a few minutes and try again.";

export interface CreateSocketServerOptions {
  /** Mirrors `CreateAppOptions.rateLimiting` (ADR-018 §8) — off under `NODE_ENV=test` by default so unrelated suites are not throttled by shared counters. */
  rateLimiting?: boolean;
}

export function createSocketServer(httpServer: HttpServer, options: CreateSocketServerOptions = {}): AppServer {
  const { rateLimiting = env.NODE_ENV !== "test" } = options;

  const io: AppServer = new Server(httpServer, {
    /*
      No HTML, no client bundle: this process serves a JSON API and now a
      socket transport, nothing document-shaped — the same "serves nothing
      document-oriented" posture `securityHeaders.ts` states for helmet.
    */
    serveClient: false,

    /*
      The credential is the authorization boundary, not Origin (ADR-023 §9,
      mirroring ADR-022 §6 for a second transport). Reflecting any origin
      matches `widgetCorsHeaders.ts`'s own posture; `credentials: false`
      because both token types travel in the handshake `auth` payload, never
      a cookie.
    */
    cors: {
      origin: (_origin, callback) => callback(null, true),
      credentials: false,
    },
  });

  /*
    Built per server instance rather than at module scope, matching
    `createRateLimiters` — each instance owns its counters, so one test
    suite cannot exhaust another's budget through shared module state.
  */
  const connectionLimiter = new SocketRateLimiter(SOCKET_CONNECTION_LIMIT, SOCKET_CONNECTION_WINDOW_MS);
  const messageWriteLimiter = new SocketRateLimiter(SOCKET_MESSAGE_WRITE_LIMIT, SOCKET_MESSAGE_WRITE_WINDOW_MS);

  const messageService = createMessageService();

  /*
    THE broadcast (ADR-025 §2, §8). Every `message:new` in Serviqo is emitted
    from this one subscriber — the socket handler below deliberately does NOT
    emit after its own send, because that would fire twice for every
    socket-sent message.

    Two disjoint audiences per message: the conversation room, which holds the
    customer's own sockets, and the tenant's inbox room, which holds its
    connected agents. Neither room can contain a socket from another tenant —
    both names are built from the organization the server itself proved.
  */
  const unsubscribeMessages = messageEvents.subscribe((event: MessageCreatedEvent) => {
    const { organizationId, conversationId, message } = event;

    io.to(conversationRoomName(organizationId, conversationId)).emit(SOCKET_EVENTS.MESSAGE_NEW, message);
    io.to(organizationInboxRoomName(organizationId)).emit(SOCKET_EVENTS.MESSAGE_NEW, message);
  });

  /*
    THE conversation-state broadcast (ADR-026 §9, §10), and the ONE room it
    reaches is the decision.

    Unlike `message:new` above, this does NOT go to the conversation room. The
    payload carries `assignedTo`, which names a member of the tenant's staff,
    and a customer learning which employee is handling their ticket — or that
    it was handed from one to another, or that nobody has picked it up — is
    internal operational detail crossing the boundary SECURITY.md §2 draws.

    Filtering the field out of a customer-bound copy was considered and
    rejected (ADR-026 §10): that would be one payload with two audiences and a
    projection whose correctness depends on a branch staying right forever.
    One event, one room, one audience — so the field cannot reach a customer
    because no code path sends it to one.
  */
  const unsubscribeConversations = conversationEvents.subscribe((event: ConversationUpdatedEvent) => {
    const { organizationId, conversation } = event;

    io.to(organizationInboxRoomName(organizationId)).emit(SOCKET_EVENTS.CONVERSATION_UPDATED, conversation);
  });

  /*
    Tied to the HTTP server's lifecycle rather than left to be tidied by hand
    (ADR-025 §2): a module-scope emitter with per-instance subscribers is safe
    only if the subscribers are actually removed, and a leaked one holding a
    closed `io` is a broadcast into nothing at best.

    BOTH subscriptions, from one handler — a second `once("close", …)` would
    work equally well today and would be the place a third subscription
    quietly forgot to register.
  */
  httpServer.once("close", () => {
    unsubscribeMessages();
    unsubscribeConversations();
  });

  /*
    Handshake authentication (ADR-023 §3, ADR-025 §9). Runs before
    `connection` fires, so a socket with no valid credential never reaches an
    event handler at all — the identical "refuse before any handler runs"
    shape `requireWidgetToken` and `requireAccessToken` give REST routes.
  */
  io.use(async (socket, next) => {
    if (rateLimiting) {
      const address = socket.handshake.address;
      if (!connectionLimiter.check(address).allowed) {
        logger.warn(
          { event: "socket.rate_limit.exceeded", limitClass: "socketConnection" },
          "Handshake refused by the rate limiter",
        );
        return next(new Error(TOO_MANY_CONNECTIONS_MESSAGE));
      }
    }

    const outcome = await authenticateSocketHandshake(socket.handshake.auth);

    if (!outcome.ok) {
      /*
        Safe fields only, never the presented token (ADR-023 §3, ADR-025 §9,
        mirroring ADR-022 §14): what failed, and — for a session refusal — the
        server-side organization id the credential named.

        The `reason` distinctions exist here, for operators, and nowhere else.
        `not_a_member` in particular must never reach a client: it would
        confirm the organization exists (ADR-017 §6).
      */
      logger.info(
        {
          event: outcome.kind === "invalid_token" ? "socket.auth.rejected" : "socket.auth.session_invalid",
          reason: outcome.reason,
          ...(outcome.kind === "session_refused" && outcome.organizationId !== undefined
            ? { organizationId: outcome.organizationId }
            : {}),
        },
        "Socket handshake refused",
      );
      return next(new Error(outcome.kind === "invalid_token" ? INVALID_TOKEN_MESSAGE : SESSION_REFUSED_MESSAGE));
    }

    socket.data.identity =
      outcome.kind === "widget"
        ? { kind: "widget", principal: outcome.principal, joinedConversationIds: new Set() }
        : { kind: "agent", principal: outcome.principal };

    next();
  });

  io.on("connection", (socket: AppSocket) => {
    const identity = socket.data.identity;

    if (identity.kind === "agent") {
      return onAgentConnected(socket, identity.principal);
    }

    onWidgetConnected(socket, identity.principal);
  });

  /**
   * An agent socket (ADR-025 §8).
   *
   * It joins its tenant's inbox room immediately and joins nothing else, ever
   * — there is no agent-side `conversation:join`, and no client event this
   * socket may emit. An agent that wants to SEND uses the REST route, whose
   * `requirePermission("conversation.reply")` is the only gate that makes
   * `senderType: "agent"` reachable; the reply then arrives back here as a
   * `message.created` event like any other.
   *
   * That asymmetry with the widget socket is deliberate: adding an
   * agent-side send event would mean a second authorization path to the one
   * write in this slice that creates agent-attributed content, and one path
   * is easier to prove correct than two.
   */
  function onAgentConnected(socket: AppSocket, principal: AgentSocketPrincipal): void {
    const { organizationId, userId, role } = principal;
    const socketLog = logger.child({ socketId: socket.id, organizationId, userId });

    void socket.join(organizationInboxRoomName(organizationId));

    // `role` is safe in a log and is not in any response: an operator needs to
    // know which standing a connection was accepted under.
    socketLog.info({ event: "socket.agent.connected", role }, "Agent socket connected");

    socket.on("disconnect", (reason: string) => {
      socketLog.info({ event: "socket.disconnected", reason }, "Socket disconnected");
    });
  }

  /** A customer socket — ADR-023's transport, unchanged apart from where the broadcast happens. */
  function onWidgetConnected(socket: AppSocket, principal: WidgetPrincipal): void {
    const { organizationId, customerId } = principal;
    const socketLog = logger.child({ socketId: socket.id, organizationId, customerId });

    socketLog.info({ event: "socket.connected" }, "Socket connected");

    socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, (payload: ConversationJoinPayload, ack: unknown) => {
      void handleJoin(socket, principal, socketLog, payload, ack);
    });

    socket.on(SOCKET_EVENTS.MESSAGE_SEND, (payload: MessageSendPayload, ack: unknown) => {
      void handleSend(socket, principal, socketLog, payload, ack);
    });

    socket.on("disconnect", (reason: string) => {
      socketLog.info({ event: "socket.disconnected", reason }, "Socket disconnected");
    });
  }

  /** The conversations a widget socket has joined. Asserted because only widget handlers call it. */
  function joinedConversations(socket: AppSocket): Set<string> {
    const identity = socket.data.identity;
    /* c8 ignore next -- unreachable: only onWidgetConnected registers the handlers that call this. */
    if (identity.kind !== "widget") throw new Error("joinedConversations called for a non-widget socket");
    return identity.joinedConversationIds;
  }

  async function handleJoin(
    socket: AppSocket,
    principal: WidgetPrincipal,
    socketLog: AuthLogger,
    payload: ConversationJoinPayload,
    ack: unknown,
  ): Promise<void> {
    const { organizationId, customerId } = principal;

    const conversationId = payload?.conversationId;
    if (typeof conversationId !== "string" || !OBJECT_ID_PATTERN.test(conversationId)) {
      return safeAck(ack, { ok: false, error: socketError("VALIDATION_ERROR") });
    }

    /*
      THE tenant-and-customer-scoped lookup ADR-022 §1 already built and
      `messageService`'s own ownership check already reuses — called
      directly here rather than re-derived (ADR-023 §7).
    */
    const conversation = await conversationRepository.findByIdForCustomer(conversationId, organizationId, customerId);
    if (conversation === null) {
      socketLog.info({ event: "socket.conversation.join_rejected", conversationId }, "Conversation join refused");
      return safeAck(ack, { ok: false, error: socketError("NOT_FOUND") });
    }

    await socket.join(conversationRoomName(organizationId, conversationId));
    joinedConversations(socket).add(conversationId);

    socketLog.info({ event: "socket.conversation.joined", conversationId }, "Conversation joined");
    safeAck(ack, { ok: true, data: toConversationResponse(conversation) });
  }

  async function handleSend(
    socket: AppSocket,
    principal: WidgetPrincipal,
    socketLog: AuthLogger,
    payload: MessageSendPayload,
    ack: unknown,
  ): Promise<void> {
    const { organizationId, customerId } = principal;

    if (rateLimiting && !messageWriteLimiter.check(customerId).allowed) {
      socketLog.info(
        { event: "socket.rate_limit.exceeded", limitClass: "socketMessageWrite" },
        "Message send refused by the rate limiter",
      );
      return safeAck(ack, { ok: false, error: socketError("TOO_MANY_REQUESTS") });
    }

    const conversationId = payload?.conversationId;
    if (typeof conversationId !== "string" || !OBJECT_ID_PATTERN.test(conversationId)) {
      return safeAck(ack, { ok: false, error: socketError("VALIDATION_ERROR") });
    }

    /*
      Join-before-send, enforced from local socket state before any database
      call (ADR-023 §5) — a cheap first gate, never the authorization
      boundary. `messageService.create` below re-proves ownership from the
      database regardless.
    */
    if (!joinedConversations(socket).has(conversationId)) {
      return safeAck(ack, { ok: false, error: socketError("NOT_JOINED") });
    }

    const parsed = createMessageSchema.safeParse({ body: payload?.body });
    if (!parsed.success) {
      return safeAck(ack, { ok: false, error: socketError("VALIDATION_ERROR") });
    }

    try {
      /*
        Reuses `messageService.create` verbatim (ADR-023 §6) — the identical
        function `widget.controller.ts`'s `createMessage` calls.

        There is deliberately NO `io.to(...).emit(...)` here any more
        (ADR-025 §2). The service publishes a `message.created` event and the
        subscriber above broadcasts it; emitting here as well would deliver
        every socket-sent message twice. The ack still carries the persisted
        message, and the sender's own client suppresses the duplicate by id
        (ADR-024 §4).
      */
      const message = await messageService.create(
        organizationId,
        customerId,
        conversationId,
        parsed.data.body,
        socketLog,
      );

      safeAck(ack, { ok: true, data: toMessageResponse(message) });
    } catch (err) {
      if (err instanceof ConversationNotAccessibleError) {
        // The conversation was joined earlier but is no longer reachable
        // (e.g. removed between join and send) — the identical opaque
        // refusal REST gives for the same underlying fact (ADR-022 §8).
        return safeAck(ack, { ok: false, error: socketError("NOT_FOUND") });
      }

      if (err instanceof ConversationClosedError) {
        /*
          An agent closed this conversation while the visitor had the panel
          open (ADR-026 §6). Its own code rather than `NOT_FOUND`, because the
          widget branches on it to recover: it resolves a new open
          conversation, joins it, and retries the send once (ADR-026 §8), so
          the visitor's message lands rather than failing.

          Answered specifically and safely: this socket already proved it owns
          the conversation at join time, so the code discloses nothing about
          existence or ownership.
        */
        return safeAck(ack, { ok: false, error: socketError("CONVERSATION_CLOSED") });
      }

      socketLog.error(
        { event: "socket.message.send_failed", err: err instanceof Error ? err.name : "UnknownError" },
        "Message send failed",
      );
      safeAck(ack, { ok: false, error: socketError("INTERNAL_ERROR") });
    }
  }

  return io;
}
