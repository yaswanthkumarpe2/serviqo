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
import { NoteModel } from "../src/modules/notes/note.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { createOrganizationAs } from "../src/modules/organizations/testing/organizations";
import { SavedReplyModel } from "../src/modules/savedReplies/savedReply.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { createSocketServer } from "../src/realtime/createSocketServer";

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket as ClientSocket } from "socket.io-client";

/**
 * Agent productivity (ADR-042): saved replies, internal notes with @mentions,
 * conversation tags, and inbox search — and the tenant and customer
 * boundaries around every one of them.
 */

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const ORG = "/api/v1/organizations";

describe("agent productivity", () => {
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
      NoteModel.init(),
      SavedReplyModel.init(),
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
      NoteModel.deleteMany({}),
      SavedReplyModel.deleteMany({}),
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
    return { token: login.body.data.accessToken as string, userId: account.id, email };
  }

  async function owner(name = "Olivia Owner") {
    const person = await signIn(name);
    counter += 1;
    const organization = await createOrganizationAs(person.token, `Org ${counter}`);
    return { ...person, organization };
  }

  async function member(organizationId: string, role: "agent" | "supervisor" | "admin", name: string, status: "active" | "suspended" = "active") {
    const person = await signIn(name);
    await MembershipModel.create({ userId: person.userId, organizationId, role, status, invitedByUserId: null });
    return person;
  }

  async function visitor(organizationId: string, details: { name?: string; email?: string } = {}) {
    const organization = await OrganizationModel.findById(organizationId);
    const session = await request(app).post("/api/v1/widget/session").send({ widgetKey: organization!.widgetKey, ...details });
    const token = session.body.data.token as string;
    const conversation = await request(app).post("/api/v1/widget/conversations").set("Authorization", `Bearer ${token}`).send({});
    const conversationId = conversation.body.data.id as string;
    const say = (body: string) =>
      request(app).post(`/api/v1/widget/conversations/${conversationId}/messages`).set("Authorization", `Bearer ${token}`).send({ body });
    return { token, conversationId, say };
  }

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  function connect(auth: Record<string, unknown>): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, { auth, transports: ["websocket"], forceNew: true, reconnection: false });
      openSockets.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
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

  function nothing(socket: ClientSocket, event: string, ms = 400): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = () => resolve(false);
      socket.once(event, handler);
      setTimeout(() => {
        socket.off(event, handler);
        resolve(true);
      }, ms);
    });
  }

  // ---- saved replies ----

  describe("saved replies", () => {
    const REFUND = { shortcut: "Refund", title: "Refund policy", body: "Refunds take 5–7 working days." };

    it("are written by a supervisor and used by an agent", async () => {
      const { organization } = await owner();
      const supervisor = await member(organization.id, "supervisor", "Sam Supervisor");
      const agent = await member(organization.id, "agent", "Alan Agent");

      const created = await request(app).post(`${ORG}/${organization.id}/saved-replies`).set(as(supervisor.token)).send(REFUND);
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ shortcut: "refund", title: "Refund policy" });

      const listed = await request(app).get(`${ORG}/${organization.id}/saved-replies`).set(as(agent.token));
      expect(listed.body.data.savedReplies).toHaveLength(1);

      const agentWrite = await request(app).post(`${ORG}/${organization.id}/saved-replies`).set(as(agent.token)).send({ ...REFUND, shortcut: "x" });
      expect(agentWrite.status).toBe(403);
    });

    it("updates and deletes, refuses a taken shortcut, and validates the shortcut", async () => {
      const { token, organization } = await owner();
      const path = `${ORG}/${organization.id}/saved-replies`;
      const first = await request(app).post(path).set(as(token)).send(REFUND);
      await request(app).post(path).set(as(token)).send({ ...REFUND, shortcut: "shipping" });

      expect((await request(app).post(path).set(as(token)).send(REFUND)).status).toBe(409);
      expect((await request(app).patch(`${path}/${first.body.data.id}`).set(as(token)).send({ shortcut: "shipping" })).status).toBe(409);
      expect((await request(app).post(path).set(as(token)).send({ ...REFUND, shortcut: "has space" })).status).toBe(400);

      const renamed = await request(app).patch(`${path}/${first.body.data.id}`).set(as(token)).send({ title: "Refunds" });
      expect(renamed.body.data.title).toBe("Refunds");

      expect((await request(app).delete(`${path}/${first.body.data.id}`).set(as(token))).status).toBe(204);
      expect((await request(app).get(path).set(as(token))).body.data.savedReplies).toHaveLength(1);
    });

    it("cannot be read, changed or deleted from another organisation", async () => {
      const a = await owner();
      const b = await owner();
      const reply = await request(app).post(`${ORG}/${a.organization.id}/saved-replies`).set(as(a.token)).send(REFUND);

      expect((await request(app).get(`${ORG}/${a.organization.id}/saved-replies`).set(as(b.token))).status).toBe(404);
      // B's own organisation in the path, A's reply id: finds nothing.
      expect((await request(app).patch(`${ORG}/${b.organization.id}/saved-replies/${reply.body.data.id}`).set(as(b.token)).send({ title: "x" })).status).toBe(404);
      expect((await request(app).delete(`${ORG}/${b.organization.id}/saved-replies/${reply.body.data.id}`).set(as(b.token))).status).toBe(404);
      expect(await SavedReplyModel.countDocuments()).toBe(1);
    });
  });

  // ---- notes ----

  describe("internal notes", () => {
    it("are shared with the team, name their author, and keep only real teammates as mentions", async () => {
      const { token, organization } = await owner("Olivia Owner");
      const agent = await member(organization.id, "agent", "Alan Agent");
      const suspended = await member(organization.id, "agent", "Sid Suspended", "suspended");
      const outsider = await owner("Oscar Outsider");
      const { conversationId } = await visitor(organization.id);

      const created = await request(app)
        .post(`${ORG}/${organization.id}/conversations/${conversationId}/notes`)
        .set(as(token))
        .send({ body: "VIP — @Alan please handle", mentionedUserIds: [agent.userId, suspended.userId, outsider.userId] });

      expect(created.status).toBe(201);
      expect(created.body.data.author).toEqual({ id: expect.any(String), name: "Olivia Owner" });
      expect(created.body.data.mentions).toEqual([{ id: agent.userId, name: "Alan Agent" }]);

      const listed = await request(app).get(`${ORG}/${organization.id}/conversations/${conversationId}/notes`).set(as(agent.token));
      expect(listed.body.data.notes.map((note: { body: string }) => note.body)).toEqual(["VIP — @Alan please handle"]);
    });

    it("never reach the customer: not in their history, not on their socket", async () => {
      const { token, organization } = await owner();
      const customer = await visitor(organization.id);
      const agentSocket = await connect({ token, organizationId: organization.id });
      const customerSocket = await connect({ token: customer.token });
      await new Promise((resolve) => customerSocket.emit("conversation:join", { conversationId: customer.conversationId }, resolve));

      const agentHears = next<{ body: string }>(agentSocket, "note:new");
      const customerHearsNothing = nothing(customerSocket, "note:new");

      await request(app)
        .post(`${ORG}/${organization.id}/conversations/${customer.conversationId}/notes`)
        .set(as(token))
        .send({ body: "SECRET_INTERNAL_NOTE" });

      expect((await agentHears).body).toBe("SECRET_INTERNAL_NOTE");
      expect(await customerHearsNothing).toBe(true);

      const history = await request(app)
        .get(`/api/v1/widget/conversations/${customer.conversationId}/messages`)
        .set("Authorization", `Bearer ${customer.token}`);
      expect(JSON.stringify(history.body)).not.toContain("SECRET_INTERNAL_NOTE");
    });

    it("gives another organisation the same 404 as a missing conversation", async () => {
      const a = await owner();
      const b = await owner();
      const { conversationId } = await visitor(a.organization.id);

      const read = await request(app).get(`${ORG}/${b.organization.id}/conversations/${conversationId}/notes`).set(as(b.token));
      const write = await request(app)
        .post(`${ORG}/${b.organization.id}/conversations/${conversationId}/notes`)
        .set(as(b.token))
        .send({ body: "hi" });

      expect([read.status, write.status]).toEqual([404, 404]);
      expect(await NoteModel.countDocuments()).toBe(0);
    });

    it("lists teammates by name only, for the mention picker", async () => {
      const { organization } = await owner("Olivia Owner");
      const agent = await member(organization.id, "agent", "Alan Agent");
      await member(organization.id, "agent", "Sid Suspended", "suspended");

      const response = await request(app).get(`${ORG}/${organization.id}/teammates`).set(as(agent.token));

      expect(response.body.data.teammates.map((t: { name: string }) => t.name)).toEqual(["Alan Agent", "Olivia Owner"]);
      expect(Object.keys(response.body.data.teammates[0]).sort()).toEqual(["id", "name"]);
      expect(JSON.stringify(response.body)).not.toContain(agent.email);
    });
  });

  // ---- tags ----

  describe("tags", () => {
    it("are normalised, de-duplicated, listed, and filterable", async () => {
      const { token, organization } = await owner();
      const first = await visitor(organization.id);
      const second = await visitor(organization.id);

      const tagged = await request(app)
        .put(`${ORG}/${organization.id}/conversations/${first.conversationId}/tags`)
        .set(as(token))
        .send({ tags: ["  Billing ", "billing", "VIP   customer"] });
      expect(tagged.status).toBe(200);
      expect(tagged.body.data.tags).toEqual(["billing", "vip customer"]);

      await request(app).put(`${ORG}/${organization.id}/conversations/${second.conversationId}/tags`).set(as(token)).send({ tags: ["shipping"] });

      const tags = await request(app).get(`${ORG}/${organization.id}/conversations/tags`).set(as(token));
      expect(tags.body.data.tags).toEqual(["billing", "shipping", "vip customer"]);

      const filtered = await request(app).get(`${ORG}/${organization.id}/conversations?tag=billing`).set(as(token));
      expect(filtered.body.data.conversations.map((c: { id: string }) => c.id)).toEqual([first.conversationId]);
    });

    it("refuses bad tags and more than ten", async () => {
      const { token, organization } = await owner();
      const { conversationId } = await visitor(organization.id);
      const put = (tags: unknown) =>
        request(app).put(`${ORG}/${organization.id}/conversations/${conversationId}/tags`).set(as(token)).send({ tags });

      expect((await put(["<script>"])).status).toBe(400);
      expect((await put(Array.from({ length: 11 }, (_, i) => `t${i}`))).status).toBe(400);
      expect((await put(["x".repeat(33)])).status).toBe(400);
    });

    it("reach the team live, and never the customer", async () => {
      const { token, organization } = await owner();
      const customer = await visitor(organization.id);
      const agentSocket = await connect({ token, organizationId: organization.id });
      const customerSocket = await connect({ token: customer.token });
      await new Promise((resolve) => customerSocket.emit("conversation:join", { conversationId: customer.conversationId }, resolve));

      const teamHears = next<{ tags: string[] }>(agentSocket, "conversation:updated");
      const customerHearsNothing = nothing(customerSocket, "conversation:updated");

      await request(app).put(`${ORG}/${organization.id}/conversations/${customer.conversationId}/tags`).set(as(token)).send({ tags: ["complaint"] });

      expect((await teamHears).tags).toEqual(["complaint"]);
      expect(await customerHearsNothing).toBe(true);
    });

    it("cannot be set on another organisation's conversation", async () => {
      const a = await owner();
      const b = await owner();
      const { conversationId } = await visitor(a.organization.id);

      const response = await request(app).put(`${ORG}/${b.organization.id}/conversations/${conversationId}/tags`).set(as(b.token)).send({ tags: ["x"] });

      expect(response.status).toBe(404);
      expect((await ConversationModel.findById(conversationId))!.tags).toEqual([]);
    });
  });

  // ---- search ----

  describe("search", () => {
    it("finds conversations by customer name, email, or a word in a message", async () => {
      const { token, organization } = await owner();
      const grace = await visitor(organization.id, { name: "Grace Hopper", email: "grace@navy.example" });
      const linus = await visitor(organization.id, { name: "Linus" });
      await linus.say("My parcel never arrived");
      await grace.say("Question about invoices");

      const search = async (q: string) =>
        (await request(app).get(`${ORG}/${organization.id}/conversations`).query({ q }).set(as(token))).body.data.conversations.map(
          (c: { id: string }) => c.id,
        );

      expect(await search("hopper")).toEqual([grace.conversationId]);
      expect(await search("navy.example")).toEqual([grace.conversationId]);
      expect(await search("parcel")).toEqual([linus.conversationId]);
      expect(await search("nothing-matches-this")).toEqual([]);
    });

    it("never finds another organisation's customers or messages", async () => {
      const a = await owner();
      const b = await owner();
      const theirs = await visitor(a.organization.id, { name: "Unique Zebra" });
      await theirs.say("uniquezebra words");
      await visitor(b.organization.id, { name: "Someone Else" });

      const byName = await request(app).get(`${ORG}/${b.organization.id}/conversations`).query({ q: "zebra" }).set(as(b.token));
      const byWord = await request(app).get(`${ORG}/${b.organization.id}/conversations`).query({ q: "uniquezebra" }).set(as(b.token));

      expect(byName.body.data.conversations).toEqual([]);
      expect(byWord.body.data.conversations).toEqual([]);
    });

    it("treats regex characters literally and bounds the query", async () => {
      const { token, organization } = await owner();
      await visitor(organization.id, { name: "a.b" });
      await visitor(organization.id, { name: "axb" });

      const dotted = await request(app).get(`${ORG}/${organization.id}/conversations`).query({ q: "a.b" }).set(as(token));
      expect(dotted.body.data.conversations).toHaveLength(1);

      expect((await request(app).get(`${ORG}/${organization.id}/conversations`).query({ q: "a" }).set(as(token))).status).toBe(400);
      expect((await request(app).get(`${ORG}/${organization.id}/conversations`).query({ q: "x".repeat(101) }).set(as(token))).status).toBe(400);
    });

    it("combines with the status filter and still pages", async () => {
      const { token, organization } = await owner();
      for (let i = 0; i < 3; i += 1) await visitor(organization.id, { name: `Pat ${i}` });

      const first = await request(app).get(`${ORG}/${organization.id}/conversations`).query({ q: "pat", status: "open", limit: 2 }).set(as(token));
      expect(first.body.data.conversations).toHaveLength(2);
      const second = await request(app)
        .get(`${ORG}/${organization.id}/conversations`)
        .query({ q: "pat", status: "open", limit: 2, cursor: first.body.data.nextCursor })
        .set(as(token));
      expect(second.body.data.conversations).toHaveLength(1);
      expect(second.body.data.nextCursor).toBeNull();
    });
  });
});
