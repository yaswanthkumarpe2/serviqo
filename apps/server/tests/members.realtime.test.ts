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
 * End-to-end coverage for the live half of team management (ADR-027 §10,
 * §15).
 *
 * Real HTTP server, real MongoDB, real Socket.IO, and TWO real agent
 * connections at once — the same shape `conversationAssignment.realtime.test.ts`
 * uses, because the claim under test is that a MEMBERSHIP operation reaches
 * another agent's screen as a CONVERSATION update, through the seam ADR-025 §2
 * built and with no new event type.
 *
 * The three assertions that matter most:
 *
 * - Removing a member broadcasts `conversation:updated` for every conversation
 *   they held, so a watching agent's list goes unassigned without a refetch.
 * - A CUSTOMER's socket receives none of it. Membership is staff-only
 *   information and the payload names staff (ADR-026 §10, ADR-027 §15).
 * - No roster event of any kind is emitted — ADR-027 §15 declines one
 *   deliberately, and a test is what stops it appearing by accident.
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

describe("team management real-time delivery", () => {
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
    const email = `memberlive${emailCounter}@example.com`;

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

  function waitForUpdate(socket: ClientSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for conversation:updated")), 5000);
      socket.once("conversation:updated", (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  /** Collects every event of one name a socket receives over a fixed window. */
  function collectEvents(socket: ClientSocket, event: string, ms = 500): Promise<unknown[]> {
    const received: unknown[] = [];
    socket.on(event, (payload: unknown) => received.push(payload));
    return new Promise((resolve) => setTimeout(() => resolve(received), ms));
  }

  /** Collects EVERY event a socket receives, whatever its name. */
  function collectAnyEvent(socket: ClientSocket, ms = 500): Promise<string[]> {
    const names: string[] = [];
    socket.onAny((name: string) => names.push(name));
    return new Promise((resolve) => setTimeout(() => resolve(names), ms));
  }

  const assignmentPath = (organizationId: string, conversationId: string) =>
    `${ORGANIZATIONS_PATH}/${organizationId}/conversations/${conversationId}/assignment`;

  const membersPath = (organizationId: string, suffix = "") =>
    `${ORGANIZATIONS_PATH}/${organizationId}/members${suffix}`;

  const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

  /** Owner + organization + a second agent, both able to connect a socket. */
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

  // ---- removal releases assignments, live ----

  describe("removing a member releases their conversations live", () => {
    it("broadcasts conversation:updated to a watching agent when a member is removed", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const watcherStaff = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcherStaff.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const { conversationId } = await customerConversation(organization.id);
      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const watcher = await connectAgent(watcherStaff.accessToken, organization.id);
      const delivered = waitForUpdate(watcher);

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const payload = await delivered;
      expect(payload.id).toBe(conversationId);
      expect(payload.assignedTo).toBeNull();
    });

    it("broadcasts one update per released conversation", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const watcherStaff = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcherStaff.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const first = await customerConversation(organization.id, "one@example.com");
      const second = await customerConversation(organization.id, "two@example.com");
      for (const { conversationId } of [first, second]) {
        await request(app)
          .patch(assignmentPath(organization.id, conversationId))
          .set(authed(agent.accessToken))
          .send({ action: "claim" });
      }

      const watcher = await connectAgent(watcherStaff.accessToken, organization.id);
      const collected = collectEvents(watcher, "conversation:updated");

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const updates = (await collected) as { id: string; assignedTo: unknown }[];
      expect(updates.map((u) => u.id).sort()).toEqual([first.conversationId, second.conversationId].sort());
      for (const update of updates) expect(update.assignedTo).toBeNull();
    });

    it("carries no name in the broadcast — a broadcast has no reader to run member.read against", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const watcherStaff = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcherStaff.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const { conversationId } = await customerConversation(organization.id);
      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const watcher = await connectAgent(watcherStaff.accessToken, organization.id);
      const delivered = waitForUpdate(watcher);

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      const serialized = JSON.stringify(await delivered);
      expect(serialized).not.toContain(agent.name);
      expect(serialized).not.toContain(agent.email);
      expect(serialized).not.toContain("customer");
    });

    it("emits nothing when the removed member held no conversations", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const watcherStaff = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcherStaff.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });
      await customerConversation(organization.id);

      const watcher = await connectAgent(watcherStaff.accessToken, organization.id);
      const collected = collectEvents(watcher, "conversation:updated");

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(await collected).toEqual([]);
    });
  });

  // ---- the boundaries the broadcast must not cross ----

  describe("a customer never receives membership consequences", () => {
    it("delivers no conversation:updated to the customer when a member is removed", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const customer = await connectCustomer(widgetToken, conversationId);
      const collected = collectEvents(customer, "conversation:updated");

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(await collected).toEqual([]);
    });

    it("delivers NO event of any name to the customer for a membership change", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const customer = await connectCustomer(widgetToken, conversationId);
      const names = collectAnyEvent(customer);

      await request(app)
        .patch(`${membersPath(organization.id)}/${agentMembershipId}/role`)
        .set(authed(owner.accessToken))
        .send({ role: "supervisor" });
      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(await names).toEqual([]);
    });
  });

  describe("no roster event exists (ADR-027 §15)", () => {
    it("emits nothing to a connected agent when a member is ADDED", async () => {
      const { owner, organization } = await tenantWithAgent();
      const watcherStaff = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcherStaff.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });
      const newcomer = await signedInStaff("Newcomer");

      const watcher = await connectAgent(watcherStaff.accessToken, organization.id);
      const names = collectAnyEvent(watcher);

      const added = await request(app)
        .post(membersPath(organization.id))
        .set(authed(owner.accessToken))
        .send({ email: newcomer.email, role: "agent" });
      expect(added.status).toBe(201);

      // The roster refreshes on fetch; it is deliberately not live.
      expect(await names).toEqual([]);
    });

    it("emits nothing to a connected agent when a ROLE changes and no assignment moves", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const watcherStaff = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcherStaff.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const watcher = await connectAgent(watcherStaff.accessToken, organization.id);
      const names = collectAnyEvent(watcher);

      await request(app)
        .patch(`${membersPath(organization.id)}/${agentMembershipId}/role`)
        .set(authed(owner.accessToken))
        .send({ role: "supervisor" });

      expect(await names).toEqual([]);
    });
  });

  describe("cross-tenant socket isolation", () => {
    it("does not deliver one tenant's release to another tenant's agent", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();

      const otherOwner = await signedInStaff("Other Owner");
      const otherOrganization = await createOrganization(otherOwner.accessToken, "Other Acme");

      const { conversationId } = await customerConversation(organization.id);
      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });

      const outsider = await connectAgent(otherOwner.accessToken, otherOrganization.id);
      const collected = collectAnyEvent(outsider);

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      expect(await collected).toEqual([]);
    });
  });

  describe("a removed member's socket", () => {
    it("cannot open a NEW socket for the tenant they were removed from", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();

      // It works before removal.
      (await connectAgent(agent.accessToken, organization.id)).close();

      await request(app)
        .delete(membersPath(organization.id, `/${agentMembershipId}`))
        .set(authed(owner.accessToken));

      await expect(connectAgent(agent.accessToken, organization.id)).rejects.toThrow();
    });
  });

  describe("existing real-time behaviour still works", () => {
    it("delivers a customer message to a connected agent after a membership change", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      await request(app)
        .patch(`${membersPath(organization.id)}/${agentMembershipId}/role`)
        .set(authed(owner.accessToken))
        .send({ role: "supervisor" });

      const watcher = await connectAgent(agent.accessToken, organization.id);
      const delivered = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for message:new")), 5000);
        watcher.once("message:new", (payload: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

      await request(app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "hello after a role change" });

      const message = await delivered;
      expect(message.body).toBe("hello after a role change");
      expect(message.senderType).toBe("customer");
    });

    it("delivers an agent reply to the customer after a membership change", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      await request(app)
        .patch(`${membersPath(organization.id)}/${agentMembershipId}/role`)
        .set(authed(owner.accessToken))
        .send({ role: "supervisor" });

      const customer = await connectCustomer(widgetToken, conversationId);
      const delivered = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for message:new")), 5000);
        customer.once("message:new", (payload: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

      await request(app)
        .post(`${ORGANIZATIONS_PATH}/${organization.id}/conversations/${conversationId}/messages`)
        .set(authed(agent.accessToken))
        .send({ body: "an agent reply" });

      const message = await delivered;
      expect(message.body).toBe("an agent reply");
      expect(message.senderType).toBe("agent");
    });
  });
});
