import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

/**
 * The three kinds of person (ADR-034).
 *
 * A customer who registers at the front door and talks to support; an agent
 * an admin created, who must verify before the emailed password works; and the
 * admin who created them.
 *
 * The assertions that matter are the boundaries between them — what each one
 * is refused — because that is the whole security argument for letting
 * customers hold accounts at all.
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ME_PATH = "/api/v1/auth/me";
const CHANGE_PASSWORD_PATH = "/api/v1/auth/change-password";
const MY_CONVERSATIONS_PATH = "/api/v1/me/conversations";
const AGENTS_PATH = "/api/v1/admin/agents";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const CUSTOMER_EMAIL = "shopper@example.com";
const ADMIN_EMAIL = "operator@example.com";
const AGENT_EMAIL = "agent@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

type Ctx = ReturnType<typeof buildApp>;

async function registerAndVerify(ctx: Ctx, email: string, name = "Ada Lovelace") {
  await request(ctx.app).post(REGISTER_PATH).send({ name, email, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });
}

async function signIn(ctx: Ctx, email: string, password = PASSWORD) {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password });
  return { status: login.status, body: login.body, token: login.body?.data?.accessToken as string | undefined };
}

/** An organization for customers to talk to, plus an admin who can add agents. */
async function seedPlatform(ctx: Ctx) {
  await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
  await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
  await UserModel.updateOne({ email: ADMIN_EMAIL }, { $set: { platformRole: "admin" } });
  const admin = await signIn(ctx, ADMIN_EMAIL);
  return admin.token!;
}

const authed = (ctx: Ctx, method: "get" | "post", path: string, token: string) =>
  request(ctx.app)[method](path).set("Authorization", `Bearer ${token}`);

describe("customers, agents and admins", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
    await SessionModel.init();
    await OrganizationModel.init();
    await MembershipModel.init();
    await CustomerModel.init();
    await ConversationModel.init();
    await MessageModel.init();
  });

  afterEach(async () => {
    /*
      Written out rather than mapped over an array of models: the models have
      different generic parameters, so a single array widens to a type whose
      `deleteMany` no longer type-checks.
    */
    await Promise.all([
      UserModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
      SessionModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      MessageModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- who public registration creates ----

  describe("public registration", () => {
    it("creates a customer, never an agent", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, CUSTOMER_EMAIL);

      const user = await UserModel.findOne({ email: CUSTOMER_EMAIL });

      expect(user!.kind).toBe("customer");
    });

    /*
      The escalation that must not exist. `kind` is not in the registration
      schema, so a body carrying it cannot reach the model — this asserts the
      outcome rather than the schema, because the outcome is what matters.
    */
    it("ignores a kind sent by the client", async () => {
      const ctx = buildApp();

      await request(ctx.app)
        .post(REGISTER_PATH)
        .send({ name: "Sneaky", email: CUSTOMER_EMAIL, password: PASSWORD, kind: "agent", platformRole: "admin" });

      const user = await UserModel.findOne({ email: CUSTOMER_EMAIL });
      expect(user!.kind).toBe("customer");
      expect(user!.platformRole).toBe("none");
    });

    it("reports the kind at login, so the client knows where to go", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, CUSTOMER_EMAIL);

      const login = await signIn(ctx, CUSTOMER_EMAIL);

      expect(login.body.data.user.kind).toBe("customer");
    });
  });

  // ---- the customer's own chat ----

  describe("a signed-in customer", () => {
    it("starts a conversation and sends a message", async () => {
      const ctx = buildApp();
      await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, CUSTOMER_EMAIL);
      const token = (await signIn(ctx, CUSTOMER_EMAIL)).token!;

      const started = await authed(ctx, "post", MY_CONVERSATIONS_PATH, token);
      expect(started.status).toBe(201);

      const conversationId = started.body.data.id as string;
      const sent = await authed(ctx, "post", `${MY_CONVERSATIONS_PATH}/${conversationId}/messages`, token).send({
        body: "My order never arrived.",
      });

      expect(sent.status).toBe(201);
      expect(sent.body.data.senderType).toBe("customer");
    });

    /*
      Idempotent by construction — a customer has at most one open conversation
      per tenant. Pressing "start a chat" twice must continue one conversation
      rather than opening a second.
    */
    it("continues the same conversation rather than opening a second", async () => {
      const ctx = buildApp();
      await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, CUSTOMER_EMAIL);
      const token = (await signIn(ctx, CUSTOMER_EMAIL)).token!;

      const first = await authed(ctx, "post", MY_CONVERSATIONS_PATH, token);
      const second = await authed(ctx, "post", MY_CONVERSATIONS_PATH, token);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await ConversationModel.countDocuments({})).toBe(1);
    });

    it("gets one customer record, reused across requests", async () => {
      const ctx = buildApp();
      await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, CUSTOMER_EMAIL);
      const token = (await signIn(ctx, CUSTOMER_EMAIL)).token!;

      await authed(ctx, "get", MY_CONVERSATIONS_PATH, token);
      await authed(ctx, "get", MY_CONVERSATIONS_PATH, token);

      expect(await CustomerModel.countDocuments({})).toBe(1);
    });

    /*
      The isolation that matters most on this surface: one customer's URL is
      not another customer's data. The refusal is the SAME opaque one a
      non-existent conversation produces (ADR-022 §8).
    */
    it("cannot read another customer's conversation", async () => {
      const ctx = buildApp();
      await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, CUSTOMER_EMAIL, "First Person");
      await registerAndVerify(ctx, "other@example.com", "Second Person");

      const firstToken = (await signIn(ctx, CUSTOMER_EMAIL)).token!;
      const theirs = await authed(ctx, "post", MY_CONVERSATIONS_PATH, firstToken);
      const conversationId = theirs.body.data.id as string;

      const secondToken = (await signIn(ctx, "other@example.com")).token!;
      const stolen = await authed(ctx, "get", `${MY_CONVERSATIONS_PATH}/${conversationId}/messages`, secondToken);

      expect(stolen.status).toBe(404);
    });

    it("sees only its own conversations in the list", async () => {
      const ctx = buildApp();
      await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, CUSTOMER_EMAIL, "First Person");
      await registerAndVerify(ctx, "other@example.com", "Second Person");

      const firstToken = (await signIn(ctx, CUSTOMER_EMAIL)).token!;
      await authed(ctx, "post", MY_CONVERSATIONS_PATH, firstToken);
      const secondToken = (await signIn(ctx, "other@example.com")).token!;
      await authed(ctx, "post", MY_CONVERSATIONS_PATH, secondToken);

      const mine = await authed(ctx, "get", MY_CONVERSATIONS_PATH, firstToken);

      expect(await ConversationModel.countDocuments({})).toBe(2);
      expect(mine.body.data.conversations).toHaveLength(1);
    });

    it("is told plainly when no organization exists yet", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, CUSTOMER_EMAIL);
      const token = (await signIn(ctx, CUSTOMER_EMAIL)).token!;

      const response = await authed(ctx, "get", MY_CONVERSATIONS_PATH, token);

      expect(response.status).toBe(404);
    });

    it("is refused without a token", async () => {
      const ctx = buildApp();

      expect((await request(ctx.app).get(MY_CONVERSATIONS_PATH)).status).toBe(401);
    });
  });

  // ---- adding an agent ----

  describe("an admin adding an agent", () => {
    it("creates an unverified agent and emails a password", async () => {
      const ctx = buildApp();
      const adminToken = await seedPlatform(ctx);

      const response = await authed(ctx, "post", AGENTS_PATH, adminToken).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
      });

      expect(response.status).toBe(201);

      const agent = await UserModel.findOne({ email: AGENT_EMAIL });
      expect(agent!.kind).toBe("agent");
      expect(agent!.emailVerifiedAt).toBeNull();

      const mail = ctx.fake.agentCredentials.at(-1)!;
      expect(mail.to).toBe(AGENT_EMAIL);
      expect(mail.temporaryPassword.length).toBeGreaterThan(10);
      expect(mail.code).toMatch(/^\d{6}$/);
    });

    it("gives the agent a membership in the organization", async () => {
      const ctx = buildApp();
      const adminToken = await seedPlatform(ctx);

      await authed(ctx, "post", AGENTS_PATH, adminToken).send({ name: "Alan Turing", email: AGENT_EMAIL });

      const agent = await UserModel.findOne({ email: AGENT_EMAIL });
      const membership = await MembershipModel.findOne({ userId: agent!._id });

      expect(membership!.role).toBe("agent");
      expect(membership!.status).toBe("active");
    });

    /* The password never leaves the email. */
    it("never returns the password in the response", async () => {
      const ctx = buildApp();
      const adminToken = await seedPlatform(ctx);

      const response = await authed(ctx, "post", AGENTS_PATH, adminToken).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
      });

      const password = ctx.fake.agentCredentials.at(-1)!.temporaryPassword;
      expect(JSON.stringify(response.body)).not.toContain(password);
    });

    it("refuses a body that tries to set anything else", async () => {
      const ctx = buildApp();
      const adminToken = await seedPlatform(ctx);

      const response = await authed(ctx, "post", AGENTS_PATH, adminToken).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
        role: "owner",
        platformRole: "admin",
      });

      expect(response.status).toBe(400);
      expect(await UserModel.countDocuments({ email: AGENT_EMAIL })).toBe(0);
    });

    it("refuses a caller who is not a platform admin", async () => {
      const ctx = buildApp();
      await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, CUSTOMER_EMAIL);
      const token = (await signIn(ctx, CUSTOMER_EMAIL)).token!;

      const response = await authed(ctx, "post", AGENTS_PATH, token).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
      });

      expect(response.status).toBe(403);
      expect(await UserModel.countDocuments({ email: AGENT_EMAIL })).toBe(0);
    });
  });

  // ---- the agent's own first sign-in ----

  describe("an invited agent", () => {
    async function inviteAgent(ctx: Ctx) {
      const adminToken = await seedPlatform(ctx);
      await authed(ctx, "post", AGENTS_PATH, adminToken).send({ name: "Alan Turing", email: AGENT_EMAIL });
      return ctx.fake.agentCredentials.at(-1)!;
    }

    /*
      The requirement driving the whole invitation design: an admin typing an
      address is not evidence anybody reads it, so the account is inert until
      the code proves otherwise.
    */
    it("cannot sign in before verifying, and is told why", async () => {
      const ctx = buildApp();
      const mail = await inviteAgent(ctx);

      const login = await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword);

      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    });

    it("signs in with the emailed password once verified", async () => {
      const ctx = buildApp();
      const mail = await inviteAgent(ctx);

      const verified = await request(ctx.app).post(VERIFY_PATH).send({ email: AGENT_EMAIL, code: mail.code });
      expect(verified.status).toBe(204);

      const login = await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword);

      expect(login.status).toBe(200);
      expect(login.body.data.user.kind).toBe("agent");
    });

    it("is refused the customer surface", async () => {
      const ctx = buildApp();
      const mail = await inviteAgent(ctx);
      await request(ctx.app).post(VERIFY_PATH).send({ email: AGENT_EMAIL, code: mail.code });
      const token = (await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword)).token!;

      // An agent has an inbox; this is the other side of it, and one account
      // must not hold both roles.
      expect((await authed(ctx, "get", MY_CONVERSATIONS_PATH, token)).status).toBe(403);
    });

    it("changes the emailed password, and the old one stops working", async () => {
      const ctx = buildApp();
      const mail = await inviteAgent(ctx);
      await request(ctx.app).post(VERIFY_PATH).send({ email: AGENT_EMAIL, code: mail.code });
      const token = (await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword)).token!;

      const changed = await authed(ctx, "post", CHANGE_PASSWORD_PATH, token).send({
        currentPassword: mail.temporaryPassword,
        newPassword: "a-password-of-their-own-choosing",
      });
      expect(changed.status).toBe(204);

      expect((await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword)).status).toBe(401);
      expect((await signIn(ctx, AGENT_EMAIL, "a-password-of-their-own-choosing")).status).toBe(200);
    });

    it("cannot change a password without knowing the current one", async () => {
      const ctx = buildApp();
      const mail = await inviteAgent(ctx);
      await request(ctx.app).post(VERIFY_PATH).send({ email: AGENT_EMAIL, code: mail.code });
      const token = (await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword)).token!;

      const response = await authed(ctx, "post", CHANGE_PASSWORD_PATH, token).send({
        currentPassword: "not-the-current-password",
        newPassword: "a-password-of-their-own-choosing",
      });

      expect(response.status).toBe(401);
    });

    /*
      An agent who "changed" their password back to the invitation's has left a
      permanent working credential sitting in an inbox.
    */
    it("refuses a new password identical to the old one", async () => {
      const ctx = buildApp();
      const mail = await inviteAgent(ctx);
      await request(ctx.app).post(VERIFY_PATH).send({ email: AGENT_EMAIL, code: mail.code });
      const token = (await signIn(ctx, AGENT_EMAIL, mail.temporaryPassword)).token!;

      const response = await authed(ctx, "post", CHANGE_PASSWORD_PATH, token).send({
        currentPassword: mail.temporaryPassword,
        newPassword: mail.temporaryPassword,
      });

      expect(response.status).toBe(400);
    });
  });

  // ---- what /me reports ----

  describe("GET /auth/me", () => {
    it("reports the kind so the client renders the right surface", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, CUSTOMER_EMAIL);
      const token = (await signIn(ctx, CUSTOMER_EMAIL)).token!;

      const response = await authed(ctx, "get", ME_PATH, token);

      expect(response.body.data.user.kind).toBe("customer");
    });
  });
});
