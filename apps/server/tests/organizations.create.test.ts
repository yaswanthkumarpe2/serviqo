import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ME_PATH = "/api/v1/auth/me";
const ORGANIZATIONS_PATH = "/api/v1/organizations";

/** Obvious sentinels — if either reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

type Ctx = ReturnType<typeof buildApp>;

async function registerAndVerify(ctx: Ctx, email: string) {
  await request(ctx.app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });
}

/** Registers, verifies, signs in, and returns a usable staff credential. */
async function signedInStaff(ctx: Ctx, email = EMAIL) {
  await registerAndVerify(ctx, email);
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return {
    accessToken: login.body.data.accessToken as string,
    userId: login.body.data.user.id as string,
  };
}

/** `object` rather than `unknown` — supertest's `.send()` accepts a body, not anything. */
const createOrganization = (ctx: Ctx, accessToken: string, body: object) =>
  request(ctx.app).post(ORGANIZATIONS_PATH).set("Authorization", `Bearer ${accessToken}`).send(body);

describe("POST /api/v1/organizations", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
    await SessionModel.init();
    await OrganizationModel.init();
    await MembershipModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
      SessionModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- the ordinary case ----

  describe("an authenticated staff user", () => {
    it("answers 201 in the approved envelope", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme Corp" });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(response.body.meta.requestId).toEqual(expect.any(String));
      expect(Object.keys(response.body).sort()).toEqual(["data", "meta", "success"]);
    });

    it("returns the organization and the caller's role", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme Corp" });

      expect(response.body.data.organization).toMatchObject({
        name: "Acme Corp",
        slug: "acme-corp",
        status: "active",
      });
      expect(response.body.data.organization.id).toEqual(expect.any(String));
      expect(response.body.data.role).toBe("owner");
    });

    it("carries exactly the approved organization fields", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      expect(Object.keys(response.body.data.organization).sort()).toEqual([
        "createdAt",
        "id",
        "name",
        "slug",
        "status",
      ]);
      expect(Object.keys(response.body.data).sort()).toEqual(["organization", "role"]);
    });

    it("persists the organization and its owner membership", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });
      const organizationId = response.body.data.organization.id as string;

      const stored = await OrganizationModel.findById(organizationId);
      const membership = await MembershipModel.findOne({ organizationId });

      expect(stored!.slug).toBe("acme");
      expect(membership!.userId.toString()).toBe(staff.userId);
      expect(membership!.role).toBe("owner");
    });

    it("creates exactly one owner membership", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });
      const organizationId = response.body.data.organization.id as string;

      await expect(MembershipModel.countDocuments({ organizationId })).resolves.toBe(1);
      await expect(MembershipModel.countDocuments({ organizationId, role: "owner" })).resolves.toBe(1);
    });

    it("lets the same user create a second organization", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const first = await createOrganization(ctx, staff.accessToken, { name: "Acme" });
      const second = await createOrganization(ctx, staff.accessToken, { name: "Globex" });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      await expect(MembershipModel.countDocuments({ role: "owner" })).resolves.toBe(2);
    });
  });

  // ---- authorization (ADR-016 §1) ----

  describe("authorization", () => {
    it("refuses a request with no Authorization header", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(ORGANIZATIONS_PATH).send({ name: "Acme" });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it.each([
      ["a malformed header", "not-a-scheme token"],
      ["the Basic scheme", "Basic YWRhOnBhc3M="],
      ["a tampered token", "Bearer aaa.bbb.ccc"],
    ])("refuses %s", async (_label, header) => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", header)
        .send({ name: "Acme" });

      expect(response.status).toBe(401);
    });

    it("creates nothing when the request is refused", async () => {
      const ctx = buildApp();

      await request(ctx.app).post(ORGANIZATIONS_PATH).send({ name: "Acme" });

      await expect(OrganizationModel.countDocuments({})).resolves.toBe(0);
      await expect(MembershipModel.countDocuments({})).resolves.toBe(0);
    });

    // The staff refresh cookie is not a credential for this route.
    it("refuses a request carrying only the refresh cookie", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const login = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const cookies = login.headers["set-cookie"] as unknown as string[];

      const response = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Cookie", cookies[0]!.split(";")[0]!)
        .send({ name: "Acme" });

      expect(response.status).toBe(401);
    });

    /*
      The token still verifies — only the account changed. ADR-016 §1a
      re-checks it, so a disabled staff member cannot keep creating tenants
      for the remaining life of an access token.
    */
    it("refuses after the creator's account is disabled", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      // Proof the credential itself is still good.
      expect((await createOrganization(ctx, staff.accessToken, { name: "Before" })).status).toBe(201);

      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

      const response = await createOrganization(ctx, staff.accessToken, { name: "After" });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("refuses after the creator's account is deleted", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      await UserModel.deleteMany({});

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      expect(response.status).toBe(401);
    });

    // A membership pointing at a deleted user is the phantom record
    // membership.model.ts asks the service layer to prevent.
    it("writes nothing for an account it refuses", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

      await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      await expect(OrganizationModel.countDocuments({})).resolves.toBe(0);
      await expect(MembershipModel.countDocuments({})).resolves.toBe(0);
    });
  });

  // ---- validation ----

  describe("validation", () => {
    it.each([
      ["a missing name", {}],
      ["an empty name", { name: "" }],
      ["a whitespace-only name", { name: "   " }],
      ["a name over the length bound", { name: "A".repeat(101) }],
      ["a name with a control character", { name: "Acme\u0007Corp" }],
      ["a name with a newline", { name: "Acme\nCorp" }],
      ["a non-string name", { name: 42 }],
      ["a null name", { name: null }],
    ])("rejects %s with 400", async (_label, body) => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details).toEqual(expect.any(Array));
    });

    it("creates nothing when validation fails", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      await createOrganization(ctx, staff.accessToken, { name: "" });

      await expect(OrganizationModel.countDocuments({})).resolves.toBe(0);
      await expect(MembershipModel.countDocuments({})).resolves.toBe(0);
    });

    it("trims the submitted name", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "  Acme Corp  " });

      expect(response.body.data.organization.name).toBe("Acme Corp");
    });

    it("checks authentication before validation", async () => {
      const ctx = buildApp();

      // An unauthenticated request with an invalid body must answer 401, not
      // 400 — a validation error would confirm the route exists and describe
      // its schema to an anonymous caller.
      const response = await request(ctx.app).post(ORGANIZATIONS_PATH).send({});

      expect(response.status).toBe(401);
    });
  });

  // ---- client-supplied identity is never trusted (ADR-016 §1) ----

  describe("client-supplied fields", () => {
    it("ignores an ownerUserId in the body", async () => {
      const ctx = buildApp();
      const ada = await signedInStaff(ctx, EMAIL);
      await registerAndVerify(ctx, OTHER_EMAIL);
      const grace = await UserModel.findOne({ email: OTHER_EMAIL });

      const response = await createOrganization(ctx, ada.accessToken, {
        name: "Acme",
        ownerUserId: grace!._id.toString(),
        userId: grace!._id.toString(),
      });

      const membership = await MembershipModel.findOne({ organizationId: response.body.data.organization.id });
      expect(membership!.userId.toString()).toBe(ada.userId);
      expect(membership!.userId.toString()).not.toBe(grace!._id.toString());
    });

    it("ignores a client-chosen slug", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme", slug: "admin" });

      expect(response.body.data.organization.slug).toBe("acme");
    });

    it("ignores a client-chosen status and role", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, {
        name: "Acme",
        status: "suspended",
        role: "agent",
      });

      expect(response.body.data.organization.status).toBe("active");
      expect(response.body.data.role).toBe("owner");
      const membership = await MembershipModel.findOne({});
      expect(membership!.role).toBe("owner");
    });
  });

  // ---- slug policy (ADR-016 §6-7) ----

  describe("slugs", () => {
    it("suffixes the slug of a duplicate name", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const first = await createOrganization(ctx, staff.accessToken, { name: "Acme" });
      const second = await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      expect(first.body.data.organization.slug).toBe("acme");
      expect(second.body.data.organization.slug).toBe("acme-2");
      expect(second.status).toBe(201);
    });

    it("accepts a name whose slug is reserved, and routes around it", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Admin" });

      expect(response.status).toBe(201);
      expect(response.body.data.organization.name).toBe("Admin");
      expect(response.body.data.organization.slug).toBe("admin-2");
    });

    it("derives a usable slug from a non-Latin name", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "日本語" });

      expect(response.status).toBe(201);
      expect(response.body.data.organization.name).toBe("日本語");
      expect(response.body.data.organization.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("keeps slugs unique across every organization", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      for (const name of ["Acme", "Acme", "acme", "ACME", "Acme!"]) {
        await createOrganization(ctx, staff.accessToken, { name });
      }

      const slugs = (await OrganizationModel.find({}).select("slug")).map((o) => o.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });
  });

  // ---- what must never appear in the response ----

  describe("the response body", () => {
    it("exposes no credential or internal persistence field", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      for (const field of ["_id", "__v", "passwordHash", "updatedAt"]) {
        expect(response.body.data.organization).not.toHaveProperty(field);
      }
      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("$argon2");
      expect(response.text).not.toContain(staff.accessToken);
    });

    it("returns no membership document, only the role", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      expect(response.body.data).not.toHaveProperty("membership");
      expect(response.body.data).not.toHaveProperty("membershipId");
      expect(response.body.data).not.toHaveProperty("userId");
    });

    it("issues no token and sets no cookie", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await createOrganization(ctx, staff.accessToken, { name: "Acme" });

      expect(response.body.data).not.toHaveProperty("accessToken");
      expect(response.headers["set-cookie"]).toBeUndefined();
    });
  });

  // ---- method and shape of the route ----

  it("is not reachable by GET", async () => {
    const ctx = buildApp();
    const staff = await signedInStaff(ctx);

    const response = await request(ctx.app)
      .get(ORGANIZATIONS_PATH)
      .set("Authorization", `Bearer ${staff.accessToken}`);

    expect(response.status).toBe(404);
  });

  // ---- regression: the auth surface is unchanged ----

  describe("existing authentication behaviour", () => {
    it("leaves GET /me answering as before", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      await createOrganization(ctx, staff.accessToken, { name: "Acme" });
      const me = await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${staff.accessToken}`);

      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe(EMAIL);
      // Slice 17 does not add organization or role to /me — that is Slice 18.
      expect(me.body.data.user).not.toHaveProperty("organizationId");
      expect(me.body.data.user).not.toHaveProperty("role");
    });

    it("leaves the access token usable for both routes", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const org = await createOrganization(ctx, staff.accessToken, { name: "Acme" });
      const me = await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${staff.accessToken}`);

      expect(org.status).toBe(201);
      expect(me.status).toBe(200);
    });
  });
});
