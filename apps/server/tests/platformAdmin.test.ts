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

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ME_PATH = "/api/v1/auth/me";
const ORGANIZATIONS_PATH = "/api/v1/organizations";

const OVERVIEW_PATH = "/api/v1/admin/overview";
const ADMIN_ORGANIZATIONS_PATH = "/api/v1/admin/organizations";
const ADMIN_USERS_PATH = "/api/v1/admin/users";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const ADMIN_EMAIL = "operator@example.com";
const TENANT_EMAIL = "ada@example.com";

/**
 * The platform operations surface (ADR-032).
 *
 * The assertions that matter here are the refusals. This is the only API in
 * Serviqo that reads across tenants, so "who is turned away" is the whole
 * security argument, and "what an admin sees" is the smaller half.
 */

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

async function signIn(ctx: Ctx, email: string): Promise<string> {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return login.body.data.accessToken as string;
}

/** Promotes an account exactly the way `grant:admin` does — by writing the field. */
async function grantPlatformAdmin(email: string) {
  await UserModel.updateOne({ email }, { $set: { platformRole: "admin" } });
}

const get = (ctx: Ctx, path: string, accessToken: string) =>
  request(ctx.app).get(path).set("Authorization", `Bearer ${accessToken}`);

describe("the platform admin API", () => {
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

  // ---- who is refused ----

  describe("the boundary", () => {
    it("refuses an unauthenticated caller", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).get(OVERVIEW_PATH);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("refuses an ordinary verified user", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, TENANT_EMAIL);
      const accessToken = await signIn(ctx, TENANT_EMAIL);

      const response = await get(ctx, OVERVIEW_PATH, accessToken);

      expect(response.status).toBe(403);
    });

    /*
      The escalation that must not exist. Owning a tenant is the most powerful
      thing a customer can be, and it confers no platform standing whatsoever
      — which is the reason `platformRole` lives on `User` and is not a fifth
      `MembershipRole`.
    */
    it("refuses an organization owner", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, TENANT_EMAIL);
      const accessToken = await signIn(ctx, TENANT_EMAIL);
      const created = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "Ada's Analytical Engines" });
      expect(created.status).toBe(201);

      const response = await get(ctx, OVERVIEW_PATH, accessToken);

      expect(response.status).toBe(403);
    });

    it("refuses every route, not only the overview", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, TENANT_EMAIL);
      const accessToken = await signIn(ctx, TENANT_EMAIL);

      for (const path of [OVERVIEW_PATH, ADMIN_ORGANIZATIONS_PATH, ADMIN_USERS_PATH]) {
        expect((await get(ctx, path, accessToken)).status).toBe(403);
      }
    });

    /*
      The grant is read from the database on every request, never from the
      token (ADR-032 §4). A revoked admin therefore stops being one on their
      very next call rather than whenever their access token expires — and
      this test holds the SAME token across the revocation to prove it.
    */
    it("stops serving a revoked admin without waiting for the token to expire", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      const accessToken = await signIn(ctx, ADMIN_EMAIL);
      expect((await get(ctx, OVERVIEW_PATH, accessToken)).status).toBe(200);

      await UserModel.updateOne({ email: ADMIN_EMAIL }, { $set: { platformRole: "none" } });

      expect((await get(ctx, OVERVIEW_PATH, accessToken)).status).toBe(403);
    });

    it("refuses a disabled admin", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      const accessToken = await signIn(ctx, ADMIN_EMAIL);

      await UserModel.updateOne({ email: ADMIN_EMAIL }, { $set: { status: "disabled" } });

      expect((await get(ctx, OVERVIEW_PATH, accessToken)).status).toBe(403);
    });

    /*
      A refusal names no role, no threshold and no endpoint behaviour. An
      ordinary user who pokes at the admin API learns that they may not use
      it, and nothing about what it is or who can.
    */
    it("discloses nothing about the platform role in a refusal", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, TENANT_EMAIL);
      const accessToken = await signIn(ctx, TENANT_EMAIL);

      const response = await get(ctx, OVERVIEW_PATH, accessToken);
      const body = JSON.stringify(response.body).toLowerCase();

      expect(body).not.toContain("platform");
      expect(body).not.toContain("admin");
    });
  });

  // ---- what an admin is told ----

  describe("the overview", () => {
    it("counts what actually exists", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      await registerAndVerify(ctx, TENANT_EMAIL);
      // Registered and never verified — the state that blocks sign-in.
      await request(ctx.app)
        .post(REGISTER_PATH)
        .send({ name: "Unverified Person", email: "pending@example.com", password: PASSWORD });

      const tenantToken = await signIn(ctx, TENANT_EMAIL);
      await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${tenantToken}`)
        .send({ name: "Ada's Analytical Engines" });

      const accessToken = await signIn(ctx, ADMIN_EMAIL);
      const response = await get(ctx, OVERVIEW_PATH, accessToken);

      expect(response.status).toBe(200);
      expect(response.body.data.totals.users).toBe(3);
      expect(response.body.data.totals.organizations).toBe(1);
      expect(response.body.data.users.verified).toBe(2);
      expect(response.body.data.users.unverified).toBe(1);
      expect(response.body.data.users.platformAdmins).toBe(1);
      expect(response.body.data.conversations.open).toBe(0);
    });
  });

  describe("the tenant list", () => {
    it("reports each organization with its owner and counts", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      await registerAndVerify(ctx, TENANT_EMAIL);

      const tenantToken = await signIn(ctx, TENANT_EMAIL);
      await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${tenantToken}`)
        .send({ name: "Ada's Analytical Engines" });

      const accessToken = await signIn(ctx, ADMIN_EMAIL);
      const response = await get(ctx, ADMIN_ORGANIZATIONS_PATH, accessToken);

      expect(response.status).toBe(200);
      expect(response.body.data.total).toBe(1);
      const [organization] = response.body.data.organizations;
      expect(organization.name).toBe("Ada's Analytical Engines");
      expect(organization.memberCount).toBe(1);
      expect(organization.conversationCount).toBe(0);
      expect(organization.owner.email).toBe(TENANT_EMAIL);
    });

    /*
      A page size is a hint, not an instruction. `?limit=100000` must not turn
      an operator's URL bar into a full table scan.
    */
    it("clamps an absurd limit rather than honouring it", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      const accessToken = await signIn(ctx, ADMIN_EMAIL);

      const response = await get(ctx, `${ADMIN_ORGANIZATIONS_PATH}?limit=100000`, accessToken);

      expect(response.status).toBe(200);
      expect(response.body.data.organizations.length).toBeLessThanOrEqual(100);
    });

    it("survives a malformed limit", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      const accessToken = await signIn(ctx, ADMIN_EMAIL);

      expect((await get(ctx, `${ADMIN_ORGANIZATIONS_PATH}?limit=abc`, accessToken)).status).toBe(200);
      expect((await get(ctx, `${ADMIN_ORGANIZATIONS_PATH}?limit=-4`, accessToken)).status).toBe(200);
    });
  });

  describe("the account list", () => {
    it("reports verification state, which is what blocks a sign-in", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      await request(ctx.app)
        .post(REGISTER_PATH)
        .send({ name: "Unverified Person", email: "pending@example.com", password: PASSWORD });

      const accessToken = await signIn(ctx, ADMIN_EMAIL);
      const response = await get(ctx, ADMIN_USERS_PATH, accessToken);

      expect(response.status).toBe(200);
      const pending = response.body.data.users.find(
        (user: { email: string }) => user.email === "pending@example.com",
      );
      expect(pending.emailVerifiedAt).toBeNull();
      expect(pending.platformRole).toBe("none");
    });

    /*
      The line ADR-032 draws: an operator sees that conversations exist and
      never what they said. This asserts the absence of the one field whose
      presence would break it.
    */
    it("carries no conversation content anywhere in the payload", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      const accessToken = await signIn(ctx, ADMIN_EMAIL);

      const organizationId = new mongoose.Types.ObjectId();
      const customerId = new mongoose.Types.ObjectId();
      const conversationId = new mongoose.Types.ObjectId();
      await MessageModel.create({
        _id: new mongoose.Types.ObjectId(),
        organizationId,
        conversationId,
        customerId,
        senderType: "customer",
        body: "MESSAGE_BODY_THAT_MUST_NOT_TRAVEL",
      });

      const bodies = await Promise.all(
        [OVERVIEW_PATH, ADMIN_ORGANIZATIONS_PATH, ADMIN_USERS_PATH].map(async (path) =>
          JSON.stringify((await get(ctx, path, accessToken)).body),
        ),
      );

      for (const body of bodies) {
        expect(body).not.toContain("MESSAGE_BODY_THAT_MUST_NOT_TRAVEL");
      }
    });
  });

  // ---- what the client routes on ----

  describe("GET /auth/me", () => {
    it("reports platformRole so a client knows which surface to render", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, ADMIN_EMAIL, "Grace Hopper");
      await grantPlatformAdmin(ADMIN_EMAIL);
      const accessToken = await signIn(ctx, ADMIN_EMAIL);

      const response = await get(ctx, ME_PATH, accessToken);

      expect(response.status).toBe(200);
      expect(response.body.data.user.platformRole).toBe("admin");
    });

    it('reports "none" for everyone else', async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, TENANT_EMAIL);
      const accessToken = await signIn(ctx, TENANT_EMAIL);

      const response = await get(ctx, ME_PATH, accessToken);

      expect(response.body.data.user.platformRole).toBe("none");
    });
  });
});
