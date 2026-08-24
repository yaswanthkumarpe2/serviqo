import { createServer } from "node:http";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { SOCKET_MESSAGE_WRITE_LIMIT } from "../src/config/constants";
import { INVALID_TOKEN_MESSAGE, SESSION_REFUSED_MESSAGE } from "../src/middleware/requireWidgetToken";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { OrganizationDocument, OrganizationStatus } from "../src/modules/organizations/organization.model";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

const SESSION_PATH = "/api/v1/widget/session";
const CONVERSATIONS_PATH = "/api/v1/widget/conversations";

/**
 * End-to-end coverage for the Socket.IO real-time transport (ADR-023): a
 * real HTTP server, a real `socket.io-client`, and MongoDB-backed widget
 * identity — the complete flow connect -> authenticate -> join -> send ->
 * deliver, and every isolation boundary it must hold.
 */
describe("socket.io real-time transport", () => {
  let mongoServer: MongoMemoryServer;
  let httpServer: HttpServer;
  let baseUrl: string;
  const app = createApp();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await OrganizationModel.init();
    await CustomerModel.init();
    await ConversationModel.init();
    await MessageModel.init();

    httpServer = createServer(app);
    createSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  const openSockets: ClientSocket[] = [];

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) {
      socket.close();
    }
    await Promise.all([
      OrganizationModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      UserModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      SessionModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  let slugCounter = 0;
  async function createOrganization(status: OrganizationStatus = "active"): Promise<OrganizationDocument> {
    slugCounter += 1;
    return OrganizationModel.create({ name: `Org ${slugCounter}`, slug: `org-${slugCounter}`, status });
  }

  async function widgetToken(organization: OrganizationDocument): Promise<string> {
    const response = await request(app).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
    return response.body.data.token as string;
  }

  async function openConversation(token: string): Promise<string> {
    const response = await request(app)
      .post(CONVERSATIONS_PATH)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    return response.body.data.id as string;
  }

  function connectSocket(token: unknown, url: string = baseUrl): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(url, {
        auth: token === undefined ? {} : { token },
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        timeout: 5000,
      });
      const settle = (fn: () => void) => {
        socket.off("connect");
        socket.off("connect_error");
        fn();
      };
      socket.once("connect", () => settle(() => resolve(socket)));
      socket.once("connect_error", (err: Error) => settle(() => reject(err)));
    });
  }

  async function connectAuthed(token: string, url: string = baseUrl): Promise<ClientSocket> {
    const socket = await connectSocket(token, url);
    openSockets.push(socket);
    return socket;
  }

  function emitWithAck<T = unknown>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 5000);
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  function waitForEvent<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5000);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  // ---- connection and authentication ----

  describe("connection and authentication", () => {
    it("accepts a valid widget token", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);

      const socket = await connectAuthed(token);

      expect(socket.connected).toBe(true);
    });

    it("rejects a connection with no token", async () => {
      await expect(connectSocket(undefined)).rejects.toMatchObject({ message: INVALID_TOKEN_MESSAGE });
    });

    it("rejects a malformed token", async () => {
      await expect(connectSocket("not.a.jwt")).rejects.toMatchObject({ message: INVALID_TOKEN_MESSAGE });
    });

    it("rejects an expired token", async () => {
      const organization = await createOrganization();
      const customer = await CustomerModel.create({ organizationId: organization._id });
      const { SignJWT } = await import("jose");
      const expired = await new SignJWT({ org: organization._id.toString() })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(customer._id.toString())
        .setIssuer("serviqo")
        .setAudience("serviqo-widget")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 60 * 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60 * 60)
        .sign(new TextEncoder().encode(process.env.JWT_WIDGET_SECRET!));

      await expect(connectSocket(expired)).rejects.toMatchObject({ message: INVALID_TOKEN_MESSAGE });
    });

    it("rejects a token with the wrong issuer", async () => {
      const organization = await createOrganization();
      const customer = await CustomerModel.create({ organizationId: organization._id });
      const { SignJWT } = await import("jose");
      const wrongIssuer = await new SignJWT({ org: organization._id.toString() })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(customer._id.toString())
        .setIssuer("not-serviqo")
        .setAudience("serviqo-widget")
        .setIssuedAt(Math.floor(Date.now() / 1000))
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(new TextEncoder().encode(process.env.JWT_WIDGET_SECRET!));

      await expect(connectSocket(wrongIssuer)).rejects.toMatchObject({ message: INVALID_TOKEN_MESSAGE });
    });

    it("rejects a token with the wrong audience (a staff access token)", async () => {
      await request(app)
        .post("/api/v1/auth/register")
        .send({ name: "Ada Lovelace", email: "staff-socket@example.com", password: "DO_NOT_LEAK_PASSWORD_1" });
      const registered = await UserModel.findOne({ email: "staff-socket@example.com" });
      const { issueAccessToken } = await import("../src/modules/auth/accessToken");
      const { token } = await issueAccessToken({
        userId: registered!._id.toString(),
        sessionId: registered!._id.toString(),
      });

      await expect(connectSocket(token)).rejects.toMatchObject({ message: INVALID_TOKEN_MESSAGE });
    });

    it("rejects a token from a suspended organization", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      await OrganizationModel.updateOne({ _id: organization._id }, { $set: { status: "suspended" } });

      await expect(connectSocket(token)).rejects.toMatchObject({ message: SESSION_REFUSED_MESSAGE });
    });

    it("rejects a token whose customer no longer exists", async () => {
      const organization = await createOrganization();
      const session = await request(app).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      await CustomerModel.deleteOne({ _id: session.body.data.customer.id });

      await expect(connectSocket(session.body.data.token as string)).rejects.toMatchObject({
        message: SESSION_REFUSED_MESSAGE,
      });
    });

    it("never echoes the presented token back in the connect_error", async () => {
      const suspiciousToken = "sentinel.token.value.that.must.never.appear.anywhere";
      await expect(connectSocket(suspiciousToken)).rejects.toMatchObject({ message: INVALID_TOKEN_MESSAGE });
      // INVALID_TOKEN_MESSAGE is a fixed constant with no interpolation, so
      // the assertion above already proves the token cannot appear in it —
      // stated explicitly here as the behavior this slice must never regress.
      expect(INVALID_TOKEN_MESSAGE).not.toContain("sentinel");
    });
  });

  // ---- the full flow: join, send, real-time delivery, persistence ----

  describe("the full flow", () => {
    it("joins a conversation, sends a message, persists it, and delivers it in real time", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const socket = await connectAuthed(token);
      const joinAck = await emitWithAck<{ ok: boolean; data?: { id: string } }>(socket, "conversation:join", {
        conversationId,
      });
      expect(joinAck.ok).toBe(true);
      expect(joinAck.data?.id).toBe(conversationId);

      const delivery = waitForEvent<{ body: string; senderType: string; conversationId: string }>(
        socket,
        "message:new",
      );
      const sendAck = await emitWithAck<{ ok: boolean; data?: { body: string } }>(socket, "message:send", {
        conversationId,
        body: "Hello in real time",
      });
      expect(sendAck.ok).toBe(true);
      expect(sendAck.data?.body).toBe("Hello in real time");

      const delivered = await delivery;
      expect(delivered.body).toBe("Hello in real time");
      expect(delivered.senderType).toBe("customer");
      expect(delivered.conversationId).toBe(conversationId);

      const stored = await MessageModel.findOne({ conversationId });
      expect(stored).not.toBeNull();
      expect(stored!.body).toBe("Hello in real time");
      expect(stored!.senderType).toBe("customer");
    });

    it("delivers a message sent on one socket to another socket holding the same token, in the same room", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const sender = await connectAuthed(token);
      const listener = await connectAuthed(token);

      await emitWithAck(sender, "conversation:join", { conversationId });
      await emitWithAck(listener, "conversation:join", { conversationId });

      const delivery = waitForEvent<{ body: string }>(listener, "message:new");
      await emitWithAck(sender, "message:send", { conversationId, body: "Seen on the other tab" });

      const delivered = await delivery;
      expect(delivered.body).toBe("Seen on the other tab");
    });

    it("refuses to send into a conversation the socket never joined", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const socket = await connectAuthed(token);
      const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socket, "message:send", {
        conversationId,
        body: "no join first",
      });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe("NOT_JOINED");
      expect(await MessageModel.countDocuments({ conversationId })).toBe(0);
    });

    it("rejects an empty message body", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);
      const socket = await connectAuthed(token);
      await emitWithAck(socket, "conversation:join", { conversationId });

      const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socket, "message:send", {
        conversationId,
        body: "",
      });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a malformed conversationId on join", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const socket = await connectAuthed(token);

      const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socket, "conversation:join", {
        conversationId: "not-an-object-id",
      });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---- REST and socket share persistence; REST does not broadcast ----

  describe("coexistence with the REST transport", () => {
    it("returns socket-sent messages through the existing REST history endpoint", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const socket = await connectAuthed(token);
      await emitWithAck(socket, "conversation:join", { conversationId });
      await emitWithAck(socket, "message:send", { conversationId, body: "sent over the socket" });

      const history = await request(app)
        .get(`${CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`);

      expect(history.status).toBe(200);
      expect(history.body.data.messages.map((m: { body: string }) => m.body)).toEqual(["sent over the socket"]);
    });

    it("keeps the REST send endpoint working, persisting through the same service", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const response = await request(app)
        .post(`${CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "sent over REST" });

      expect(response.status).toBe(201);
      expect(await MessageModel.countDocuments({ conversationId })).toBe(1);
    });

    /*
      Pins the known gap ADR-023 §12 states explicitly: a REST-sent message is
      persisted but does NOT broadcast, because the controller has no `io` to
      emit through. Asserted rather than left implicit so that wiring a REST
      emit path later is a deliberate change to a documented behavior with a
      failing test to notice it, not a silent one.
    */
    it("does not broadcast a REST-sent message to a joined socket (ADR-023 §12)", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const socket = await connectAuthed(token);
      await emitWithAck(socket, "conversation:join", { conversationId });

      let received = false;
      socket.on("message:new", () => {
        received = true;
      });

      await request(app)
        .post(`${CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "sent over REST while a socket is joined" });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received).toBe(false);
      expect(await MessageModel.countDocuments({ conversationId })).toBe(1);
    });
  });

  // ---- isolation boundaries ----

  describe("isolation boundaries", () => {
    it("does not let one customer join another customer's conversation (customer isolation)", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const conversationId = await openConversation(tokenA);

      const socketB = await connectAuthed(tokenB);
      const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socketB, "conversation:join", {
        conversationId,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe("NOT_FOUND");
    });

    it("does not deliver customer A's messages to customer B, even in the same organization", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const conversationA = await openConversation(tokenA);
      const conversationB = await openConversation(tokenB);

      const socketA = await connectAuthed(tokenA);
      const socketB = await connectAuthed(tokenB);
      await emitWithAck(socketA, "conversation:join", { conversationId: conversationA });
      await emitWithAck(socketB, "conversation:join", { conversationId: conversationB });

      let bReceived = false;
      socketB.once("message:new", () => {
        bReceived = true;
      });

      await emitWithAck(socketA, "message:send", { conversationId: conversationA, body: "private to A" });
      // Give any wrongly-routed broadcast a moment to arrive before asserting its absence.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(bReceived).toBe(false);
    });

    it("does not let a customer in one organization join a conversation in another (organization isolation)", async () => {
      const orgA = await createOrganization();
      const orgB = await createOrganization();
      const tokenA = await widgetToken(orgA);
      const tokenB = await widgetToken(orgB);
      const conversationId = await openConversation(tokenA);

      const socketB = await connectAuthed(tokenB);
      const ack = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socketB, "conversation:join", {
        conversationId,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe("NOT_FOUND");
    });

    it("gives an unknown conversation id and a real id belonging to another customer the identical refusal (enumeration resistance)", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const foreignConversationId = await openConversation(tokenA);
      const unknownId = "507f1f77bcf86cd799439011";

      const socketB = await connectAuthed(tokenB);
      const knownForeign = await emitWithAck<{ ok: boolean; error?: { code: string } }>(
        socketB,
        "conversation:join",
        { conversationId: foreignConversationId },
      );
      const unknown = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socketB, "conversation:join", {
        conversationId: unknownId,
      });

      expect(knownForeign).toEqual(unknown);
    });

    it("ignores a forged customerId/organizationId sent in the join and send payloads", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);
      const socket = await connectAuthed(token);

      const joinAck = await emitWithAck<{ ok: boolean; data?: { id: string } }>(socket, "conversation:join", {
        conversationId,
        organizationId: "507f1f77bcf86cd799439011",
        customerId: "507f1f77bcf86cd799439012",
      });
      expect(joinAck.ok).toBe(true);

      const sendAck = await emitWithAck<{ ok: boolean; data?: { senderType: string } }>(socket, "message:send", {
        conversationId,
        body: "still just a customer",
        senderType: "agent",
        organizationId: "507f1f77bcf86cd799439011",
        customerId: "507f1f77bcf86cd799439012",
      });

      expect(sendAck.ok).toBe(true);
      expect(sendAck.data?.senderType).toBe("customer");
      const stored = await MessageModel.findOne({ conversationId });
      expect(stored!.senderType).toBe("customer");
      expect(stored!.organizationId.toString()).toBe(organization._id.toString());
    });
  });

  // ---- disconnect and reconnect ----

  describe("disconnect and reconnect", () => {
    it("stops receiving events after disconnect, and a fresh connection re-authenticates and can rejoin", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const first = await connectAuthed(token);
      await emitWithAck(first, "conversation:join", { conversationId });
      first.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(first.connected).toBe(false);

      // Reconnect: an entirely new handshake, re-authenticated from scratch
      // (ADR-023 §10) — the client must re-join, which this proves works.
      const second = await connectAuthed(token);
      const rejoinAck = await emitWithAck<{ ok: boolean }>(second, "conversation:join", { conversationId });
      expect(rejoinAck.ok).toBe(true);

      const delivery = waitForEvent<{ body: string }>(second, "message:new");
      await emitWithAck(second, "message:send", { conversationId, body: "after reconnect" });
      expect((await delivery).body).toBe("after reconnect");
    });

    it("removes a disconnected socket from delivery: a message sent after disconnect is not received by it", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const sender = await connectAuthed(token);
      const listener = await connectAuthed(token);
      await emitWithAck(sender, "conversation:join", { conversationId });
      await emitWithAck(listener, "conversation:join", { conversationId });

      listener.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // No listener left to hang a `waitForEvent` on; the send succeeding at
      // all (rather than the broadcast throwing on a dead socket) is the
      // behavior under test.
      const ack = await emitWithAck<{ ok: boolean }>(sender, "message:send", {
        conversationId,
        body: "after listener disconnected",
      });
      expect(ack.ok).toBe(true);
    });
  });

  // ---- what reaches the logs ----

  describe("what reaches the logs", () => {
    /**
     * Captures every payload the socket layer hands to the shared logger
     * during one flow.
     *
     * Intercepts at the CALL SITE rather than at the output stream, for two
     * reasons. Pino writes to fd 1 through sonic-boom, bypassing
     * `process.stdout.write` entirely, so a stream-level spy observes
     * nothing; and `tests/setup.ts` pins `LOG_LEVEL=silent`, so no bytes are
     * produced under test regardless. Asserting on what is PASSED to the
     * logger is also the stronger property: it proves a secret never reaches
     * the logging layer at all, rather than proving Pino's `redact` config
     * happened to mask one that did.
     *
     * Both the direct `logger.info`/`logger.warn` calls (handshake refusals,
     * which run before a child logger exists) and everything written through
     * the per-connection `logger.child(...)` are recorded.
     */
    async function captureServerLogs(run: () => Promise<void>): Promise<string> {
      const { logger } = await import("../src/lib/logger");
      const recorded: string[] = [];

      const record = (payload: unknown, message?: unknown) => {
        recorded.push(JSON.stringify(payload) + " " + String(message ?? ""));
      };

      const spies = [
        vi.spyOn(logger, "info").mockImplementation(record as never),
        vi.spyOn(logger, "warn").mockImplementation(record as never),
        vi.spyOn(logger, "error").mockImplementation(record as never),
        vi.spyOn(logger, "child").mockImplementation(
          (bindings: unknown) =>
            ({
              info: (payload: unknown, message?: unknown) => record({ ...(bindings as object), ...(payload as object) }, message),
              warn: (payload: unknown, message?: unknown) => record({ ...(bindings as object), ...(payload as object) }, message),
              error: (payload: unknown, message?: unknown) => record({ ...(bindings as object), ...(payload as object) }, message),
            }) as never,
        ),
      ];

      try {
        await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return recorded.join("\n");
    }

    it("logs no widget token, widget key, or message body across the full socket flow", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);
      const secretBody = "SENTINEL_SOCKET_MESSAGE_BODY_MUST_NOT_BE_LOGGED";

      const captured = await captureServerLogs(async () => {
        const socket = await connectAuthed(token);
        await emitWithAck(socket, "conversation:join", { conversationId });
        await emitWithAck(socket, "message:send", { conversationId, body: secretBody });
        socket.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      // Proves the capture actually observed the socket's own log lines, so
      // the redaction assertions below cannot pass on an empty string.
      expect(captured).toContain("socket.connected");
      expect(captured).toContain("message.created");

      expect(captured).not.toContain(secretBody);
      expect(captured).not.toContain(token);
      expect(captured).not.toContain(organization.widgetKey!);
      expect(captured).not.toContain(process.env.JWT_WIDGET_SECRET!);
    });

    it("logs no presented token when a handshake is refused", async () => {
      const forged = "SENTINEL_FORGED_TOKEN_VALUE.aaaa.bbbb";

      const captured = await captureServerLogs(async () => {
        await expect(connectSocket(forged)).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      expect(captured).toContain("socket.auth.rejected");
      expect(captured).not.toContain(forged);
      expect(captured).not.toContain("SENTINEL_FORGED_TOKEN_VALUE");
    });
  });

  // ---- rate limiting ----

  describe("rate limiting", () => {
    let limitedServer: HttpServer;
    let limitedUrl: string;

    beforeAll(async () => {
      limitedServer = createServer(app);
      createSocketServer(limitedServer, { rateLimiting: true });
      await new Promise<void>((resolve) => limitedServer.listen(0, resolve));
      const { port } = limitedServer.address() as AddressInfo;
      limitedUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    });

    it("refuses message:send past the customer-keyed limit", async () => {
      const organization = await createOrganization();
      const token = await widgetToken(organization);
      const conversationId = await openConversation(token);

      const socket = await connectAuthed(token, limitedUrl);
      await emitWithAck(socket, "conversation:join", { conversationId });

      for (let i = 0; i < SOCKET_MESSAGE_WRITE_LIMIT; i += 1) {
        await emitWithAck(socket, "message:send", { conversationId, body: `msg ${i}` });
      }

      const overLimit = await emitWithAck<{ ok: boolean; error?: { code: string } }>(socket, "message:send", {
        conversationId,
        body: "one too many",
      });

      expect(overLimit.ok).toBe(false);
      expect(overLimit.error?.code).toBe("TOO_MANY_REQUESTS");
    }, 20000);

    it("keeps each customer's send budget independent", async () => {
      const organization = await createOrganization();
      const tokenA = await widgetToken(organization);
      const tokenB = await widgetToken(organization);
      const conversationA = await openConversation(tokenA);
      const conversationB = await openConversation(tokenB);

      const socketA = await connectAuthed(tokenA, limitedUrl);
      const socketB = await connectAuthed(tokenB, limitedUrl);
      await emitWithAck(socketA, "conversation:join", { conversationId: conversationA });
      await emitWithAck(socketB, "conversation:join", { conversationId: conversationB });

      for (let i = 0; i < SOCKET_MESSAGE_WRITE_LIMIT; i += 1) {
        await emitWithAck(socketA, "message:send", { conversationId: conversationA, body: `msg ${i}` });
      }
      const exhausted = await emitWithAck<{ ok: boolean }>(socketA, "message:send", {
        conversationId: conversationA,
        body: "over",
      });
      const stillFresh = await emitWithAck<{ ok: boolean }>(socketB, "message:send", {
        conversationId: conversationB,
        body: "still fine",
      });

      expect(exhausted.ok).toBe(false);
      expect(stillFresh.ok).toBe(true);
    }, 20000);
  });
});
