import { createServer } from "node:http";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { SESSION_REFUSED_MESSAGE, INVALID_TOKEN_MESSAGE } from "../src/middleware/requireWidgetToken";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { messageEvents } from "../src/modules/messages/messageEvents";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * End-to-end coverage for live agent replies (ADR-025 §2, §8, §9).
 *
 * Real HTTP server, real MongoDB, and TWO real `socket.io-client`
 * connections at once — a customer's and an agent's — because the whole
 * claim of this slice is that a message crosses between them. A single-client
 * test could not tell delivery from an echo.
 *
 * The three flows asserted here are exactly the three ADR-025 promises:
 *   customer widget → Socket.IO → agent inbox
 *   agent inbox (REST) → domain event → Socket.IO → customer widget
 *   REST message creation → domain event → broadcast, with no duplicates
 */

const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const UNKNOWN_ID = "507f1f77bcf86cd799439099";

describe("agent inbox real-time delivery", () => {
  let mongoServer: MongoMemoryServer;
  let httpServer: HttpServer;
  let baseUrl: string;

  const fake = createFakeEmailProvider();
  const app = createApp({ emailProvider: fake.provider });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await OrganizationModel.init();
    await MembershipModel.init();
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
    for (const socket of openSockets.splice(0)) socket.close();
    await Promise.all([
      UserModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
      SessionModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- fixtures ----

  let emailCounter = 0;

  async function signedInStaff() {
    emailCounter += 1;
    const email = `agent${emailCounter}@example.com`;

    await createStaffAccount(fake.provider, { name: "Ada Lovelace", email, password: PASSWORD });
    const code = fake.verifications.at(-1)!.code;
    await request(app).post(VERIFY_PATH).send({ email, code });

    const login = await request(app).post(LOGIN_PATH).send({ email, password: PASSWORD });
    return {
      accessToken: login.body.data.accessToken as string,
      userId: login.body.data.user.id as string,
    };
  }

  async function createOrganization(accessToken: string, name: string) {
    const response = await request(app)
      .post(ORGANIZATIONS_PATH)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name });
    return response.body.data.organization as { id: string };
  }

  async function customerConversation(organizationId: string) {
    const organization = await OrganizationModel.findById(organizationId);
    const session = await request(app).post(WIDGET_SESSION_PATH).send({ widgetKey: organization!.widgetKey });
    const widgetToken = session.body.data.token as string;

    const conversation = await request(app)
      .post(WIDGET_CONVERSATIONS_PATH)
      .set("Authorization", `Bearer ${widgetToken}`)
      .send({});

    return { widgetToken, conversationId: conversation.body.data.id as string };
  }

  /** Connects with an arbitrary handshake payload, resolving on connect and rejecting on refusal. */
  function connectSocket(auth: Record<string, unknown>): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth,
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

  async function connectAgent(accessToken: string, organizationId: string): Promise<ClientSocket> {
    const socket = await connectSocket({ token: accessToken, organizationId });
    openSockets.push(socket);
    return socket;
  }

  async function connectCustomer(widgetToken: string, conversationId?: string): Promise<ClientSocket> {
    const socket = await connectSocket({ token: widgetToken });
    openSockets.push(socket);
    if (conversationId !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("join ack timeout")), 5000);
        socket.emit("conversation:join", { conversationId }, (ack: { ok: boolean }) => {
          clearTimeout(timer);
          if (ack.ok) resolve();
          else reject(new Error("join refused"));
        });
      });
    }
    return socket;
  }

  function waitForMessage(socket: ClientSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message:new")), 5000);
      socket.once("message:new", (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  /** Collects every `message:new` a socket receives over a fixed window. */
  function collectMessages(socket: ClientSocket, ms = 400): Promise<Record<string, unknown>[]> {
    const received: Record<string, unknown>[] = [];
    socket.on("message:new", (payload: Record<string, unknown>) => received.push(payload));
    return new Promise((resolve) => setTimeout(() => resolve(received), ms));
  }

  // ---- handshake authentication ----

  describe("agent handshake authentication", () => {
    it("accepts a staff access token naming an organization the caller belongs to", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");

      const socket = await connectAgent(staff.accessToken, organization.id);

      expect(socket.connected).toBe(true);
    });

    it("refuses a staff token naming an organization the caller does not belong to", async () => {
      const staffA = await signedInStaff();
      const staffB = await signedInStaff();
      const orgB = await createOrganization(staffB.accessToken, "Acme B");

      await expect(connectSocket({ token: staffA.accessToken, organizationId: orgB.id })).rejects.toMatchObject({
        message: SESSION_REFUSED_MESSAGE,
      });
    });

    it("makes a forged organizationId indistinguishable from one the caller is not in", async () => {
      const staff = await signedInStaff();
      await createOrganization(staff.accessToken, "Acme");

      /*
        A well-formed id belonging to nothing, and a real tenant the caller is
        not a member of, must produce the same refusal — otherwise any
        authenticated staff account becomes an oracle for which tenant ids are
        real (ADR-017 §6, ADR-025 §9).
      */
      const other = await signedInStaff();
      const otherOrg = await createOrganization(other.accessToken, "Other Co");

      const unknown = await connectSocket({ token: staff.accessToken, organizationId: UNKNOWN_ID }).catch(
        (err: Error) => err,
      );
      const notAMember = await connectSocket({ token: staff.accessToken, organizationId: otherOrg.id }).catch(
        (err: Error) => err,
      );

      expect((unknown as Error).message).toBe((notAMember as Error).message);
      expect((unknown as Error).message).toBe(SESSION_REFUSED_MESSAGE);
    });

    it("refuses a malformed organizationId", async () => {
      const staff = await signedInStaff();

      await expect(connectSocket({ token: staff.accessToken, organizationId: "not-an-id" })).rejects.toMatchObject({
        message: SESSION_REFUSED_MESSAGE,
      });
    });

    it("refuses an invalid access token", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");

      await expect(connectSocket({ token: "not.a.jwt", organizationId: organization.id })).rejects.toMatchObject({
        message: INVALID_TOKEN_MESSAGE,
      });
    });

    it("refuses an expired access token", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");

      const { SignJWT } = await import("jose");
      const expired = await new SignJWT({ sid: UNKNOWN_ID })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(staff.userId)
        .setIssuer("serviqo")
        .setAudience("serviqo-dashboard")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 60 * 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60 * 60)
        .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));

      await expect(connectSocket({ token: expired, organizationId: organization.id })).rejects.toMatchObject({
        message: INVALID_TOKEN_MESSAGE,
      });
    });

    it("refuses a widget token presented on the agent branch", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { widgetToken } = await customerConversation(organization.id);

      /*
        Fails at the SIGNATURE, not at a claim: the two credential formats are
        signed with different keys (ADR-019 §8), so a customer credential
        cannot become a staff socket by naming a tenant.
      */
      await expect(connectSocket({ token: widgetToken, organizationId: organization.id })).rejects.toMatchObject({
        message: INVALID_TOKEN_MESSAGE,
      });
    });

    it("refuses a member whose membership is suspended", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");

      const member = await signedInStaff();
      await MembershipModel.create({
        userId: member.userId,
        organizationId: organization.id,
        role: "agent",
        status: "suspended",
      });

      await expect(connectSocket({ token: member.accessToken, organizationId: organization.id })).rejects.toMatchObject(
        { message: SESSION_REFUSED_MESSAGE },
      );
    });

    it("refuses a member of a suspended organization", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      await OrganizationModel.updateOne({ _id: organization.id }, { status: "suspended" });

      await expect(connectSocket({ token: staff.accessToken, organizationId: organization.id })).rejects.toMatchObject({
        message: SESSION_REFUSED_MESSAGE,
      });
    });
  });

  // ---- customer widget → agent inbox ----

  describe("customer widget → Socket.IO → agent inbox", () => {
    it("delivers a socket-sent customer message to a connected agent", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      const agent = await connectAgent(staff.accessToken, organization.id);
      const customer = await connectCustomer(widgetToken, conversationId);

      const delivered = waitForMessage(agent);
      customer.emit("message:send", { conversationId, body: "my order is late" });

      const payload = await delivered;
      expect(payload).toMatchObject({ body: "my order is late", senderType: "customer", conversationId });
    });

    it("delivers a REST-sent customer message to a connected agent", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      const agent = await connectAgent(staff.accessToken, organization.id);
      const delivered = waitForMessage(agent);

      await request(app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "sent over REST" });

      // REST creation → domain event → Socket.IO broadcast (ADR-025 §2).
      expect(await delivered).toMatchObject({ body: "sent over REST", senderType: "customer" });
    });
  });

  // ---- agent inbox → customer widget ----

  describe("agent inbox → Socket.IO → customer widget", () => {
    it("delivers an agent reply to the customer's conversation room", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      const customer = await connectCustomer(widgetToken, conversationId);
      const delivered = waitForMessage(customer);

      const response = await request(app)
        .post(`${ORGANIZATIONS_PATH}/${organization.id}/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${staff.accessToken}`)
        .send({ body: "we are looking into it" });

      expect(response.status).toBe(201);

      const payload = await delivered;
      expect(payload).toMatchObject({ body: "we are looking into it", senderType: "agent", conversationId });
      // The same persisted message the REST response described, not a copy.
      expect(payload.id).toBe(response.body.data.id);
    });

    it("delivers an agent reply to the tenant's other agents as well", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(organization.id);

      const colleague = await signedInStaff();
      await MembershipModel.create({
        userId: colleague.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const colleagueSocket = await connectAgent(colleague.accessToken, organization.id);
      const delivered = waitForMessage(colleagueSocket);

      await request(app)
        .post(`${ORGANIZATIONS_PATH}/${organization.id}/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${staff.accessToken}`)
        .send({ body: "I have got this one" });

      expect(await delivered).toMatchObject({ body: "I have got this one", senderType: "agent" });
    });
  });

  // ---- duplicate suppression ----

  describe("no duplicate delivery", () => {
    it("delivers a socket-sent message to its sender exactly once", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      const customer = await connectCustomer(widgetToken, conversationId);

      const collected = collectMessages(customer);

      const ack = await new Promise<{ ok: boolean; data: { id: string } }>((resolve) => {
        customer.emit("message:send", { conversationId, body: "only once" }, resolve);
      });

      const received = await collected;

      /*
        The sender is in the conversation room, so it receives the broadcast
        AND its own ack. ADR-025 §2 deleted the socket handler's inline emit
        precisely so this is ONE broadcast rather than two; the ack/broadcast
        pair is then de-duplicated client-side by message id (ADR-024 §4).
      */
      expect(received).toHaveLength(1);
      expect(received[0]!.id).toBe(ack.data.id);
      expect(await MessageModel.countDocuments({ conversationId })).toBe(1);
    });

    it("delivers an agent reply to one agent exactly once", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(organization.id);

      const agent = await connectAgent(staff.accessToken, organization.id);
      const collected = collectMessages(agent);

      await request(app)
        .post(`${ORGANIZATIONS_PATH}/${organization.id}/conversations/${conversationId}/messages`)
        .set("Authorization", `Bearer ${staff.accessToken}`)
        .send({ body: "one copy only" });

      const received = await collected;

      // An agent socket joins the inbox room and never a conversation room
      // (ADR-025 §8), so the two broadcasts cannot both reach it.
      expect(received).toHaveLength(1);
    });
  });

  // ---- cross-organization isolation ----

  describe("cross-organization isolation", () => {
    it("does not deliver one tenant's messages to another tenant's agent", async () => {
      const staffA = await signedInStaff();
      const staffB = await signedInStaff();
      const orgA = await createOrganization(staffA.accessToken, "Acme A");
      const orgB = await createOrganization(staffB.accessToken, "Acme B");

      const conversationA = await customerConversation(orgA.id);
      const customerA = await connectCustomer(conversationA.widgetToken, conversationA.conversationId);

      const agentB = await connectAgent(staffB.accessToken, orgB.id);
      const collectedByB = collectMessages(agentB, 600);

      customerA.emit("message:send", {
        conversationId: conversationA.conversationId,
        body: "A's private message",
      });

      expect(await collectedByB).toEqual([]);
    });

    it("does not deliver an agent reply in one tenant to another tenant's customer", async () => {
      const staffA = await signedInStaff();
      const staffB = await signedInStaff();
      const orgA = await createOrganization(staffA.accessToken, "Acme A");
      const orgB = await createOrganization(staffB.accessToken, "Acme B");

      const conversationA = await customerConversation(orgA.id);
      const conversationB = await customerConversation(orgB.id);

      const customerB = await connectCustomer(conversationB.widgetToken, conversationB.conversationId);
      const collectedByB = collectMessages(customerB, 600);

      await request(app)
        .post(`${ORGANIZATIONS_PATH}/${orgA.id}/conversations/${conversationA.conversationId}/messages`)
        .set("Authorization", `Bearer ${staffA.accessToken}`)
        .send({ body: "A's agent replying" });

      expect(await collectedByB).toEqual([]);
    });

    it("does not deliver a conversation's messages to a different customer in the same tenant", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");

      const first = await customerConversation(organization.id);
      const second = await customerConversation(organization.id);

      const secondCustomer = await connectCustomer(second.widgetToken, second.conversationId);
      const collected = collectMessages(secondCustomer, 600);

      await request(app)
        .post(`${ORGANIZATIONS_PATH}/${organization.id}/conversations/${first.conversationId}/messages`)
        .set("Authorization", `Bearer ${staff.accessToken}`)
        .send({ body: "meant for the first customer only" });

      expect(await collected).toEqual([]);
    });
  });

  // ---- the event seam's own lifecycle ----

  describe("the message.created subscriber", () => {
    it("is removed when the http server it is attached to closes", async () => {
      const before = messageEvents.listenerCount();

      const scratch = createServer(createApp({ emailProvider: fake.provider }));
      createSocketServer(scratch);
      await new Promise<void>((resolve) => scratch.listen(0, resolve));

      expect(messageEvents.listenerCount()).toBe(before + 1);

      await new Promise<void>((resolve) => scratch.close(() => resolve()));

      /*
        A module-scope emitter with per-instance subscribers is only safe if
        the subscribers are actually removed (ADR-025 §2). A leak here would
        mean a closed server's `io` still being broadcast through.
      */
      expect(messageEvents.listenerCount()).toBe(before);
    });

    it("does not fail a message send when a subscriber throws", async () => {
      const staff = await signedInStaff();
      const organization = await createOrganization(staff.accessToken, "Acme");
      const { conversationId } = await customerConversation(organization.id);

      const unsubscribe = messageEvents.subscribe(() => {
        throw new Error("a badly behaved subscriber");
      });

      try {
        const response = await request(app)
          .post(`${ORGANIZATIONS_PATH}/${organization.id}/conversations/${conversationId}/messages`)
          .set("Authorization", `Bearer ${staff.accessToken}`)
          .send({ body: "must still be stored" });

        // The message is durably persisted BEFORE the event is published
        // (ADR-025 §2), so a throwing subscriber cannot turn a successful
        // send into a 500.
        expect(response.status).toBe(201);
        expect(await MessageModel.countDocuments({ conversationId, senderType: "agent" })).toBe(1);
      } finally {
        unsubscribe();
      }
    });
  });
});
