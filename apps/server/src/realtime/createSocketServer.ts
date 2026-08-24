import { Server } from "socket.io";

import {
  SOCKET_CONNECTION_LIMIT,
  SOCKET_CONNECTION_WINDOW_MS,
  SOCKET_MESSAGE_WRITE_LIMIT,
  SOCKET_MESSAGE_WRITE_WINDOW_MS,
} from "../config/constants";
import { env } from "../lib/env";
import { ConversationNotAccessibleError } from "../lib/errors";
import { logger } from "../lib/logger";
import { INVALID_TOKEN_MESSAGE, SESSION_REFUSED_MESSAGE } from "../middleware/requireWidgetToken";
import { conversationRepository } from "../modules/conversations/conversation.repository";
import { createMessageService } from "../modules/messages/message.service";
import { OBJECT_ID_PATTERN, createMessageSchema } from "../modules/widget/widgetConversation.validation";
import { toConversationResponse, toMessageResponse } from "../modules/widget/widgetResponses";
import { conversationRoomName } from "./conversationRoom";
import { SOCKET_EVENTS, safeAck, socketError } from "./realtimeEvents";
import { authenticateSocketToken } from "./socketAuthentication";
import { SocketRateLimiter } from "./socketRateLimit";

import type { AuthLogger } from "../modules/auth/authLogging";
import type { WidgetPrincipal } from "../modules/widget/widgetToken";
import type { ConversationJoinPayload, MessageSendPayload } from "./realtimeEvents";
import type { Server as HttpServer } from "node:http";
import type { DefaultEventsMap, Server as IOServer, Socket as IOSocket } from "socket.io";

/**
 * The Socket.IO real-time transport (ADR-023). Attaches to an
 * already-constructed `http.Server` — the same "build without starting"
 * shape `createApp` follows, so `apps/server/tests/socket.realtime.test.ts`
 * can bind an ephemeral port and drive real `socket.io-client` connections
 * with no dependency on `main.ts`.
 */

/**
 * Everything a socket knows about itself once authenticated. `widgetPrincipal`
 * is set exactly once, at handshake time, from the verified token
 * (`socketAuthentication.ts`) — no event handler ever reads identity from a
 * client-supplied payload (ADR-023 §5, §7).
 */
interface SocketData {
  widgetPrincipal: WidgetPrincipal;
  /**
   * Conversations THIS socket has proven it may join, tracked locally so
   * `message:send` can refuse a conversation the socket never joined before
   * any database call (ADR-023 §5). Process-local and never trusted as a
   * substitute for `messageService.create`'s own ownership check.
   */
  joinedConversationIds: Set<string>;
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
      The token is the authorization boundary, not Origin (ADR-023 §9,
      mirroring ADR-022 §6 for a second transport). Reflecting any origin
      matches `widgetCorsHeaders.ts`'s own posture; `credentials: false`
      because the widget token travels in the handshake `auth` payload, never
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
    Handshake authentication (ADR-023 §3). Runs before `connection` fires, so
    a socket with no valid widget token never reaches an event handler at
    all — the identical "refuse before any handler runs" shape
    `requireWidgetToken` gives REST routes.
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

    const outcome = await authenticateSocketToken(socket.handshake.auth?.token);

    if (!outcome.ok) {
      /*
        Safe fields only, never the presented token (ADR-023 §3, mirroring
        ADR-022 §14): what failed, and — for a session refusal — the
        server-side organization id the token named.
      */
      logger.info(
        {
          event: outcome.kind === "invalid_token" ? "socket.auth.rejected" : "socket.auth.session_invalid",
          reason: outcome.reason,
          ...(outcome.kind === "session_refused" ? { organizationId: outcome.organizationId } : {}),
        },
        "Socket handshake refused",
      );
      return next(new Error(outcome.kind === "invalid_token" ? INVALID_TOKEN_MESSAGE : SESSION_REFUSED_MESSAGE));
    }

    socket.data.widgetPrincipal = outcome.principal;
    socket.data.joinedConversationIds = new Set();
    next();
  });

  io.on("connection", (socket: AppSocket) => {
    const { organizationId, customerId } = socket.data.widgetPrincipal;
    const socketLog = logger.child({ socketId: socket.id, organizationId, customerId });

    socketLog.info({ event: "socket.connected" }, "Socket connected");

    socket.on(SOCKET_EVENTS.CONVERSATION_JOIN, (payload: ConversationJoinPayload, ack: unknown) => {
      void handleJoin(socket, socketLog, payload, ack);
    });

    socket.on(SOCKET_EVENTS.MESSAGE_SEND, (payload: MessageSendPayload, ack: unknown) => {
      void handleSend(socket, socketLog, payload, ack);
    });

    socket.on("disconnect", (reason: string) => {
      socketLog.info({ event: "socket.disconnected", reason }, "Socket disconnected");
    });
  });

  async function handleJoin(
    socket: AppSocket,
    socketLog: AuthLogger,
    payload: ConversationJoinPayload,
    ack: unknown,
  ): Promise<void> {
    const { organizationId, customerId } = socket.data.widgetPrincipal;

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
    socket.data.joinedConversationIds.add(conversationId);

    socketLog.info({ event: "socket.conversation.joined", conversationId }, "Conversation joined");
    safeAck(ack, { ok: true, data: toConversationResponse(conversation) });
  }

  async function handleSend(
    socket: AppSocket,
    socketLog: AuthLogger,
    payload: MessageSendPayload,
    ack: unknown,
  ): Promise<void> {
    const { organizationId, customerId } = socket.data.widgetPrincipal;

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
    if (!socket.data.joinedConversationIds.has(conversationId)) {
      return safeAck(ack, { ok: false, error: socketError("NOT_JOINED") });
    }

    const parsed = createMessageSchema.safeParse({ body: payload?.body });
    if (!parsed.success) {
      return safeAck(ack, { ok: false, error: socketError("VALIDATION_ERROR") });
    }

    try {
      /*
        Reuses `messageService.create` verbatim (ADR-023 §6) — the identical
        function `widget.controller.ts`'s `createMessage` calls. Persist
        first, then broadcast from the returned, persisted document.
      */
      const message = await messageService.create(
        organizationId,
        customerId,
        conversationId,
        parsed.data.body,
        socketLog,
      );

      const response = toMessageResponse(message);
      io.to(conversationRoomName(organizationId, conversationId)).emit(SOCKET_EVENTS.MESSAGE_NEW, response);

      safeAck(ack, { ok: true, data: response });
    } catch (err) {
      if (err instanceof ConversationNotAccessibleError) {
        // The conversation was joined earlier but is no longer reachable
        // (e.g. removed between join and send) — the identical opaque
        // refusal REST gives for the same underlying fact (ADR-022 §8).
        return safeAck(ack, { ok: false, error: socketError("NOT_FOUND") });
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
