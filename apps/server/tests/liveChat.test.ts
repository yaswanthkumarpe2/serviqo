import { createServer } from "node:http";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { createOrganizationAs } from "../src/modules/organizations/testing/organizations";
import { isWithinBusinessHours } from "../src/modules/organizations/widgetAppearance";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createSocketServer } from "../src/realtime/createSocketServer";
import { agentPresence } from "../src/realtime/presence";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * Live chat essentials (ADR-040): the chat's appearance and business hours,
 * whether anyone is available, typing indicators, "seen" receipts and unread
 * counts.
 */

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const ORG = "/api/v1/organizations";

const APPEARANCE = {
  accentColor: "#7C3AED",
  title: "CentralService Support",
  welcomeMessage: "Hi! Ask us anything.",
  awayMessage: "We are away — leave a message.",
  businessHours: {
    enabled: false,
    timezone: "Asia/Kolkata",
    days: [null, { open: "09:00", close: "18:00" }, { open: "09:00", close: "18:00" }, null, null, null, null],
  },
};

describe("live chat essentials", () => {
  let mongoServer: MongoMemoryServer;
  let httpServer: HttpServer;
  let baseUrl: string;
  const fake = createFakeEmailProvider();
  const app = createApp({ emailProvider: fake.provider });
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([
      UserModel.init(),
      OrganizationModel.init(),
      MembershipModel.init(),
      CustomerModel.init(),
      ConversationModel.init(),
      MessageModel.init(),
    ]);
    httpServer = createServer(app);
    createSocketServer(httpServer, { rateLimiting: false });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.close();
    // Give the server a moment to process disconnects before counting presence again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    agentPresence.reset();
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

  let counter = 0;
  async function owner() {
    counter += 1;
    const email = `owner${counter}@example.com`;
    await createStaffAccount(fake.provider, { name: "Olivia Owner", email, password: PASSWORD });
    await request(app).post("/api/v1/auth/verify-email").send({ email, code: fake.verifications.at(-1)!.code });
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    const token = login.body.data.accessToken as string;
    const organization = await createOrganizationAs(token, `Org ${counter}`);
    return { token, organization };
  }

  async function addAgent(organizationId: string) {
    counter += 1;
    const email = `agent${counter}@example.com`;
    const account = await createStaffAccount(fake.provider, { name: "Alan Agent", email, password: PASSWORD });
    await request(app).post("/api/v1/auth/verify-email").send({ email, code: fake.verifications.at(-1)!.code });
    await MembershipModel.create({ userId: account.id, organizationId, role: "agent", status: "active", invitedByUserId: null });
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    return login.body.data.accessToken as string;
  }

  async function customer(organizationId: string) {
    const organization = await OrganizationModel.findById(organizationId);
    const session = await request(app).post("/api/v1/widget/session").send({ widgetKey: organization!.widgetKey });
    const token = session.body.data.token as string;
    const conversation = await request(app).post("/api/v1/widget/conversations").set("Authorization", `Bearer ${token}`).send({});
    return { token, session: session.body.data, conversationId: conversation.body.data.id as string };
  }

  function connect(auth: Record<string, unknown>): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, { auth, transports: ["websocket"], forceNew: true, reconnection: false });
      openSockets.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
  }

  async function customerSocket(token: string, conversationId: string) {
    const socket = await connect({ token });
    await new Promise<void>((resolve, reject) =>
      socket.emit("conversation:join", { conversationId }, (ack: { ok: boolean }) => (ack.ok ? resolve() : reject())),
    );
    return socket;
  }

  function next<T>(socket: ClientSocket, event: string, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  function nothing(socket: ClientSocket, event: string, ms = 300): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = () => resolve(false);
      socket.once(event, handler);
      setTimeout(() => {
        socket.off(event, handler);
        resolve(true);
      }, ms);
    });
  }

  const emitAck = <T>(socket: ClientSocket, event: string, payload: unknown) =>
    new Promise<T>((resolve) => socket.emit(event, payload, (ack: T) => resolve(ack)));

  // ---- appearance ----

  describe("the chat's appearance", () => {
    it("defaults to Serviqo green, the organisation's name, and no business hours", async () => {
      const { organization } = await owner();
      const slug = organization.slug;

      const entry = await request(app).get(`/api/v1/widget/organizations/${slug}`);

      expect(entry.body.data.appearance).toMatchObject({ accentColor: "#14684A", title: organization.name });
      expect(entry.body.data.appearance.businessHours.enabled).toBe(false);
      expect(entry.body.data.availability).toEqual({ online: false, agentsOnline: false, withinBusinessHours: true });
    });

    it("is saved by an owner and shown to visitors on the link and in the session", async () => {
      const { token, organization } = await owner();

      const saved = await request(app)
        .put(`${ORG}/${organization.id}/widget-config/appearance`)
        .set("Authorization", `Bearer ${token}`)
        .send(APPEARANCE);
      expect(saved.status).toBe(200);
      expect(saved.body.data.appearance).toMatchObject({ accentColor: "#7C3AED", title: "CentralService Support" });

      const entry = await request(app).get(`/api/v1/widget/organizations/${organization.slug}`);
      expect(entry.body.data.appearance).toMatchObject({
        accentColor: "#7C3AED",
        welcomeMessage: "Hi! Ask us anything.",
        awayMessage: "We are away — leave a message.",
      });
      expect(entry.body.data.appearance.businessHours.days[1]).toEqual({ open: "09:00", close: "18:00" });

      const { session } = await customer(organization.id);
      expect(session.appearance.title).toBe("CentralService Support");
    });

    it("refuses a bad colour, an unknown timezone, a short week, and a day that closes before it opens", async () => {
      const { token, organization } = await owner();
      const put = (body: object) =>
        request(app).put(`${ORG}/${organization.id}/widget-config/appearance`).set("Authorization", `Bearer ${token}`).send(body);

      expect((await put({ ...APPEARANCE, accentColor: "purple" })).status).toBe(400);
      expect((await put({ ...APPEARANCE, businessHours: { ...APPEARANCE.businessHours, timezone: "Mars/Olympus" } })).status).toBe(400);
      expect((await put({ ...APPEARANCE, businessHours: { ...APPEARANCE.businessHours, days: [null] } })).status).toBe(400);
      expect(
        (
          await put({
            ...APPEARANCE,
            businessHours: { ...APPEARANCE.businessHours, days: [{ open: "18:00", close: "09:00" }, null, null, null, null, null, null] },
          })
        ).status,
      ).toBe(400);
    });

    it("cannot be changed by an agent", async () => {
      const { organization } = await owner();
      const agentToken = await addAgent(organization.id);

      const response = await request(app)
        .put(`${ORG}/${organization.id}/widget-config/appearance`)
        .set("Authorization", `Bearer ${agentToken}`)
        .send(APPEARANCE);

      expect(response.status).toBe(403);
    });

    it("works out business hours in the organisation's timezone", () => {
      const hours = {
        enabled: true,
        timezone: "Asia/Kolkata",
        days: [null, { open: "09:00", close: "18:00" }, null, null, null, null, null],
      };
      // Monday 2026-09-14 04:00 UTC is 09:30 in Kolkata.
      expect(isWithinBusinessHours(hours, new Date("2026-09-14T04:00:00Z"))).toBe(true);
      // Monday 13:00 UTC is 18:30 in Kolkata: closed.
      expect(isWithinBusinessHours(hours, new Date("2026-09-14T13:00:00Z"))).toBe(false);
      // Sunday is closed all day.
      expect(isWithinBusinessHours(hours, new Date("2026-09-13T06:00:00Z"))).toBe(false);
      // Disabled hours are always open.
      expect(isWithinBusinessHours({ ...hours, enabled: false }, new Date("2026-09-13T06:00:00Z"))).toBe(true);
    });
  });

  // ---- presence ----

  describe("availability", () => {
    it("goes online when an agent connects and away when the last one leaves, live on the visitor's socket", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      const visitorSocket = await customerSocket(visitor.token, visitor.conversationId);

      const online = next<{ agentsOnline: boolean }>(visitorSocket, "presence:update");
      const agentSocket = await connect({ token, organizationId: organization.id });
      expect((await online).agentsOnline).toBe(true);

      const entry = await request(app).get(`/api/v1/widget/organizations/${organization.slug}`);
      expect(entry.body.data.availability.online).toBe(true);

      const away = next<{ agentsOnline: boolean }>(visitorSocket, "presence:update");
      agentSocket.close();
      expect((await away).agentsOnline).toBe(false);
    });

    it("tells a visitor the current state as soon as they connect", async () => {
      const { token, organization } = await owner();
      await connect({ token, organizationId: organization.id });
      const visitor = await customer(organization.id);

      const socket = ioClient(baseUrl, { auth: { token: visitor.token }, transports: ["websocket"], forceNew: true, reconnection: false });
      openSockets.push(socket);
      expect((await next<{ agentsOnline: boolean }>(socket, "presence:update")).agentsOnline).toBe(true);
    });

    it("is offline outside business hours even with an agent connected", async () => {
      const { token, organization } = await owner();
      const allClosed = { ...APPEARANCE, businessHours: { enabled: true, timezone: "UTC", days: [null, null, null, null, null, null, null] } };
      await request(app).put(`${ORG}/${organization.id}/widget-config/appearance`).set("Authorization", `Bearer ${token}`).send(allClosed);
      await connect({ token, organizationId: organization.id });

      const entry = await request(app).get(`/api/v1/widget/organizations/${organization.slug}`);

      expect(entry.body.data.availability).toEqual({ online: false, agentsOnline: true, withinBusinessHours: false });
    });

    it("does not tell one organisation's visitors about another organisation's agents", async () => {
      const first = await owner();
      const second = await owner();
      const visitor = await customer(first.organization.id);
      const visitorSocket = await customerSocket(visitor.token, visitor.conversationId);
      await next(visitorSocket, "presence:update").catch(() => undefined);

      await connect({ token: second.token, organizationId: second.organization.id });

      expect(await nothing(visitorSocket, "presence:update")).toBe(true);
    });
  });

  // ---- typing ----

  describe("typing indicators", () => {
    it("shows the customer typing to the organisation's agents, and the agent typing to the customer", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      const agentSocket = await connect({ token, organizationId: organization.id });
      const visitorSocket = await customerSocket(visitor.token, visitor.conversationId);

      const toAgent = next<Record<string, unknown>>(agentSocket, "typing");
      visitorSocket.emit("typing", { conversationId: visitor.conversationId, isTyping: true });
      expect(await toAgent).toEqual({ conversationId: visitor.conversationId, sender: "customer", isTyping: true });

      const toVisitor = next<Record<string, unknown>>(visitorSocket, "typing");
      agentSocket.emit("typing", { conversationId: visitor.conversationId, isTyping: true });
      expect(await toVisitor).toEqual({ conversationId: visitor.conversationId, sender: "agent", isTyping: true });
    });

    it("never carries who is typing", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      const agentSocket = await connect({ token, organizationId: organization.id });
      const visitorSocket = await customerSocket(visitor.token, visitor.conversationId);

      const toVisitor = next<Record<string, unknown>>(visitorSocket, "typing");
      agentSocket.emit("typing", { conversationId: visitor.conversationId, isTyping: true });

      expect(Object.keys(await toVisitor).sort()).toEqual(["conversationId", "isTyping", "sender"]);
    });

    it("ignores an agent typing into another organisation's conversation", async () => {
      const first = await owner();
      const second = await owner();
      const visitor = await customer(first.organization.id);
      const visitorSocket = await customerSocket(visitor.token, visitor.conversationId);
      const intruder = await connect({ token: second.token, organizationId: second.organization.id });

      intruder.emit("typing", { conversationId: visitor.conversationId, isTyping: true });

      expect(await nothing(visitorSocket, "typing")).toBe(true);
    });

    it("ignores a customer typing into a conversation they have not joined", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      const agentSocket = await connect({ token, organizationId: organization.id });
      const notJoined = await connect({ token: visitor.token });

      notJoined.emit("typing", { conversationId: visitor.conversationId, isTyping: true });

      expect(await nothing(agentSocket, "typing")).toBe(true);
    });
  });

  // ---- read receipts and unread counts ----

  describe("seen receipts and unread counts", () => {
    it("counts customer messages as unread for the team until an agent reads the conversation", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      for (const body of ["Hello?", "Anyone there?"]) {
        await request(app)
          .post(`/api/v1/widget/conversations/${visitor.conversationId}/messages`)
          .set("Authorization", `Bearer ${visitor.token}`)
          .send({ body });
      }

      const before = await request(app).get(`${ORG}/${organization.id}/conversations`).set("Authorization", `Bearer ${token}`);
      expect(before.body.data.conversations[0].unreadCount).toBe(2);

      const agentSocket = await connect({ token, organizationId: organization.id });
      const ack = await emitAck<{ ok: boolean }>(agentSocket, "conversation:read", { conversationId: visitor.conversationId });
      expect(ack.ok).toBe(true);

      const after = await request(app).get(`${ORG}/${organization.id}/conversations`).set("Authorization", `Bearer ${token}`);
      expect(after.body.data.conversations[0].unreadCount).toBe(0);
      expect(after.body.data.conversations[0].agentLastReadAt).toEqual(expect.any(String));
    });

    it("shows the customer 'seen' when an agent reads, and the agents when the customer reads", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      const agentSocket = await connect({ token, organizationId: organization.id });
      const visitorSocket = await customerSocket(visitor.token, visitor.conversationId);

      const seenByAgent = next<Record<string, unknown>>(visitorSocket, "conversation:read");
      await emitAck(agentSocket, "conversation:read", { conversationId: visitor.conversationId });
      expect(await seenByAgent).toMatchObject({ conversationId: visitor.conversationId, reader: "agent" });

      const seenByCustomer = next<Record<string, unknown>>(agentSocket, "conversation:read");
      await emitAck(visitorSocket, "conversation:read", { conversationId: visitor.conversationId });
      expect(await seenByCustomer).toMatchObject({ conversationId: visitor.conversationId, reader: "customer" });
    });

    it("clears the team's unread count when an agent replies, and counts the reply as unread for the customer", async () => {
      const { token, organization } = await owner();
      const visitor = await customer(organization.id);
      await request(app)
        .post(`/api/v1/widget/conversations/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${visitor.token}`)
        .send({ body: "Help" });

      await request(app)
        .post(`${ORG}/${organization.id}/conversations/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "On it" });

      const stored = await ConversationModel.findById(visitor.conversationId);
      expect(stored!.unreadByAgents).toBe(0);
      expect(stored!.unreadByCustomer).toBe(1);

      const widgetView = await request(app).post("/api/v1/widget/conversations").set("Authorization", `Bearer ${visitor.token}`).send({});
      expect(widgetView.body.data.unreadCount).toBe(1);
      expect(widgetView.body.data.agentLastReadAt).toEqual(expect.any(String));
    });

    it("refuses an agent marking another organisation's conversation read", async () => {
      const first = await owner();
      const second = await owner();
      const visitor = await customer(first.organization.id);
      await request(app)
        .post(`/api/v1/widget/conversations/${visitor.conversationId}/messages`)
        .set("Authorization", `Bearer ${visitor.token}`)
        .send({ body: "Help" });
      const intruder = await connect({ token: second.token, organizationId: second.organization.id });

      const ack = await emitAck<{ ok: boolean }>(intruder, "conversation:read", { conversationId: visitor.conversationId });

      expect(ack.ok).toBe(false);
      expect((await ConversationModel.findById(visitor.conversationId))!.unreadByAgents).toBe(1);
    });
  });
});
