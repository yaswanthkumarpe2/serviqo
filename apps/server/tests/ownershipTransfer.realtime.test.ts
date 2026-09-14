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
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * End-to-end coverage for what ownership transfer does to the LIVE surface
 * (ADR-028 §14) — which is, deliberately, nothing.
 *
 * Real HTTP server, real MongoDB, real Socket.IO, with an agent connection and
 * a customer connection open ACROSS the transfer. ADR-027 §15 declined a roster
 * broadcast because a broadcast has no single reader to run
 * `can(role, "member.read")` against, and ADR-028 §14 applies that unchanged to
 * ownership — which is staff-only information about who controls a tenant.
 *
 * A test is what stops an event appearing by accident. The four claims:
 *
 * - No event of ANY name reaches an agent socket when ownership moves.
 * - No event of any name reaches a CUSTOMER socket — the boundary that would
 *   matter most if it broke (ADR-026 §10).
 * - Real-time message delivery keeps working in both directions afterwards,
 *   for the new owner and for the demoted one.
 * - The socket handshake — which verifies the staff token with the same
 *   primitives `requireOrganization` uses (ADR-025 §8) — still admits both
 *   parties after their roles changed under them.
 */

const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";
const WIDGET_CONVERSATIONS_PATH = "/api/v1/widget/conversations";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

describe("ownership transfer real-time behaviour", () => {
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
    const email = `ownerlive${emailCounter}@example.com`;

    await createStaffAccount(fake.provider, { name, email, password: PASSWORD });
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

  /** Collects EVERY event a socket receives, whatever its name. */
  function collectAnyEvent(socket: ClientSocket, ms = 600): Promise<string[]> {
    const names: string[] = [];
    socket.onAny((name: string) => names.push(name));
    return new Promise((resolve) => setTimeout(() => resolve(names), ms));
  }

  function waitForEvent(socket: ClientSocket, event: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5000);
      socket.once(event, (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  const ownershipPath = (organizationId: string) => `${ORGANIZATIONS_PATH}/${organizationId}/ownership`;
  const inboxPath = (organizationId: string, suffix = "") =>
    `${ORGANIZATIONS_PATH}/${organizationId}/conversations${suffix}`;
  const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

  /** Owner + organization + a second signed-in agent. */
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

  async function transfer(organizationId: string, accessToken: string, membershipId: string) {
    return request(app).post(ownershipPath(organizationId)).set(authed(accessToken)).send({ membershipId });
  }

  // ---- ADR-028 §14: nothing is broadcast ----

  describe("no ownership event is emitted", () => {
    it("sends nothing to a watching agent when ownership moves", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      // A THIRD person, whose socket is the one under observation — the agent
      // receiving ownership is not watching their own promotion.
      const watcher = await signedInStaff("Watcher");
      await MembershipModel.create({
        userId: watcher.userId,
        organizationId: organization.id,
        role: "agent",
        status: "active",
      });
      const watcherSocket = await connectAgent(watcher.accessToken, organization.id);

      const collected = collectAnyEvent(watcherSocket);
      const response = await transfer(organization.id, owner.accessToken, agentMembershipId);
      expect(response.status).toBe(200);

      expect(await collected).toEqual([]);
    });

    /*
      The boundary that would matter most if it broke. A customer must never
      learn that a staff role changed, let alone which staff member now owns
      the tenant (ADR-026 §10, SECURITY.md §2).
    */
    it("sends nothing to a connected customer when ownership moves", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);
      const customerSocket = await connectCustomer(widgetToken, conversationId);

      const collected = collectAnyEvent(customerSocket);
      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      expect(await collected).toEqual([]);
    });

    /*
      ADR-028 §13's complement, observed live: both roles hold
      `conversation.assign` today, so a transfer releases nothing and therefore
      broadcasts no `conversation:updated` either.
    */
    it("emits no conversation:updated for a conversation the previous owner holds", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const { conversationId } = await customerConversation(organization.id);

      const claim = await request(app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(owner.accessToken))
        .send({ action: "claim" });
      expect(claim.status).toBe(200);

      const ownerSocket = await connectAgent(owner.accessToken, organization.id);
      const collected = collectAnyEvent(ownerSocket);

      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      expect(await collected).toEqual([]);
      // Still assigned to the person who is now merely an admin.
      expect((await ConversationModel.findById(conversationId))!.assignedTo!.toString()).toBe(owner.userId);
    });

    /* A refused transfer is equally silent. */
    it("sends nothing when a transfer is refused", async () => {
      const { owner, organization } = await tenantWithAgent();
      const ownerSocket = await connectAgent(owner.accessToken, organization.id);

      const collected = collectAnyEvent(ownerSocket);
      // Well-formed and belonging to nothing, so the service refuses before any
      // write — and therefore before anything could be published.
      const refused = await transfer(organization.id, owner.accessToken, "507f1f77bcf86cd799439099");
      expect(refused.status).toBe(404);

      expect(await collected).toEqual([]);
    });
  });

  // ---- the live surface keeps working afterwards ----

  describe("real-time delivery after a transfer", () => {
    /*
      The socket handshake verifies the staff token with the same primitives
      `requireOrganization` uses and requires `conversation.read` (ADR-025 §8,
      §9). Both `owner` and `admin` hold it, so both parties must still be
      admitted after their roles swapped under them — with the tokens they
      already had.
    */
    it("admits both the new owner and the demoted owner", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();

      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      await expect(connectAgent(agent.accessToken, organization.id)).resolves.toBeDefined();
      await expect(connectAgent(owner.accessToken, organization.id)).resolves.toBeDefined();
    });

    it("delivers a customer message to both parties' inbox sockets", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      const newOwnerSocket = await connectAgent(agent.accessToken, organization.id);
      const demotedSocket = await connectAgent(owner.accessToken, organization.id);

      const both = Promise.all([
        waitForEvent(newOwnerSocket, "message:new"),
        waitForEvent(demotedSocket, "message:new"),
      ]);

      const sent = await request(app)
        .post(`${WIDGET_CONVERSATIONS_PATH}/${conversationId}/messages`)
        .set("Authorization", `Bearer ${widgetToken}`)
        .send({ body: "hello after the transfer" });
      expect(sent.status).toBe(201);

      const [forNewOwner, forDemoted] = await both;
      expect(forNewOwner).toMatchObject({ conversationId });
      expect(forDemoted).toMatchObject({ conversationId });
    });

    /* The other direction: the new owner's reply reaches the customer live. */
    it("delivers the new owner's reply to the customer", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      const customerSocket = await connectCustomer(widgetToken, conversationId);
      const delivered = waitForEvent(customerSocket, "message:new");

      const reply = await request(app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(agent.accessToken))
        // Deliberately free of the words this test then asserts are absent —
        // the message body is echoed back verbatim, so a body containing
        // "owner" would fail the disclosure check for the wrong reason.
        .send({ body: "thanks for waiting, looking into it now" });
      expect(reply.status).toBe(201);

      const payload = await delivered;
      expect(payload).toMatchObject({ conversationId, senderType: "agent" });
      /*
        Still no staff identity and no role on the customer's wire
        (ADR-026 §10). `senderType: "agent"` is the whole of what a customer
        learns about who answered, before and after a transfer alike.
      */
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("owner");
      expect(serialized).not.toContain("admin");
      expect(serialized).not.toContain(agent.email);
      expect(serialized).not.toContain(agent.name);
      expect(serialized).not.toContain(agent.userId);
    });

    /* And the demoted owner can still act, and still reaches the customer. */
    it("delivers the demoted owner's reply to the customer", async () => {
      const { owner, organization, agentMembershipId } = await tenantWithAgent();
      const { widgetToken, conversationId } = await customerConversation(organization.id);

      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      const customerSocket = await connectCustomer(widgetToken, conversationId);
      const delivered = waitForEvent(customerSocket, "message:new");

      const reply = await request(app)
        .post(inboxPath(organization.id, `/${conversationId}/messages`))
        .set(authed(owner.accessToken))
        .send({ body: "the previous owner, still an admin" });
      expect(reply.status).toBe(201);

      expect(await delivered).toMatchObject({ conversationId, senderType: "agent" });
    });

    /*
      A claim by the new owner still reaches the other agents' lists — the
      ADR-026 §9 seam is untouched by this slice, and this is what proves the
      transfer did not disturb it.
    */
    it("still broadcasts conversation:updated when the new owner claims", async () => {
      const { owner, organization, agent, agentMembershipId } = await tenantWithAgent();
      const { conversationId } = await customerConversation(organization.id);

      expect((await transfer(organization.id, owner.accessToken, agentMembershipId)).status).toBe(200);

      const watcherSocket = await connectAgent(owner.accessToken, organization.id);
      const updated = waitForEvent(watcherSocket, "conversation:updated");

      const claim = await request(app)
        .patch(inboxPath(organization.id, `/${conversationId}/assignment`))
        .set(authed(agent.accessToken))
        .send({ action: "claim" });
      expect(claim.status).toBe(200);

      expect(await updated).toMatchObject({ id: conversationId });
    });
  });

  // ---- tenant isolation on the wire ----

  describe("tenant isolation", () => {
    /*
      Two tenants, one agent socket in each. A transfer in one must produce
      nothing anywhere, and in particular nothing in the other — the room
      scoping ADR-025 §9 established, re-checked for the operation that changes
      who controls a tenant.
    */
    it("produces no event in another organization's inbox room", async () => {
      const a = await tenantWithAgent();
      const b = await tenantWithAgent();

      const socketA = await connectAgent(a.owner.accessToken, a.organization.id);
      const socketB = await connectAgent(b.owner.accessToken, b.organization.id);

      const collectedA = collectAnyEvent(socketA);
      const collectedB = collectAnyEvent(socketB);

      expect((await transfer(a.organization.id, a.owner.accessToken, a.agentMembershipId)).status).toBe(200);

      expect(await collectedA).toEqual([]);
      expect(await collectedB).toEqual([]);
    });
  });
});
