import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";
import type { OrganizationStatus } from "../src/modules/organizations/organization.model";

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ME_PATH = "/api/v1/auth/me";
const ORGANIZATIONS_PATH = "/api/v1/organizations";

/** Obvious sentinels — if either reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";
/** Well-formed and belonging to nothing. */
const UNKNOWN_ORGANIZATION_ID = "507f1f77bcf86cd799439099";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

type Ctx = ReturnType<typeof buildApp>;

async function signedInStaff(ctx: Ctx, email = EMAIL) {
  await request(ctx.app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });

  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return {
    accessToken: login.body.data.accessToken as string,
    userId: login.body.data.user.id as string,
  };
}

/** Creates an organization through the real endpoint, so the owner membership is real. */
async function createOrganization(ctx: Ctx, accessToken: string, name: string) {
  const response = await request(ctx.app)
    .post(ORGANIZATIONS_PATH)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ name });
  return response.body.data.organization as { id: string; name: string; slug: string };
}

const readOrganization = (ctx: Ctx, accessToken: string, organizationId: string) =>
  request(ctx.app).get(`${ORGANIZATIONS_PATH}/${organizationId}`).set("Authorization", `Bearer ${accessToken}`);

const getMe = (ctx: Ctx, accessToken: string) =>
  request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`);

/** Puts an existing user into an existing organization with a chosen standing. */
async function addMember(
  userId: string,
  organizationId: string,
  role: MembershipRole,
  status: MembershipStatus = "active",
) {
  return MembershipModel.create({ userId, organizationId, role, status });
}

describe("organization context and RBAC", () => {
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

  // ---- GET /me memberships (ADR-017 §9) ----

  describe("GET /me memberships", () => {
    it("returns an empty list for a user who has onboarded nothing", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await getMe(ctx, staff.accessToken);

      expect(response.status).toBe(200);
      expect(response.body.data.memberships).toEqual([]);
    });

    it("keeps the user fields unchanged", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await getMe(ctx, staff.accessToken);

      expect(Object.keys(response.body.data.user).sort()).toEqual([
        "createdAt",
        "email",
        "emailVerifiedAt",
        "id",
        // Which product this account signed up for (ADR-034 §1). The eighth
        // field, and the one that decides whether a customer's chat or an
        // agent's inbox is rendered.
        "kind",
        "name",
        // Added by ADR-032 §6 so a client knows whether to offer the
        // operations console for the account that just signed in.
        "platformRole",
        "status",
      ]);
      expect(Object.keys(response.body.data).sort()).toEqual(["memberships", "user"]);
    });

    it("returns the organization a user just created, as its owner", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme Corp");

      const response = await getMe(ctx, staff.accessToken);

      expect(response.body.data.memberships).toHaveLength(1);
      expect(response.body.data.memberships[0]).toMatchObject({
        role: "owner",
        organization: { id: organization.id, name: "Acme Corp", slug: "acme-corp", status: "active" },
      });
    });

    it("returns every organization a user belongs to", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      await createOrganization(ctx, staff.accessToken, "Alpha");
      await createOrganization(ctx, staff.accessToken, "Beta");
      await createOrganization(ctx, staff.accessToken, "Gamma");

      const response = await getMe(ctx, staff.accessToken);

      expect(response.body.data.memberships.map((m: { organization: { name: string } }) => m.organization.name)).toEqual(
        ["Alpha", "Beta", "Gamma"],
      );
    });

    it("returns only the caller's own memberships", async () => {
      const ctx = buildApp();
      const ada = await signedInStaff(ctx, EMAIL);
      const grace = await signedInStaff(ctx, OTHER_EMAIL);
      await createOrganization(ctx, ada.accessToken, "Ada Org");
      await createOrganization(ctx, grace.accessToken, "Grace Org");

      const adaMe = await getMe(ctx, ada.accessToken);
      const graceMe = await getMe(ctx, grace.accessToken);

      expect(adaMe.body.data.memberships.map((m: { organization: { slug: string } }) => m.organization.slug)).toEqual([
        "ada-org",
      ]);
      expect(graceMe.body.data.memberships.map((m: { organization: { slug: string } }) => m.organization.slug)).toEqual(
        ["grace-org"],
      );
    });

    it("exposes only the approved organization fields", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await getMe(ctx, staff.accessToken);
      const entry = response.body.data.memberships[0];

      expect(Object.keys(entry).sort()).toEqual(["membershipId", "organization", "role"]);
      expect(Object.keys(entry.organization).sort()).toEqual(["id", "name", "slug", "status"]);
    });

    it("carries no permission list and no current-organization pointer", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await getMe(ctx, staff.accessToken);

      expect(response.text).not.toContain("organization.read");
      expect(response.body.data).not.toHaveProperty("currentOrganizationId");
      expect(response.body.data).not.toHaveProperty("activeOrganizationId");
      expect(response.body.data.memberships[0]).not.toHaveProperty("permissions");
    });

    it("omits an organization the caller cannot enter", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const reachable = await createOrganization(ctx, staff.accessToken, "Reachable");
      const suspended = await createOrganization(ctx, staff.accessToken, "Suspended");
      await OrganizationModel.updateOne({ _id: suspended.id }, { $set: { status: "suspended" } });

      const response = await getMe(ctx, staff.accessToken);

      expect(response.body.data.memberships).toHaveLength(1);
      expect(response.body.data.memberships[0].organization.id).toBe(reachable.id);
    });

    it("omits an organization the caller has only been invited to", async () => {
      const ctx = buildApp();
      const ada = await signedInStaff(ctx, EMAIL);
      const grace = await signedInStaff(ctx, OTHER_EMAIL);
      const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");
      await addMember(ada.userId, graceOrg.id, "agent", "invited");

      const response = await getMe(ctx, ada.accessToken);

      expect(response.body.data.memberships).toEqual([]);
    });
  });

  // ---- GET /organizations/:id — requireOrganization + requirePermission ----

  describe("GET /organizations/:organizationId", () => {
    it("returns the organization and the caller's role", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme Corp");

      const response = await readOrganization(ctx, staff.accessToken, organization.id);

      expect(response.status).toBe(200);
      expect(response.body.data.organization).toMatchObject({
        id: organization.id,
        name: "Acme Corp",
        slug: "acme-corp",
        status: "active",
      });
      expect(response.body.data.role).toBe("owner");
    });

    it("answers in the approved envelope", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await readOrganization(ctx, staff.accessToken, organization.id);

      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(Object.keys(response.body).sort()).toEqual(["data", "meta", "success"]);
    });

    // Every staff role holds organization.read (ADR-017 §7).
    it.each<[MembershipRole]>([["owner"], ["admin"], ["supervisor"], ["agent"]])(
      "grants a %s access to the organization they belong to",
      async (role) => {
        const ctx = buildApp();
        const owner = await signedInStaff(ctx, EMAIL);
        const member = await signedInStaff(ctx, OTHER_EMAIL);
        const organization = await createOrganization(ctx, owner.accessToken, "Shared");
        if (role !== "owner") await addMember(member.userId, organization.id, role);

        const token = role === "owner" ? owner.accessToken : member.accessToken;
        const response = await readOrganization(ctx, token, organization.id);

        expect(response.status).toBe(200);
        expect(response.body.data.role).toBe(role);
      },
    );

    describe("refusals", () => {
      it("refuses an unauthenticated request", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await request(ctx.app).get(`${ORGANIZATIONS_PATH}/${organization.id}`);

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
      });

      it("refuses a tampered access token", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await readOrganization(ctx, `${staff.accessToken.slice(0, -4)}AAAA`, organization.id);

        expect(response.status).toBe(401);
      });

      /*
        The isolation property, end to end. 404 rather than 403 so the
        response does not confirm the organization exists (ADR-017 §6).
      */
      it("answers 404 to a member of a different organization", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        await createOrganization(ctx, ada.accessToken, "Ada Org");
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");

        const response = await readOrganization(ctx, ada.accessToken, graceOrg.id);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("NOT_FOUND");
      });

      it("leaks nothing about the organization it refused", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Confidential");

        const response = await readOrganization(ctx, ada.accessToken, graceOrg.id);

        expect(response.text).not.toContain("Grace Confidential");
        expect(response.text).not.toContain(graceOrg.slug);
      });

      it.each<[MembershipStatus]>([["invited"], ["suspended"]])(
        "answers 404 for a %s membership",
        async (status) => {
          const ctx = buildApp();
          const ada = await signedInStaff(ctx, EMAIL);
          const grace = await signedInStaff(ctx, OTHER_EMAIL);
          const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");
          await addMember(ada.userId, graceOrg.id, "agent", status);

          const response = await readOrganization(ctx, ada.accessToken, graceOrg.id);

          expect(response.status).toBe(404);
        },
      );

      it.each<[OrganizationStatus]>([["suspended"]])("answers 404 for a %s organization", async (orgStatus) => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");
        await OrganizationModel.updateOne({ _id: organization.id }, { $set: { status: orgStatus } });

        const response = await readOrganization(ctx, staff.accessToken, organization.id);

        expect(response.status).toBe(404);
      });

      it("answers 404 for an organization that does not exist", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);

        const response = await readOrganization(ctx, staff.accessToken, UNKNOWN_ORGANIZATION_ID);

        expect(response.status).toBe(404);
      });

      // A CastError would report a mistyped URL as a server fault.
      it("answers 404 for a malformed organization id, not 500", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);

        const response = await readOrganization(ctx, staff.accessToken, "not-an-object-id");

        expect(response.status).toBe(404);
      });

      it("makes every refusal indistinguishable", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");
        const suspended = await createOrganization(ctx, ada.accessToken, "Suspended");
        await OrganizationModel.updateOne({ _id: suspended.id }, { $set: { status: "suspended" } });

        const bodies: string[] = [];
        for (const id of [graceOrg.id, suspended.id, UNKNOWN_ORGANIZATION_ID, "not-an-object-id"]) {
          const response = await readOrganization(ctx, ada.accessToken, id);
          bodies.push(JSON.stringify({ code: response.body.error.code, message: response.body.error.message }));
        }

        expect(new Set(bodies).size).toBe(1);
      });
    });
  });

  // ---- identity is never taken from the client (ADR-017 §5) ----

  describe("client-supplied authorization data", () => {
    it("ignores a role supplied in the query string", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, EMAIL);
      const agent = await signedInStaff(ctx, OTHER_EMAIL);
      const organization = await createOrganization(ctx, owner.accessToken, "Acme");
      await addMember(agent.userId, organization.id, "agent");

      const response = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${organization.id}?role=owner&permission=member.manage`)
        .set("Authorization", `Bearer ${agent.accessToken}`);

      expect(response.status).toBe(200);
      // The database's answer, not the query string's.
      expect(response.body.data.role).toBe("agent");
    });

    it("ignores a role and organizationId supplied in the body", async () => {
      const ctx = buildApp();
      const ada = await signedInStaff(ctx, EMAIL);
      const grace = await signedInStaff(ctx, OTHER_EMAIL);
      const adaOrg = await createOrganization(ctx, ada.accessToken, "Ada Org");
      const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");

      const response = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${adaOrg.id}`)
        .set("Authorization", `Bearer ${ada.accessToken}`)
        .send({ role: "owner", organizationId: graceOrg.id, membershipId: "forged" });

      expect(response.status).toBe(200);
      expect(response.body.data.organization.id).toBe(adaOrg.id);
      expect(response.body.data.organization.id).not.toBe(graceOrg.id);
    });

    it("cannot be pointed at another tenant by any client-supplied field", async () => {
      const ctx = buildApp();
      const ada = await signedInStaff(ctx, EMAIL);
      const grace = await signedInStaff(ctx, OTHER_EMAIL);
      const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");

      const response = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${UNKNOWN_ORGANIZATION_ID}?organizationId=${graceOrg.id}`)
        .set("Authorization", `Bearer ${ada.accessToken}`)
        .send({ organizationId: graceOrg.id });

      expect(response.status).toBe(404);
    });
  });

  // ---- regression: the auth surface is unchanged ----

  describe("existing behaviour", () => {
    it("leaves organization creation working", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);

      const response = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${staff.accessToken}`)
        .send({ name: "Acme" });

      expect(response.status).toBe(201);
      expect(response.body.data.role).toBe("owner");
    });

    it("leaves login, refresh, logout and logout-all working", async () => {
      const ctx = buildApp();
      await signedInStaff(ctx);

      const login = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

      const refreshed = await request(ctx.app).post("/api/v1/auth/refresh").set("Cookie", cookie);
      const rotated = (refreshed.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
      const me = await getMe(ctx, refreshed.body.data.accessToken as string);
      const loggedOut = await request(ctx.app).post("/api/v1/auth/logout").set("Cookie", rotated);
      const afterLogout = await request(ctx.app).post("/api/v1/auth/refresh").set("Cookie", rotated);

      expect(login.status).toBe(200);
      expect(refreshed.status).toBe(200);
      expect(me.status).toBe(200);
      expect(loggedOut.status).toBe(200);
      expect(afterLogout.status).toBe(401);
    });

    it("leaves a refreshed token usable for organization context", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const login = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
      const refreshed = await request(ctx.app).post("/api/v1/auth/refresh").set("Cookie", cookie);

      const response = await readOrganization(ctx, refreshed.body.data.accessToken as string, organization.id);

      expect(response.status).toBe(200);
    });
  });

  // ---- nothing sensitive in a response ----

  it("leaks no credential material on any organization route", async () => {
    const ctx = buildApp();
    const staff = await signedInStaff(ctx);
    const organization = await createOrganization(ctx, staff.accessToken, "Acme");

    const read = await readOrganization(ctx, staff.accessToken, organization.id);
    const me = await getMe(ctx, staff.accessToken);

    for (const response of [read, me]) {
      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("$argon2");
      expect(response.text).not.toContain(staff.accessToken);
      expect(response.text).not.toMatch(/passwordHash|currentRefreshTokenHash/i);
    }
  });
});
