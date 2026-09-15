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
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * Customer profiles (ADR-043): reading and editing a contact, blocking an
 * abusive visitor everywhere they can reach, and merging duplicates.
 */

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const ORG = "/api/v1/organizations";
const WIDGET = "/api/v1/widget";

describe("customer profiles", () => {
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
  async function signIn(name: string) {
    counter += 1;
    const email = `person${counter}@example.com`;
    const account = await createStaffAccount(fake.provider, { name, email, password: PASSWORD });
    await request(app).post("/api/v1/auth/verify-email").send({ email, code: fake.verifications.at(-1)!.code });
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
    return { token: login.body.data.accessToken as string, userId: account.id };
  }

  async function owner() {
    const person = await signIn("Olivia Owner");
    counter += 1;
    const organization = await createOrganizationAs(person.token, `Org ${counter}`);
    const widgetKey = (await OrganizationModel.findById(organization.id))!.widgetKey as string;
    return { ...person, organization, widgetKey };
  }

  async function member(organizationId: string, role: "agent" | "supervisor") {
    const person = await signIn(role === "agent" ? "Alan Agent" : "Sam Supervisor");
    await MembershipModel.create({ userId: person.userId, organizationId, role, status: "active", invitedByUserId: null });
    return person;
  }

  /** A visitor with a session, a conversation, and a message. */
  async function visitor(widgetKey: string, details: Record<string, string> = {}, body = "hello") {
    const session = await request(app).post(`${WIDGET}/session`).send({ widgetKey, ...details });
    const token = session.body.data.token as string;
    const visitorKey = session.body.data.visitorKey as string;
    const customerId = session.body.data.customer.id as string;
    const conversation = await request(app).post(`${WIDGET}/conversations`).set("Authorization", `Bearer ${token}`).send({});
    const conversationId = conversation.body.data.id as string;
    await request(app).post(`${WIDGET}/conversations/${conversationId}/messages`).set("Authorization", `Bearer ${token}`).send({ body });
    return { token, visitorKey, customerId, conversationId };
  }

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const profilePath = (organizationId: string, customerId: string, suffix = "") => `${ORG}/${organizationId}/customers/${customerId}${suffix}`;

  function connect(auth: Record<string, unknown>): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, { auth, transports: ["websocket"], forceNew: true, reconnection: false });
      openSockets.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
  }

  // ---- reading and editing ----

  describe("the profile", () => {
    it("shows the contact's details and conversations to any agent", async () => {
      const { organization, widgetKey } = await owner();
      const agent = await member(organization.id, "agent");
      const grace = await visitor(widgetKey, { name: "Grace", email: "grace@example.com" });

      const response = await request(app).get(profilePath(organization.id, grace.customerId)).set(as(agent.token));

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ id: grace.customerId, name: "Grace", email: "grace@example.com", blocked: false });
      expect(response.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([grace.conversationId]);
      expect(JSON.stringify(response.body)).not.toContain("visitorKey");
    });

    it("lets an agent correct details and add a note, and tells the team live", async () => {
      const { token, organization, widgetKey } = await owner();
      const agent = await member(organization.id, "agent");
      const grace = await visitor(widgetKey);
      const teamSocket = await connect({ token, organizationId: organization.id });
      const heard = new Promise<{ name: string }>((resolve) => teamSocket.once("customer:updated", resolve));

      const response = await request(app)
        .patch(profilePath(organization.id, grace.customerId))
        .set(as(agent.token))
        .send({ name: "Grace Hopper", email: "GRACE@Navy.example", profileNote: "Prefers email" });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ name: "Grace Hopper", email: "grace@navy.example", profileNote: "Prefers email" });
      expect((await heard).name).toBe("Grace Hopper");

      const cleared = await request(app).patch(profilePath(organization.id, grace.customerId)).set(as(agent.token)).send({ email: null, phone: "" });
      expect(cleared.body.data.email).toBeNull();
    });

    it("refuses bad details and an empty update", async () => {
      const { token, organization, widgetKey } = await owner();
      const grace = await visitor(widgetKey);
      const patch = (body: object) => request(app).patch(profilePath(organization.id, grace.customerId)).set(as(token)).send(body);

      expect((await patch({ email: "not an email" })).status).toBe(400);
      expect((await patch({ phone: "call me" })).status).toBe(400);
      expect((await patch({})).status).toBe(400);
    });

    it("finds contacts by name, email or phone", async () => {
      const { token, organization, widgetKey } = await owner();
      const grace = await visitor(widgetKey, { name: "Grace Hopper" });
      await visitor(widgetKey, { name: "Linus", phone: "+44 20 7946 0958" });

      const byName = await request(app).get(`${ORG}/${organization.id}/customers`).query({ q: "hopper" }).set(as(token));
      const byPhone = await request(app).get(`${ORG}/${organization.id}/customers`).query({ q: "7946" }).set(as(token));

      expect(byName.body.data.customers.map((c: { id: string }) => c.id)).toEqual([grace.customerId]);
      expect(byPhone.body.data.customers[0].name).toBe("Linus");
      expect((await request(app).get(`${ORG}/${organization.id}/customers`).query({ q: "x" }).set(as(token))).status).toBe(400);
    });

    it("gives another organisation the same 404 as a missing customer, for every route", async () => {
      const a = await owner();
      const b = await owner();
      const grace = await visitor(a.widgetKey, { name: "Grace" });

      const responses = await Promise.all([
        request(app).get(profilePath(b.organization.id, grace.customerId)).set(as(b.token)),
        request(app).patch(profilePath(b.organization.id, grace.customerId)).set(as(b.token)).send({ name: "Hijacked" }),
        request(app).post(profilePath(b.organization.id, grace.customerId, "/block")).set(as(b.token)),
        request(app).get(`${ORG}/${b.organization.id}/customers`).query({ q: "grace" }).set(as(b.token)),
      ]);

      expect(responses.slice(0, 3).map((r) => r.status)).toEqual([404, 404, 404]);
      expect(responses[3]!.body.data.customers).toEqual([]);
      expect((await CustomerModel.findById(grace.customerId))!.name).toBe("Grace");
    });
  });

  // ---- blocking ----

  describe("blocking", () => {
    it("is for supervisors and above, not agents", async () => {
      const { organization, widgetKey } = await owner();
      const agent = await member(organization.id, "agent");
      const supervisor = await member(organization.id, "supervisor");
      const grace = await visitor(widgetKey);

      expect((await request(app).post(profilePath(organization.id, grace.customerId, "/block")).set(as(agent.token))).status).toBe(403);
      expect((await request(app).post(profilePath(organization.id, grace.customerId, "/block")).set(as(supervisor.token))).status).toBe(200);
    });

    it("closes their conversation, refuses their token, their key and their socket, and disconnects them", async () => {
      const { token, organization, widgetKey } = await owner();
      const troll = await visitor(widgetKey, {}, "abuse");
      const trollSocket = await connect({ token: troll.token });
      await new Promise((resolve) => trollSocket.emit("conversation:join", { conversationId: troll.conversationId }, resolve));
      const disconnected = new Promise<void>((resolve) => trollSocket.once("disconnect", () => resolve()));

      const blocked = await request(app).post(profilePath(organization.id, troll.customerId, "/block")).set(as(token));

      expect(blocked.status).toBe(200);
      expect(blocked.body.data).toMatchObject({ blocked: true, blockedBy: { name: "Olivia Owner" } });
      expect((await ConversationModel.findById(troll.conversationId))!.status).toBe("closed");
      await disconnected;

      const send = await request(app)
        .post(`${WIDGET}/conversations/${troll.conversationId}/messages`)
        .set("Authorization", `Bearer ${troll.token}`)
        .send({ body: "more abuse" });
      expect(send.status).toBe(403);

      const resume = await request(app).post(`${WIDGET}/session`).send({ widgetKey, visitorToken: troll.token, visitorKey: troll.visitorKey });
      expect(resume.status).toBe(403);
      expect(resume.body.error.code).toBe("WIDGET_SESSION_REFUSED");

      await expect(connect({ token: troll.token })).rejects.toThrow();
    });

    it("can be undone", async () => {
      const { token, organization, widgetKey } = await owner();
      const grace = await visitor(widgetKey);
      await request(app).post(profilePath(organization.id, grace.customerId, "/block")).set(as(token));

      const unblocked = await request(app).delete(profilePath(organization.id, grace.customerId, "/block")).set(as(token));
      const resume = await request(app).post(`${WIDGET}/session`).send({ widgetKey, visitorKey: grace.visitorKey });

      expect(unblocked.body.data.blocked).toBe(false);
      expect(resume.status).toBe(201);
      expect(resume.body.data.customer.id).toBe(grace.customerId);
    });

    it("marks a blocked customer in the inbox list", async () => {
      const { token, organization, widgetKey } = await owner();
      const grace = await visitor(widgetKey);
      await request(app).post(profilePath(organization.id, grace.customerId, "/block")).set(as(token));

      const inbox = await request(app).get(`${ORG}/${organization.id}/conversations`).set(as(token));

      expect(inbox.body.data.conversations[0].customer.blocked).toBe(true);
    });
  });

  // ---- merging ----

  describe("merging", () => {
    it("moves the duplicate's conversations and messages, fills missing details, and follows the visitor", async () => {
      const { token, organization, widgetKey } = await owner();
      const phone = await visitor(widgetKey, { name: "Grace" }, "from my phone");
      const laptop = await visitor(widgetKey, { email: "grace@example.com" }, "from my laptop");
      // Only one open conversation between them is allowed.
      await request(app).patch(`${ORG}/${organization.id}/conversations/${laptop.conversationId}/status`).set(as(token)).send({ status: "closed" });

      const merged = await request(app)
        .post(profilePath(organization.id, phone.customerId, "/merge"))
        .set(as(token))
        .send({ sourceCustomerId: laptop.customerId });

      expect(merged.status).toBe(200);
      expect(merged.body.data).toMatchObject({ id: phone.customerId, name: "Grace", email: "grace@example.com" });
      expect(merged.body.data.conversations.map((c: { id: string }) => c.id).sort()).toEqual([phone.conversationId, laptop.conversationId].sort());
      expect(await MessageModel.countDocuments({ customerId: phone.customerId })).toBe(2);
      expect(await MessageModel.countDocuments({ customerId: laptop.customerId })).toBe(0);

      // The laptop's old token no longer works, but its key resumes as the merged customer.
      const oldToken = await request(app).get(`${WIDGET}/conversations/${laptop.conversationId}/messages`).set("Authorization", `Bearer ${laptop.token}`);
      expect(oldToken.status).toBe(403);
      const resumed = await request(app).post(`${WIDGET}/session`).send({ widgetKey, visitorKey: laptop.visitorKey });
      expect(resumed.body.data.customer.id).toBe(phone.customerId);

      // The duplicate is gone from profiles and search.
      expect((await request(app).get(profilePath(organization.id, laptop.customerId)).set(as(token))).status).toBe(404);
    });

    it("refuses when both have an open conversation, a self-merge, and a customer from another organisation", async () => {
      const a = await owner();
      const b = await owner();
      const one = await visitor(a.widgetKey);
      const two = await visitor(a.widgetKey);
      const foreign = await visitor(b.widgetKey);
      const merge = (target: string, source: string) =>
        request(app).post(profilePath(a.organization.id, target, "/merge")).set(as(a.token)).send({ sourceCustomerId: source });

      const bothOpen = await merge(one.customerId, two.customerId);
      expect(bothOpen.status).toBe(409);
      expect(bothOpen.body.error.code).toBe("CUSTOMER_MERGE_CONFLICT");
      expect((await merge(one.customerId, one.customerId)).status).toBe(400);
      expect((await merge(one.customerId, foreign.customerId)).status).toBe(404);
      expect(await ConversationModel.countDocuments({ customerId: foreign.customerId })).toBe(1);
    });

    it("is not available to an agent", async () => {
      const { organization, widgetKey } = await owner();
      const agent = await member(organization.id, "agent");
      const one = await visitor(widgetKey);
      const two = await visitor(widgetKey);

      const response = await request(app)
        .post(profilePath(organization.id, one.customerId, "/merge"))
        .set(as(agent.token))
        .send({ sourceCustomerId: two.customerId });

      expect(response.status).toBe(403);
    });
  });
});
