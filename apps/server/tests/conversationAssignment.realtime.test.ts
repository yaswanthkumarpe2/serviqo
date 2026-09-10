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
import { conversationEvents } from "../src/modules/conversations/conversationEvents";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * End-to-end coverage for live assignment and status changes (ADR-026 §9,
 * §10).
 *
 * Real HTTP server, real MongoDB, and TWO real agent connections at once,
 * because the whole claim of this slice's real-time half is that one agent's
 * action reaches another agent's screen. A single-client test could not tell
 * delivery from an echo.
 *
 * The assertion that matters most and is invisible when broken is the
 * NEGATIVE one: a customer's socket must never receive `conversation:updated`,
 * because the payload names a member of the tenant's staff (ADR-026 §10).
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

describe("conversation assignment real-time delivery", () => {
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
    const email = `live${emailCounter}@example.com`;

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

  async function customerConversation(organizationId: string) {
    const organization = await OrganizationModel.findById(organizationId);
    const session = await request(app)
      .post(WIDGET_SESSION_PATH)
      .send({ widgetKey: organization!.widgetKey, name: "Grace Hopper", email: "grace@example.com" });
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

  /** Collects every `conversation:updated` a socket receives over a fixed window. */
  function collectUpdates(socket: ClientSocket, ms = 400): Promise<Record<string, unknown>[]> {
    const received: Record<string, unknown>[] = [];
    socket.on("conversation:updated", (payload: Record<string, unknown>) => received.push(payload));
    return new Promise((resolve) => setTimeout(() => resolve(received), ms));
  }

  const assignmentPath = (organizationId: string, conversationId: string) =>
    `${ORGANIZATIONS_PATH}/${organizationId}/conversations/${conversationId}/assignment`;

  const statusPath = (organizationId: string, conversationId: string) =>
    `${ORGANIZATIONS_PATH}/${organizationId}/conversations/${conversationId}/status`;

  const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

  // ---- one agent's action reaches another agent ----

  describe("agent → Socket.IO → the tenant's other agents", () => {
    it("delivers a claim to a second connected agent", async () => {
      const owner = await signedInStaff("Ada Lovelace");
      const organization = await createOrganization(owner.accessToken, "Acme");
      const colleague = await signedInStaff("Katherine Johnson");
      await MembershipModel.create({
        userId: colleague.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const { conversationId } = await customerConversation(organization.id);
      const watcher = await connectAgent(colleague.accessToken, organization.id);
      const delivered = waitForUpdate(watcher);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const payload = await delivered;
      expect(payload.id).toBe(conversationId);
      expect(payload.assignedTo).toEqual({ id: owner.userId, name: null });
    });

    it("delivers a release", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const { conversationId } = await customerConversation(organization.id);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const watcher = await connectAgent(owner.accessToken, organization.id);
      const delivered = waitForUpdate(watcher);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "release" });

      expect((await delivered).assignedTo).toBeNull();
    });

    it("delivers a close and a reopen with the new status", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const { conversationId } = await customerConversation(organization.id);

      const watcher = await connectAgent(owner.accessToken, organization.id);

      const closed = waitForUpdate(watcher);
      await request(app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ status: "closed" });
      expect((await closed).status).toBe("closed");

      const reopened = waitForUpdate(watcher);
      await request(app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ status: "open" });
      expect((await reopened).status).toBe("open");
    });

    it("reaches every connected agent of the tenant, including the one who acted", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const colleague = await signedInStaff();
      await MembershipModel.create({
        userId: colleague.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const { conversationId } = await customerConversation(organization.id);
      const actor = await connectAgent(owner.accessToken, organization.id);
      const watcher = await connectAgent(colleague.accessToken, organization.id);

      const both = Promise.all([waitForUpdate(actor), waitForUpdate(watcher)]);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const [toActor, toWatcher] = await both;
      expect(toActor).toEqual(toWatcher);
    });

    it("publishes nothing when a claim is refused", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const colleague = await signedInStaff();
      await MembershipModel.create({
        userId: colleague.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });

      const { conversationId } = await customerConversation(organization.id);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      const watcher = await connectAgent(owner.accessToken, organization.id);
      const collected = collectUpdates(watcher);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(colleague.accessToken))
        .send({ action: "claim" });

      expect(await collected).toEqual([]);
    });
  });

  // ---- the customer must not hear about it ----

  describe("staff identity does not reach the customer", () => {
    it("does not deliver conversation:updated to the customer's own socket", async () => {
      const owner = await signedInStaff("Ada Lovelace");
      const organization = await createOrganization(owner.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      const customer = await connectCustomer(widgetToken, conversationId);
      const agent = await connectAgent(owner.accessToken, organization.id);

      const customerHeard = collectUpdates(customer);
      const agentHeard = waitForUpdate(agent);

      await request(app)
        .patch(assignmentPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });

      /*
        THE assertion ADR-026 §10 exists for. The payload carries
        `assignedTo`, which names a member of the tenant's staff, and which
        employee is handling a ticket is internal operational detail.

        The agent hearing it is what proves the customer's silence is a
        routing decision rather than a broadcast that simply did not happen.
      */
      await agentHeard;
      expect(await customerHeard).toEqual([]);
    });

    it("does not tell the customer their conversation was closed", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      const customer = await connectCustomer(widgetToken, conversationId);
      const agent = await connectAgent(owner.accessToken, organization.id);

      const customerHeard = collectUpdates(customer);
      const agentHeard = waitForUpdate(agent);

      await request(app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ status: "closed" });

      await agentHeard;
      expect(await customerHeard).toEqual([]);
    });

    it("refuses a socket-sent message into a closed conversation with its own ack code", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      const customer = await connectCustomer(widgetToken, conversationId);

      await request(app)
        .patch(statusPath(organization.id, conversationId))
        .set(authed(owner.accessToken))
        .send({ status: "closed" });

      const ack = await new Promise<{ ok: boolean; error?: { code: string; message: string } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ack timeout")), 5000);
        customer.emit("message:send", { conversationId, body: "are you there?" }, (response: never) => {
          clearTimeout(timer);
          resolve(response);
        });
      });

      /*
        Its own code rather than `NOT_FOUND`, because the widget branches on
        it to recover — resolve a new conversation and retry once
        (ADR-026 §8). A client that cannot tell "closed" from "gone" cannot
        recover.
      */
      expect(ack.ok).toBe(false);
      expect(ack.error!.code).toBe("CONVERSATION_CLOSED");
      expect(await MessageModel.countDocuments({ conversationId, body: "are you there?" })).toBe(0);
    });

    it("delivers a socket-sent message again once the conversation is reopened", async () => {
      const owner = await signedInStaff();
      const organization = await createOrganization(owner.accessToken, "Acme");
      const { conversationId, widgetToken } = await customerConversation(organization.id);

      const customer = await connectCustomer(widgetToken, conversationId);
      const path = statusPath(organization.id, conversationId);

      await request(app).patch(path).set(authed(owner.accessToken)).send({ status: "closed" });
      await request(app).patch(path).set(authed(owner.accessToken)).send({ status: "open" });

      const ack = await new Promise<{ ok: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ack timeout")), 5000);
        customer.emit("message:send", { conversationId, body: "back again" }, (response: never) => {
          clearTimeout(timer);
          resolve(response);
        });
      });

      expect(ack.ok).toBe(true);
    });
  });

  // ---- cross-organization isolation ----

  describe("cross-organization isolation", () => {
    it("does not deliver one tenant's assignment change to another tenant's agent", async () => {
      const staffA = await signedInStaff();
      const orgA = await createOrganization(staffA.accessToken, "Acme");
      const staffB = await signedInStaff();
      const orgB = await createOrganization(staffB.accessToken, "Globex");

      const { conversationId } = await customerConversation(orgA.id);

      const watcherB = await connectAgent(staffB.accessToken, orgB.id);
      const watcherA = await connectAgent(staffA.accessToken, orgA.id);

      const heardByB = collectUpdates(watcherB);
      const heardByA = waitForUpdate(watcherA);

      await request(app)
        .patch(assignmentPath(orgA.id, conversationId))
        .set(authed(staffA.accessToken))
        .send({ action: "claim" });

      // The room name is built from the organization the server proved at
      // handshake time (ADR-025 §9), so there is no name a client could cause
      // to be constructed that reaches another tenant.
      await heardByA;
      expect(await heardByB).toEqual([]);
    });

    it("does not deliver a status change across tenants", async () => {
      const staffA = await signedInStaff();
      const orgA = await createOrganization(staffA.accessToken, "Acme");
      const staffB = await signedInStaff();
      const orgB = await createOrganization(staffB.accessToken, "Globex");

      const { conversationId } = await customerConversation(orgA.id);

      const watcherB = await connectAgent(staffB.accessToken, orgB.id);
      const watcherA = await connectAgent(staffA.accessToken, orgA.id);

      const heardByB = collectUpdates(watcherB);
      const heardByA = waitForUpdate(watcherA);

      await request(app)
        .patch(statusPath(orgA.id, conversationId))
        .set(authed(staffA.accessToken))
        .send({ status: "closed" });

      await heardByA;
      expect(await heardByB).toEqual([]);
    });
  });

  // ---- subscriber lifecycle ----

  describe("the conversation.updated subscriber", () => {
    it("is removed when the http server it is attached to closes", async () => {
      const before = conversationEvents.listenerCount();

      const server = createServer();
      createSocketServer(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));

      expect(conversationEvents.listenerCount()).toBe(before + 1);

      await new Promise<void>((resolve) => server.close(() => resolve()));

      /*
        A module-scope emitter with per-instance subscribers is safe only if
        the subscribers are actually removed (ADR-025 §2, ADR-026 §9), and the
        suites construct and tear down several socket servers in one process.
      */
      expect(conversationEvents.listenerCount()).toBe(before);
    });
  });
});
