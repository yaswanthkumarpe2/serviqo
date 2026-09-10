import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { isWellFormedWidgetKey } from "../src/modules/organizations/widgetConfig";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

import type { MembershipRole, MembershipStatus } from "../src/modules/memberships/membership.model";

/**
 * Widget installation (ADR-020) — the staff surface ADR-019 §14 deferred.
 *
 * End to end: a staff member reads their organization's widget key and
 * allowed origins, configures which websites may embed it, and rotates the
 * key if it leaks — and every one of those actions is proved against the
 * same tenant-isolation and RBAC machinery `organizations.context.test.ts`
 * already exercises, rather than a parallel implementation of it.
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const WIDGET_SESSION_PATH = "/api/v1/widget/session";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";
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

/** Puts an existing user into an existing organization with a chosen standing. */
async function addMember(
  userId: string,
  organizationId: string,
  role: MembershipRole,
  status: MembershipStatus = "active",
) {
  return MembershipModel.create({ userId, organizationId, role, status });
}

const widgetConfigPath = (organizationId: string) => `${ORGANIZATIONS_PATH}/${organizationId}/widget-config`;

const getWidgetConfig = (ctx: Ctx, accessToken: string, organizationId: string) =>
  request(ctx.app).get(widgetConfigPath(organizationId)).set("Authorization", `Bearer ${accessToken}`);

const putOrigins = (ctx: Ctx, accessToken: string, organizationId: string, allowedOrigins: string[]) =>
  request(ctx.app)
    .put(`${widgetConfigPath(organizationId)}/origins`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ allowedOrigins });

const rotateKey = (ctx: Ctx, accessToken: string, organizationId: string) =>
  request(ctx.app)
    .post(`${widgetConfigPath(organizationId)}/rotate-key`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send();

const openWidgetSession = (ctx: Ctx, widgetKey: string) =>
  request(ctx.app).post(WIDGET_SESSION_PATH).send({ widgetKey });

describe("widget installation configuration", () => {
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
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
      SessionModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      CustomerModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- GET /widget-config ----

  describe("GET .../widget-config", () => {
    it("returns a well-formed widget key and an empty origin list for a new organization", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await getWidgetConfig(ctx, staff.accessToken, organization.id);

      expect(response.status).toBe(200);
      expect(isWellFormedWidgetKey(response.body.data.widgetKey)).toBe(true);
      expect(response.body.data.allowedOrigins).toEqual([]);
    });

    it("answers in the approved envelope and exposes only the two owned fields", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await getWidgetConfig(ctx, staff.accessToken, organization.id);

      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(Object.keys(response.body.data).sort()).toEqual(["allowedOrigins", "widgetKey"]);
    });

    it("mints a key for an organization written before widget keys existed", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Legacy Co");
      await OrganizationModel.updateOne({ _id: organization.id }, { $unset: { widgetKey: "" } });
      expect((await OrganizationModel.findById(organization.id))!.widgetKey).toBeNull();

      const response = await getWidgetConfig(ctx, staff.accessToken, organization.id);

      expect(response.status).toBe(200);
      expect(isWellFormedWidgetKey(response.body.data.widgetKey)).toBe(true);

      const persisted = await OrganizationModel.findById(organization.id);
      expect(persisted!.widgetKey).toBe(response.body.data.widgetKey);
    });

    it("returns the same key on a second read rather than minting again", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const first = await getWidgetConfig(ctx, staff.accessToken, organization.id);
      const second = await getWidgetConfig(ctx, staff.accessToken, organization.id);

      expect(second.body.data.widgetKey).toBe(first.body.data.widgetKey);
    });

    // Every staff role holds organization.read, but not organization.manage.
    it.each<[MembershipRole]>([["owner"], ["admin"]])("grants a %s access to widget configuration", async (role) => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, EMAIL);
      const member = await signedInStaff(ctx, OTHER_EMAIL);
      const organization = await createOrganization(ctx, owner.accessToken, "Shared");
      if (role !== "owner") await addMember(member.userId, organization.id, role);

      const token = role === "owner" ? owner.accessToken : member.accessToken;
      const response = await getWidgetConfig(ctx, token, organization.id);

      expect(response.status).toBe(200);
    });

    describe("refusals", () => {
      it("refuses an unauthenticated request", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await request(ctx.app).get(widgetConfigPath(organization.id));

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
      });

      // The missing-permission case: membership is real, role is not enough.
      it.each<[MembershipRole]>([["supervisor"], ["agent"]])(
        "refuses a %s with 403, distinctly from a non-member",
        async (role) => {
          const ctx = buildApp();
          const owner = await signedInStaff(ctx, EMAIL);
          const member = await signedInStaff(ctx, OTHER_EMAIL);
          const organization = await createOrganization(ctx, owner.accessToken, "Shared");
          await addMember(member.userId, organization.id, role);

          const response = await getWidgetConfig(ctx, member.accessToken, organization.id);

          expect(response.status).toBe(403);
          expect(response.body.error.code).toBe("INSUFFICIENT_PERMISSION");
        },
      );

      it("leaks no widget key to a role that lacks the permission", async () => {
        const ctx = buildApp();
        const owner = await signedInStaff(ctx, EMAIL);
        const agent = await signedInStaff(ctx, OTHER_EMAIL);
        const organization = await createOrganization(ctx, owner.accessToken, "Shared");
        await addMember(agent.userId, organization.id, "agent");
        const ownerRead = await getWidgetConfig(ctx, owner.accessToken, organization.id);

        const response = await getWidgetConfig(ctx, agent.accessToken, organization.id);

        expect(response.text).not.toContain(ownerRead.body.data.widgetKey);
      });

      it("answers 404 for a suspended organization, indistinguishable from a non-member", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");
        await OrganizationModel.updateOne({ _id: organization.id }, { $set: { status: "suspended" } });

        const response = await getWidgetConfig(ctx, staff.accessToken, organization.id);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("NOT_FOUND");
      });

      // Cross-tenant access, end to end: a member of one org reading another's config.
      it("answers 404 to a member of a different organization", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");
        await createOrganization(ctx, ada.accessToken, "Ada Org");

        const response = await getWidgetConfig(ctx, ada.accessToken, graceOrg.id);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("NOT_FOUND");
      });

      it("leaks no widget key across tenants", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");
        const graceRead = await getWidgetConfig(ctx, grace.accessToken, graceOrg.id);

        const response = await getWidgetConfig(ctx, ada.accessToken, graceOrg.id);

        expect(response.status).toBe(404);
        expect(response.text).not.toContain(graceRead.body.data.widgetKey);
      });

      it("answers 404 for an organization that does not exist", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);

        const response = await getWidgetConfig(ctx, staff.accessToken, UNKNOWN_ORGANIZATION_ID);

        expect(response.status).toBe(404);
      });
    });
  });

  // ---- PUT .../widget-config/origins ----

  describe("PUT .../widget-config/origins", () => {
    it("adds origins to a previously empty list", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await putOrigins(ctx, staff.accessToken, organization.id, [
        "https://shop.example.com",
        "http://localhost:5173",
      ]);

      expect(response.status).toBe(200);
      expect(response.body.data.allowedOrigins).toEqual(["https://shop.example.com", "http://localhost:5173"]);
    });

    it("persists the update", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await putOrigins(ctx, staff.accessToken, organization.id, ["https://shop.example.com"]);

      const persisted = await OrganizationModel.findById(organization.id);

      expect(persisted!.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("replaces the list wholesale — removing an entry means leaving it out", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await putOrigins(ctx, staff.accessToken, organization.id, [
        "https://shop.example.com",
        "https://admin.example.com",
      ]);

      const response = await putOrigins(ctx, staff.accessToken, organization.id, ["https://shop.example.com"]);

      expect(response.body.data.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("updates an existing origin by replacing it in the sent list", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await putOrigins(ctx, staff.accessToken, organization.id, ["https://old.example.com"]);

      const response = await putOrigins(ctx, staff.accessToken, organization.id, ["https://new.example.com"]);

      expect(response.body.data.allowedOrigins).toEqual(["https://new.example.com"]);
    });

    it("accepts an empty list, which means the widget is embeddable nowhere", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await putOrigins(ctx, staff.accessToken, organization.id, ["https://shop.example.com"]);

      const response = await putOrigins(ctx, staff.accessToken, organization.id, []);

      expect(response.status).toBe(200);
      expect(response.body.data.allowedOrigins).toEqual([]);
    });

    it("canonicalizes on write, so two spellings of one origin cannot both be stored", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await putOrigins(ctx, staff.accessToken, organization.id, [
        "HTTPS://Shop.Example.COM:443/",
      ]);

      expect(response.body.data.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("mints a widget key if this organization had none yet", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await OrganizationModel.updateOne({ _id: organization.id }, { $unset: { widgetKey: "" } });

      const response = await putOrigins(ctx, staff.accessToken, organization.id, ["https://shop.example.com"]);

      expect(isWellFormedWidgetKey(response.body.data.widgetKey)).toBe(true);
    });

    describe("validation", () => {
      it.each([
        ["a wildcard", ["*"]],
        ["a subdomain wildcard", ["https://*.example.com"]],
        ["a scheme-wide wildcard", ["https://*"]],
      ])("rejects %s", async (_label, allowedOrigins) => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await putOrigins(ctx, staff.accessToken, organization.id, allowedOrigins);

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
      });

      it.each([
        ["a path", ["https://shop.example.com/embed"]],
        ["a query string", ["https://shop.example.com?tenant=acme"]],
        ["a fragment", ["https://shop.example.com#chat"]],
        ["userinfo", ["https://user:pass@shop.example.com"]],
        ["a non-http scheme", ["ftp://files.example.com"]],
        ["a bare hostname", ["shop.example.com"]],
        ["nonsense", ["not an origin"]],
      ])("rejects %s as malformed", async (_label, allowedOrigins) => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await putOrigins(ctx, staff.accessToken, organization.id, allowedOrigins);

        expect(response.status).toBe(400);
        expect(response.body.error.details?.[0]?.field).toBe("allowedOrigins.0");
      });

      it("rejects duplicate origins rather than silently deduplicating", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await putOrigins(ctx, staff.accessToken, organization.id, [
          "https://shop.example.com",
          "https://shop.example.com",
        ]);

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
      });

      it("rejects duplicates that differ only by canonicalization", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await putOrigins(ctx, staff.accessToken, organization.id, [
          "https://shop.example.com",
          "HTTPS://Shop.Example.COM:443/",
        ]);

        expect(response.status).toBe(400);
      });

      it("rejects a non-array body", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const response = await request(ctx.app)
          .put(`${widgetConfigPath(organization.id)}/origins`)
          .set("Authorization", `Bearer ${staff.accessToken}`)
          .send({ allowedOrigins: "https://shop.example.com" });

        expect(response.status).toBe(400);
      });

      it("does not persist a rejected list", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");
        await putOrigins(ctx, staff.accessToken, organization.id, ["https://good.example.com"]);

        await putOrigins(ctx, staff.accessToken, organization.id, ["https://*.bad.example.com"]);

        const persisted = await OrganizationModel.findById(organization.id);
        expect(persisted!.allowedOrigins).toEqual(["https://good.example.com"]);
      });
    });

    describe("refusals", () => {
      it("refuses a member who lacks organization.manage", async () => {
        const ctx = buildApp();
        const owner = await signedInStaff(ctx, EMAIL);
        const agent = await signedInStaff(ctx, OTHER_EMAIL);
        const organization = await createOrganization(ctx, owner.accessToken, "Shared");
        await addMember(agent.userId, organization.id, "agent");

        const response = await putOrigins(ctx, agent.accessToken, organization.id, ["https://shop.example.com"]);

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("INSUFFICIENT_PERMISSION");
      });

      it("cannot be pointed at another tenant by a client-supplied organizationId", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        const adaOrg = await createOrganization(ctx, ada.accessToken, "Ada Org");
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");

        const response = await request(ctx.app)
          .put(`${widgetConfigPath(adaOrg.id)}/origins`)
          .set("Authorization", `Bearer ${ada.accessToken}`)
          .send({ allowedOrigins: ["https://shop.example.com"], organizationId: graceOrg.id });

        expect(response.status).toBe(200);
        const graceAfter = await OrganizationModel.findById(graceOrg.id);
        expect(graceAfter!.allowedOrigins).toEqual([]);
      });
    });
  });

  // ---- POST .../widget-config/rotate-key ----

  describe("POST .../widget-config/rotate-key", () => {
    it("returns a new, well-formed widget key", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const before = await getWidgetConfig(ctx, staff.accessToken, organization.id);

      const response = await rotateKey(ctx, staff.accessToken, organization.id);

      expect(response.status).toBe(200);
      expect(isWellFormedWidgetKey(response.body.data.widgetKey)).toBe(true);
      expect(response.body.data.widgetKey).not.toBe(before.body.data.widgetKey);
    });

    it("persists the new key", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");

      const response = await rotateKey(ctx, staff.accessToken, organization.id);

      const persisted = await OrganizationModel.findById(organization.id);
      expect(persisted!.widgetKey).toBe(response.body.data.widgetKey);
    });

    it("leaves allowed origins untouched", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      await putOrigins(ctx, staff.accessToken, organization.id, ["https://shop.example.com"]);

      const response = await rotateKey(ctx, staff.accessToken, organization.id);

      expect(response.body.data.allowedOrigins).toEqual(["https://shop.example.com"]);
    });

    it("never echoes the old key in the response", async () => {
      const ctx = buildApp();
      const staff = await signedInStaff(ctx);
      const organization = await createOrganization(ctx, staff.accessToken, "Acme");
      const before = await getWidgetConfig(ctx, staff.accessToken, organization.id);

      const response = await rotateKey(ctx, staff.accessToken, organization.id);

      expect(response.text).not.toContain(before.body.data.widgetKey);
    });

    it("refuses a member who lacks organization.manage", async () => {
      const ctx = buildApp();
      const owner = await signedInStaff(ctx, EMAIL);
      const supervisor = await signedInStaff(ctx, OTHER_EMAIL);
      const organization = await createOrganization(ctx, owner.accessToken, "Shared");
      await addMember(supervisor.userId, organization.id, "supervisor");

      const response = await rotateKey(ctx, supervisor.accessToken, organization.id);

      expect(response.status).toBe(403);
    });

    /*
      The property this whole endpoint exists for: the old key stops working
      immediately, because it is no longer the value `findByWidgetKey` can
      find — not because of a revocation check (ADR-020 §5).
    */
    describe("effect on widget sessions", () => {
      it("rejects the old key immediately after rotation", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");
        const before = await getWidgetConfig(ctx, staff.accessToken, organization.id);
        const oldKey = before.body.data.widgetKey as string;

        // The old key works before rotation.
        expect((await openWidgetSession(ctx, oldKey)).status).toBe(201);

        await rotateKey(ctx, staff.accessToken, organization.id);

        const afterRotation = await openWidgetSession(ctx, oldKey);
        expect(afterRotation.status).toBe(403);
        expect(afterRotation.body.error.code).toBe("WIDGET_SESSION_REFUSED");
      });

      it("accepts the new key for a widget session immediately", async () => {
        const ctx = buildApp();
        const staff = await signedInStaff(ctx);
        const organization = await createOrganization(ctx, staff.accessToken, "Acme");

        const rotated = await rotateKey(ctx, staff.accessToken, organization.id);
        const response = await openWidgetSession(ctx, rotated.body.data.widgetKey);

        expect(response.status).toBe(201);
        expect(response.body.data.customer.id).toBeDefined();
      });

      it("does not affect another organization's widget key or sessions", async () => {
        const ctx = buildApp();
        const ada = await signedInStaff(ctx, EMAIL);
        const grace = await signedInStaff(ctx, OTHER_EMAIL);
        const adaOrg = await createOrganization(ctx, ada.accessToken, "Ada Org");
        const graceOrg = await createOrganization(ctx, grace.accessToken, "Grace Org");
        const graceBefore = await getWidgetConfig(ctx, grace.accessToken, graceOrg.id);

        await rotateKey(ctx, ada.accessToken, adaOrg.id);

        const graceAfter = await getWidgetConfig(ctx, grace.accessToken, graceOrg.id);
        expect(graceAfter.body.data.widgetKey).toBe(graceBefore.body.data.widgetKey);
        expect((await openWidgetSession(ctx, graceBefore.body.data.widgetKey)).status).toBe(201);
      });
    });
  });

  // ---- secret and credential hygiene ----

  it("leaks no credential material on any widget-config route", async () => {
    const ctx = buildApp();
    const staff = await signedInStaff(ctx);
    const organization = await createOrganization(ctx, staff.accessToken, "Acme");

    const read = await getWidgetConfig(ctx, staff.accessToken, organization.id);
    const putResponse = await putOrigins(ctx, staff.accessToken, organization.id, ["https://shop.example.com"]);
    const rotated = await rotateKey(ctx, staff.accessToken, organization.id);

    for (const response of [read, putResponse, rotated]) {
      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("$argon2");
      expect(response.text).not.toContain(staff.accessToken);
      expect(response.text).not.toMatch(/passwordHash|currentRefreshTokenHash|JWT_WIDGET_SECRET|JWT_ACCESS_SECRET/i);
    }
  });
});
