import { createServer } from "node:http";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { membershipEvents } from "../src/modules/memberships/membershipEvents";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * End-to-end coverage for the live half of suspension (ADR-029 §9, §10).
 *
 * Real HTTP server, real MongoDB, real Socket.IO, with an agent connection, a
 * colleague's connection, and a customer connection open ACROSS the operation.
 *
 * The gap this closes is the reason the slice needed a third event seam. Both
 * membership gates run exactly once — `requireOrganization` per request and
 * `authenticateSocketHandshake` per connection — and the fan-out performs zero
 * membership lookups per event. Without eviction, a suspended agent's existing
 * socket keeps receiving the tenant's customer messages until it happens to
 * close, which is the opposite of what the word "suspended" promises.
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - Suspension CLOSES the suspended member's agent sockets, and they cannot
 *   reconnect while suspended.
 * - A COLLEAGUE's socket survives and receives `conversation:updated` for each
 *   released conversation, so the queue re-renders with no refetch.
 * - A connected CUSTOMER receives nothing at all, and their own messaging
 *   keeps working — the boundary that would matter most if it broke.
 * - Removal evicts too (§9's second writer), and a member of ANOTHER tenant is
 *   never touched.
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

describe("membership suspension real-time behaviour", () => {
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

  async function signedInStaff(name = "Ada Lovelace") {
    emailCounter += 1;
    const email = `statuslive${emailCounter}@example.com`;

    await request(app).post(REGISTER_PATH).send({ name, email, password: PASSWORD });
    const code = fake.verifications.at(-1)!.code;
    await request(app).post(VERIFY_PATH).send({ email, code });

    const login = await request(app).post(LOGIN_PATH).send({ email, password: PASSWORD });
    return {
      accessToken: login.body.data.accessToken as string,
      userId: login.body.data.user.id as string,
      name,
      email,
    };
  }

  async function createOrganization(accessToken: string, name: string) {
    const response = await request(app)
      .post(ORGANIZATIONS_PATH)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name });
    return response.body.data.organization as { id: string };
  }

  async function customerConversation(organizationId: string, email = "grace@example.com") {
    const organization = await OrganizationModel.findById(organizationId);
    const session = await request(app)
      .post(WIDGET_SESSION_PATH)
      .send({ widgetKey: organization!.widgetKey, name: "Grace Hopper", email });
    const widgetToken = session.body.data.token as string;

    const conversation = await request(app)
      .post(WIDGET_CONVERSATIONS_PATH)
      .set("Authorization", `Bearer ${widgetToken}`)
      .send({});

    return { widgetToken, conversationId: conversation.body.data.id as string };
  }

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

  async function connectCustomer(widgetToken: string, conversationId: string): Promise<ClientSocket> {
    const socket = await connectSocket({ token: widgetToken });
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("join ack timeout")), 5000);
      socket.emit("conversation:join", { conversationId }, (ack: { ok: boolean }) => {
        clearTimeout(timer);
        if (ack.ok) resolve();
        else reject(new Error("join refused"));
      });
    });
    return socket;
  }

  /** Resolves when the socket is closed by the SERVER, or rejects on timeout. */
  function waitForDisconnect(socket: ClientSocket, ms = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (socket.disconnected) return resolve("already");
      const timer = setTimeout(() => reject(new Error("timed out waiting for disconnect")), ms);
      socket.once("disconnect", (reason: string) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });
  }

  function waitForEvent(socket: ClientSocket, event: string, ms = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
      socket.once(event, (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  /** Collects EVERY event a socket receives, whatever its name. */
  function collectAnyEvent(socket: ClientSocket, ms = 700): Promise<string[]> {
    const names: string[] = [];
    socket.onAny((name: string) => names.push(name));
    return new Promise((resolve) => setTimeout(() => resolve(names), ms));
  }

  /** Gives the fire-and-forget eviction subscriber time to run. */
  function settle(ms = 400): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const statusPath = (organizationId: string, membershipId: string) =>
    `${ORGANIZATIONS_PATH}/${organizationId}/members/${membershipId}/status`;

  const membersPath = (organizationId: string, suffix = "") =>
    `${ORGANIZATIONS_PATH}/${organizationId}/members${suffix}`;

  const inboxPath = (organizationId: string, suffix = "") =>
    `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;

  const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

  /** Owner + organization + one agent, both able to connect a socket. */
  async function tenantWithAgent() {
    const owner = await signedInStaff("Owner Person");
    const organization = await createOrganization(owner.accessToken, "Acme");
    const agent = await signedInStaff("Agent Person");
    const membership = await MembershipModel.create({
      userId: agent.userId,
      organizationId: organization.id,
      role: "agent",
      status: "active",
    });
    return { owner, organization, agent, agentMembershipId: membership._id.toString() };
  }

  const suspend = (organizationId: string, token: string, membershipId: string) =>
    request(app).patch(statusPath(organizationId, membershipId)).set(authed(token)).send({ status: "suspended" });

  const reactivate = (organizationId: string, token: string, membershipId: string) =>
    request(app).patch(statusPath(organizationId, membershipId)).set(authed(token)).send({ status: "active" });

  // ==================== eviction (ADR-029 §9) ====================

  describe("suspension closes the member's live sockets", () => {
    it("disconnects the suspended agent's open socket", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const agentSocket = await connectAgent(agent.accessToken, organization.id);
      expect(agentSocket.connected).toBe(true);

      const closed = waitForDisconnect(agentSocket);
      const response = await suspend(organization.id, owner.accessToken, agentMembershipId);
      expect(response.status).toBe(200);

      await closed;
      expect(agentSocket.connected).toBe(false);
    });

    it("disconnects every socket that member holds in this tenant", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const first = await connectAgent(agent.accessToken, organization.id);
      const second = await connectAgent(agent.accessToken, organization.id);

      const bothClosed = Promise.all([waitForDisconnect(first), waitForDisconnect(second)]);
      await suspend(organization.id, owner.accessToken, agentMembershipId);

      await bothClosed;
      expect(first.connected).toBe(false);
      expect(second.connected).toBe(false);
    });

    /* Nobody else is evicted — the subscriber matches on the user id. */
    it("leaves a colleague's socket connected", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const colleague = await signedInStaff("Colleague");
      await MembershipModel.create({
        userId: colleague.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const agentSocket = await connectAgent(agent.accessToken, organization.id);
      const colleagueSocket = await connectAgent(colleague.accessToken, organization.id);
      const ownerSocket = await connectAgent(owner.accessToken, organization.id);

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await waitForDisconnect(agentSocket);
      await settle();

      expect(colleagueSocket.connected).toBe(true);
      expect(ownerSocket.connected).toBe(true);
    });

    /* The handshake already refused a non-active membership (ADR-025 §9). */
    it("refuses the suspended agent a new connection", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();

      await suspend(organization.id, owner.accessToken, agentMembershipId);

      await expect(connectAgent(agent.accessToken, organization.id)).rejects.toThrow();
    });

    it("lets them reconnect once reactivated, with the token they already held", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const before = await connectAgent(agent.accessToken, organization.id);

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await waitForDisconnect(before);

      await reactivate(organization.id, owner.accessToken, agentMembershipId);

      const after = await connectAgent(agent.accessToken, organization.id);
      expect(after.connected).toBe(true);
    });

    /*
      ADR-029 §9's SECOND WRITER. Removal produces the identical revoked state
      and had the identical hole — one subscriber, two publishers.
    */
    it("disconnects a removed member's socket too", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const agentSocket = await connectAgent(agent.accessToken, organization.id);

      const closed = waitForDisconnect(agentSocket);
      const removal = await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));
      expect(removal.status).toBe(200);

      await closed;
      expect(agentSocket.connected).toBe(false);
    });

    /* Reactivation is not a revocation and evicts nobody. */
    it("does not disconnect anyone on reactivation", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await reactivate(organization.id, owner.accessToken, agentMembershipId);

      const agentSocket = await connectAgent(agent.accessToken, organization.id);
      const ownerSocket = await connectAgent(owner.accessToken, organization.id);

      // A second reactivation is refused, and nothing is evicted regardless.
      await reactivate(organization.id, owner.accessToken, agentMembershipId);
      await settle();

      expect(agentSocket.connected).toBe(true);
      expect(ownerSocket.connected).toBe(true);
    });

    it("evicts nobody when the suspension is refused", async () => {
      const { owner, organization, agent } = await tenantWithAgent();
      const agentSocket = await connectAgent(agent.accessToken, organization.id);

      const refused = await suspend(organization.id, owner.accessToken, "507f1f77bcf86cd799439099");
      expect(refused.status).toBe(404);
      await settle();

      expect(agentSocket.connected).toBe(true);
    });
  });

  // ==================== tenant isolation on the wire ====================

  describe("tenant isolation", () => {
    it("does not touch another organization's sockets", async () => {
      const a = await tenantWithAgent();
      const b = await tenantWithAgent();

      const socketA = await connectAgent(a.agent.accessToken, a.organization.id);
      const socketB = await connectAgent(b.agent.accessToken, b.organization.id);

      await suspend(a.organization.id, a.owner.accessToken, a.agentMembershipId);
      await waitForDisconnect(socketA);
      await settle();

      expect(socketB.connected).toBe(true);
    });

    /*
      Someone who is an agent in two tenants keeps the other tenant's
      connection: THIS organization revoked them, not Serviqo (ADR-029 §9).
    */
    it("keeps the same person's socket in a different tenant", async () => {
      const a = await tenantWithAgent();
      const otherOwner = await signedInStaff("Other Owner");
      const otherOrg = await createOrganization(otherOwner.accessToken, "Other Co");
      await MembershipModel.create({
        userId: a.agent.userId,
        organizationId: otherOrg.id,
        role: "agent",
        status: "active",
      });

      const here = await connectAgent(a.agent.accessToken, a.organization.id);
      const elsewhere = await connectAgent(a.agent.accessToken, otherOrg.id);

      await suspend(a.organization.id, a.owner.accessToken, a.agentMembershipId);
      await waitForDisconnect(here);
      await settle();

      expect(here.connected).toBe(false);
      expect(elsewhere.connected).toBe(true);
    });
  });

  // ==================== assignment cleanup, live (ADR-029 §10) ====================

  describe("released conversations reach other agents live", () => {
    it("broadcasts conversation:updated to a watching colleague", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId } = await customerConversation(organization.id);

      const claim = await request(app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });
      expect(claim.status).toBe(200);

      const ownerSocket = await connectAgent(owner.accessToken, organization.id);
      const updated = waitForEvent(ownerSocket, "conversation:updated");

      await suspend(organization.id, owner.accessToken, agentMembershipId);

      const payload = await updated;
      expect(payload).toMatchObject({ id: conversationId, assignedTo: null });
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
    });

    it("broadcasts one update per released conversation", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const first = await customerConversation(organization.id, "one@example.com");
      const second = await customerConversation(organization.id, "two@example.com");

      for (const { conversationId } of [first, second]) {
        await request(app)
          .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
          .set(authed(agent.accessToken))
          .send({ action: "claim" });
      }

      const ownerSocket = await connectAgent(owner.accessToken, organization.id);
      const received: string[] = [];
      ownerSocket.on("conversation:updated", (p: { id: string }) => received.push(p.id));

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await settle(700);

      expect(received.sort()).toEqual([first.conversationId, second.conversationId].sort());
    });

    /* Reactivation restores access and no assignments, so it broadcasts none. */
    it("broadcasts nothing on reactivation", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId } = await customerConversation(organization.id);
      await request(app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await settle();

      const ownerSocket = await connectAgent(owner.accessToken, organization.id);
      const collected = collectAnyEvent(ownerSocket);

      await reactivate(organization.id, owner.accessToken, agentMembershipId);

      expect(await collected).toEqual([]);
      expect((await ConversationModel.findById(conversationId))!.assignedTo).toBeNull();
    });
  });

  // ==================== the customer boundary ====================

  describe("customers are never told", () => {
    it("sends nothing to a connected customer when a member is suspended", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);
      await request(app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const customerSocket = await connectCustomer(widgetToken, conversationId);
      const collected = collectAnyEvent(customerSocket);

      const response = await suspend(organization.id, owner.accessToken, agentMembershipId);
      expect(response.status).toBe(200);

      /*
        `conversation:updated` carries `assignedTo`, which names a member of
        staff — ADR-026 §10 sends it to the inbox room ONLY, so the release
        above reaches colleagues and never the customer whose conversation it
        is.
      */
      expect(await collected).toEqual([]);
    });

    it("leaves the customer's socket connected and working", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);
      const customerSocket = await connectCustomer(widgetToken, conversationId);

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await settle();

      expect(customerSocket.connected).toBe(true);

      // And their own message still round-trips live.
      const delivered = waitForEvent(customerSocket, "message:new");
      const sent = await request(app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "am I still connected" });
      expect(sent.status).toBe(201);

      expect(await delivered).toMatchObject({ conversationId, senderType: "customer" });
    });

    it("still delivers a remaining agent's reply to the customer", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await settle();

      const customerSocket = await connectCustomer(widgetToken, conversationId);
      const delivered = waitForEvent(customerSocket, "message:new");

      const reply = await request(app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(owner.accessToken))
        .send({ body: "thanks for waiting, looking into it now" });
      expect(reply.status).toBe(201);

      const payload = await delivered;
      expect(payload).toMatchObject({ conversationId, senderType: "agent" });
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("suspended");
      expect(serialized).not.toContain("membership");
    });

    /*
      The suspended agent's socket is gone, so a message arriving afterwards
      cannot reach them — the property the whole seam exists for.
    */
    it("stops delivering tenant traffic to the suspended member", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);
      const agentSocket = await connectAgent(agent.accessToken, organization.id);

      await suspend(organization.id, owner.accessToken, agentMembershipId);
      await waitForDisconnect(agentSocket);

      const received: unknown[] = [];
      agentSocket.onAny((_name: string, payload: unknown) => received.push(payload));

      await request(app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "a customer message the suspended agent must not see" });
      await settle(700);

      expect(received).toEqual([]);
      expect(agentSocket.connected).toBe(false);
    });
  });

  // ==================== the seam's own hygiene ====================

  describe("the membership event seam", () => {
    it("registers exactly one subscriber per socket server", () => {
      // The server built in `beforeAll` is the only one alive in this file.
      expect(membershipEvents.listenerCount()).toBe(1);
    });

    it("carries two ids and a reason, and never a name, email, or role", async () => {
      const seen: Record<string, unknown>[] = [];
      const unsubscribe = membershipEvents.subscribe((event) =>
        seen.push(event as unknown as Record<string, unknown>),
      );

      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      await suspend(organization.id, owner.accessToken, agentMembershipId);
      unsubscribe();

      expect(seen).toHaveLength(1);
      expect(Object.keys(seen[0]!).sort()).toEqual(["organizationId", "reason", "userId"]);
      expect(seen[0]).toMatchObject({ organizationId: organization.id, userId: agent.userId, reason: "suspended" });
      expect(JSON.stringify(seen[0])).not.toContain(agent.email);
      expect(JSON.stringify(seen[0])).not.toContain(agent.name);
    });
  });
});
