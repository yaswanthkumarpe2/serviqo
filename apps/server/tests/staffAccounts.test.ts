import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { REFRESH_COOKIE_NAME } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

/**
 * Who holds an account, and who does not (ADR-034, narrowed by ADR-037).
 *
 * Staff hold accounts: an agent an admin invited, who must verify before the
 * emailed password works, and the admin who invited them. Customers do not —
 * they are anonymous visitors of one organisation's widget — so the first group
 * of assertions pins that no route will create, admit or serve a customer
 * account, including the ones ADR-034 wrote before ADR-037 removed them.
 */

const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ME_PATH = "/api/v1/auth/me";
const CHANGE_PASSWORD_PATH = "/api/v1/auth/change-password";
const MY_CONVERSATIONS_PATH = "/api/v1/me/conversations";
const REFRESH_PATH = "/api/v1/auth/refresh";
const FORGOT_PASSWORD_PATH = "/api/v1/auth/forgot-password";
const adminMembersPath = (organizationId: string) => `/api/v1/admin/organizations/${organizationId}/members`;

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const LEGACY_CUSTOMER_EMAIL = "shopper@example.com";
const ADMIN_EMAIL = "operator@example.com";
const AGENT_EMAIL = "agent@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

type Ctx = ReturnType<typeof buildApp>;

async function registerAndVerify(ctx: Ctx, email: string, name = "Ada Lovelace") {
  await createStaffAccount(ctx.fake.provider, { name, email, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });
}

async function signIn(ctx: Ctx, email: string, password = PASSWORD) {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password });
  return { status: login.status, body: login.body, token: login.body?.data?.accessToken as string | undefined };
}

/** An organisation to add agents to, plus a super admin who can add them (ADR-039 §3). */
async function seedPlatform(ctx: Ctx) {
  const organization = await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
  await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
  await UserModel.updateOne({ email: ADMIN_EMAIL }, { $set: { platformRole: "admin", kind: "admin" } });
  const admin = await signIn(ctx, ADMIN_EMAIL);
  return { adminToken: admin.token!, agentsPath: adminMembersPath(organization._id.toString()) };
}

const authed = (ctx: Ctx, method: "get" | "post", path: string, token: string) =>
  request(ctx.app)[method](path).set("Authorization", `Bearer ${token}`);

describe("staff accounts", () => {
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

  // ---- who does not hold an account ----

  describe("customers never hold accounts", () => {
    it("has no registration route", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post("/api/v1/auth/register")
        .send({ name: "Sneaky", email: LEGACY_CUSTOMER_EMAIL, password: PASSWORD });

      expect(response.status).toBe(404);
      expect(await UserModel.countDocuments({})).toBe(0);
    });

    it("has no signed-in customer surface", async () => {
      const ctx = buildApp();

      expect((await request(ctx.app).get(MY_CONVERSATIONS_PATH)).status).toBe(404);
      expect((await request(ctx.app).post(MY_CONVERSATIONS_PATH)).status).toBe(404);
    });

    /*
      ADR-034 wrote customer accounts, and ADR-037 removed them. The documents it
      left behind must stay inert: loadable, but unable to sign in, refresh, read
      /me, or be revived through a password reset.
    */
    describe("a legacy customer account", () => {
      async function legacyCustomer(ctx: Ctx) {
        await registerAndVerify(ctx, LEGACY_CUSTOMER_EMAIL);
        // Signed in while still staff-shaped, so there is a session to revoke.
        const before = await request(ctx.app).post(LOGIN_PATH).send({ email: LEGACY_CUSTOMER_EMAIL, password: PASSWORD });
        await UserModel.updateOne({ email: LEGACY_CUSTOMER_EMAIL }, { $set: { kind: "customer" } });
        const cookies = before.headers["set-cookie"] as unknown as string[];
        return {
          accessToken: before.body.data.accessToken as string,
          cookie: cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))!.split(";")[0]!,
        };
      }

      it("cannot sign in, and is refused exactly as a wrong password is", async () => {
        const ctx = buildApp();
        await legacyCustomer(ctx);

        const login = await signIn(ctx, LEGACY_CUSTOMER_EMAIL);
        const wrong = await signIn(ctx, LEGACY_CUSTOMER_EMAIL, "not-the-password");

        expect(login.status).toBe(401);
        expect(login.body.error.code).toBe(wrong.body.error.code);
        expect(login.body.error.message).toBe(wrong.body.error.message);
      });

      it("loses its existing session on the next refresh", async () => {
        const ctx = buildApp();
        const { cookie } = await legacyCustomer(ctx);

        expect((await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie)).status).toBe(401);
        expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
      });

      it("is refused by /me with a token issued before the change", async () => {
        const ctx = buildApp();
        const { accessToken } = await legacyCustomer(ctx);

        expect((await authed(ctx, "get", ME_PATH, accessToken)).status).toBe(401);
      });

      it("is sent no password reset code", async () => {
        const ctx = buildApp();
        await legacyCustomer(ctx);

        const response = await request(ctx.app).post(FORGOT_PASSWORD_PATH).send({ email: LEGACY_CUSTOMER_EMAIL });

        expect(response.status).toBe(204);
        expect(ctx.fake.passwordResets).toHaveLength(0);
      });
    });
  });

  // ---- the super admin adding an agent ----

  describe("a super admin adding an agent", () => {
    it("creates an unverified agent and emails a password", async () => {
      const ctx = buildApp();
      const { adminToken, agentsPath } = await seedPlatform(ctx);

      const response = await authed(ctx, "post", agentsPath, adminToken).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
        role: "agent",
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
      const { adminToken, agentsPath } = await seedPlatform(ctx);

      await authed(ctx, "post", agentsPath, adminToken).send({ name: "Alan Turing", email: AGENT_EMAIL, role: "agent" });

      const agent = await UserModel.findOne({ email: AGENT_EMAIL });
      const membership = await MembershipModel.findOne({ userId: agent!._id });

      expect(membership!.role).toBe("agent");
      expect(membership!.status).toBe("active");
    });

    /* The password never leaves the email. */
    it("never returns the password in the response", async () => {
      const ctx = buildApp();
      const { adminToken, agentsPath } = await seedPlatform(ctx);

      const response = await authed(ctx, "post", agentsPath, adminToken).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
        role: "agent",
      });

      const password = ctx.fake.agentCredentials.at(-1)!.temporaryPassword;
      expect(JSON.stringify(response.body)).not.toContain(password);
    });

    it("refuses a body that tries to set anything else", async () => {
      const ctx = buildApp();
      const { adminToken, agentsPath } = await seedPlatform(ctx);

      const response = await authed(ctx, "post", agentsPath, adminToken).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
        role: "agent",
        platformRole: "admin",
      });

      expect(response.status).toBe(400);
      expect(await UserModel.countDocuments({ email: AGENT_EMAIL })).toBe(0);
    });

    it("refuses a caller who is not a platform admin", async () => {
      const ctx = buildApp();
      const organization = await OrganizationModel.create({ name: "Acme Corp", slug: "acme-corp", allowedOrigins: [] });
      await registerAndVerify(ctx, "someone@example.com");
      const token = (await signIn(ctx, "someone@example.com")).token!;

      const response = await authed(ctx, "post", adminMembersPath(organization._id.toString()), token).send({
        name: "Alan Turing",
        email: AGENT_EMAIL,
        role: "agent",
      });

      expect(response.status).toBe(403);
      expect(await UserModel.countDocuments({ email: AGENT_EMAIL })).toBe(0);
    });
  });

  // ---- the agent's own first sign-in ----

  describe("an invited agent", () => {
    async function inviteAgent(ctx: Ctx) {
      const { adminToken, agentsPath } = await seedPlatform(ctx);
      await authed(ctx, "post", agentsPath, adminToken).send({ name: "Alan Turing", email: AGENT_EMAIL, role: "agent" });
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
      await registerAndVerify(ctx, "someone@example.com");
      const token = (await signIn(ctx, "someone@example.com")).token!;

      const response = await authed(ctx, "get", ME_PATH, token);

      expect(response.body.data.user.kind).toBe("agent");
    });
  });
});
