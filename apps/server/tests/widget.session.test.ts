import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { WIDGET_SESSION_LIMIT, WIDGET_TOKEN_TTL_MS } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { verifyWidgetToken } from "../src/modules/widget/widgetToken";

import type {
  OrganizationDocument,
  OrganizationStatus,
} from "../src/modules/organizations/organization.model";

const SESSION_PATH = "/api/v1/widget/session";

const ALLOWED_ORIGIN = "https://shop.example.com";
const DISALLOWED_ORIGIN = "https://evil.example.net";

/**
 * `POST /api/v1/widget/session` (ADR-019).
 *
 * The complete public flow, end to end:
 *
 *   widget key -> organization -> active? -> origin allowed?
 *              -> resume or create Customer -> issue token -> minimal response
 */
describe("widget session", () => {
  let mongoServer: MongoMemoryServer;
  const app = createApp();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await OrganizationModel.init();
    await CustomerModel.init();
    await UserModel.init();
    await MembershipModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      OrganizationModel.deleteMany({}),
      CustomerModel.deleteMany({}),
      UserModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      SessionModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  let slugCounter = 0;
  async function createOrganization({
    status = "active",
    allowedOrigins = [],
  }: { status?: OrganizationStatus; allowedOrigins?: string[] } = {}): Promise<OrganizationDocument> {
    slugCounter += 1;
    return OrganizationModel.create({
      name: `Org ${slugCounter}`,
      slug: `org-${slugCounter}`,
      status,
      allowedOrigins,
    });
  }

  const openSession = (body: Record<string, unknown>, origin?: string) => {
    const call = request(app).post(SESSION_PATH);
    if (origin !== undefined) call.set("Origin", origin);
    return call.send(body);
  };

  // ---- the happy path ----

  describe("with a valid widget key", () => {
    it("opens a session for an anonymous visitor", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.token).toEqual(expect.any(String));
      expect(response.body.data.customer.id).toEqual(expect.any(String));
      expect(response.body.data.customer.name).toBeNull();
      expect(response.body.data.customer.email).toBeNull();
    });

    it("creates the customer inside the organization the key resolved", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      const customer = await CustomerModel.findById(response.body.data.customer.id);
      expect(customer!.organizationId.toString()).toBe(organization._id.toString());
    });

    it("issues a token this server's widget verifier accepts", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      await expect(verifyWidgetToken(response.body.data.token)).resolves.toEqual({
        customerId: response.body.data.customer.id,
        organizationId: organization._id.toString(),
      });
    });

    it("reports the token lifetime so a client need not parse it", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.body.data.expiresInSeconds).toBe(Math.floor(WIDGET_TOKEN_TTL_MS / 1000));
    });

    it("stores the details a visitor supplied", async () => {
      const organization = await createOrganization();

      const response = await openSession({
        widgetKey: organization.widgetKey,
        name: "Ada Lovelace",
        email: "Ada@Example.COM",
      });

      expect(response.status).toBe(201);
      expect(response.body.data.customer.name).toBe("Ada Lovelace");
      // Normalized the same way user.model.ts normalizes an address.
      expect(response.body.data.customer.email).toBe("ada@example.com");
    });

    it("serves two anonymous visitors as two distinct customers", async () => {
      const organization = await createOrganization();

      const first = await openSession({ widgetKey: organization.widgetKey });
      const second = await openSession({ widgetKey: organization.widgetKey });

      expect(first.body.data.customer.id).not.toBe(second.body.data.customer.id);
      expect(await CustomerModel.countDocuments({})).toBe(2);
    });
  });

  // ---- resuming, which is what the token is for (ADR-019 §6) ----

  describe("repeated sessions", () => {
    it("resumes the same customer when the previous token is presented", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });

      const second = await openSession({
        widgetKey: organization.widgetKey,
        visitorToken: first.body.data.token,
      });

      expect(second.status).toBe(201);
      expect(second.body.data.customer.id).toBe(first.body.data.customer.id);
      expect(await CustomerModel.countDocuments({})).toBe(1);
    });

    it("issues a fresh token on each resume", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });

      const second = await openSession({
        widgetKey: organization.widgetKey,
        visitorToken: first.body.data.token,
      });

      expect(second.body.data.token).toEqual(expect.any(String));
      await expect(verifyWidgetToken(second.body.data.token)).resolves.not.toBeNull();
    });

    it("records the visit", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });
      const before = (await CustomerModel.findById(first.body.data.customer.id))!.lastSeenAt.getTime();

      await new Promise((resolve) => setTimeout(resolve, 10));
      await openSession({ widgetKey: organization.widgetKey, visitorToken: first.body.data.token });

      const after = (await CustomerModel.findById(first.body.data.customer.id))!.lastSeenAt.getTime();
      expect(after).toBeGreaterThan(before);
    });

    // Anonymous-first, upgradeable (ADR-010 §4).
    it("upgrades an anonymous customer when details arrive later", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey });

      const second = await openSession({
        widgetKey: organization.widgetKey,
        visitorToken: first.body.data.token,
        name: "Ada Lovelace",
        email: "ada@example.com",
      });

      expect(second.body.data.customer.id).toBe(first.body.data.customer.id);
      expect(second.body.data.customer.name).toBe("Ada Lovelace");
      expect(second.body.data.customer.email).toBe("ada@example.com");
    });

    // A widget that forgot a field must not erase what the visitor typed.
    it("does not clear stored details on a later anonymous resume", async () => {
      const organization = await createOrganization();
      const first = await openSession({
        widgetKey: organization.widgetKey,
        name: "Ada Lovelace",
        email: "ada@example.com",
      });

      const second = await openSession({
        widgetKey: organization.widgetKey,
        visitorToken: first.body.data.token,
      });

      expect(second.body.data.customer.name).toBe("Ada Lovelace");
      expect(second.body.data.customer.email).toBe("ada@example.com");
    });

    /*
      Every failure to resume falls through to a NEW anonymous customer, and
      none of them is an error (ADR-019 §6). A refusal would tell the caller
      their token was recognised.
    */
    it.each([
      ["a forged token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.bm90LWEtcmVhbC1zaWduYXR1cmU"],
      ["a token from another system", "aaaaaa.bbbbbb.cccccc"],
    ])("starts a new customer for %s rather than refusing", async (_label, visitorToken) => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, visitorToken });

      expect(response.status).toBe(201);
      expect(response.body.data.customer.id).toEqual(expect.any(String));
    });
  });

  // ---- refusals, all identical (ADR-019 §12) ----

  describe("refusals", () => {
    it("refuses an unknown widget key", async () => {
      await createOrganization();

      const response = await openSession({ widgetKey: `wk_${"z".repeat(43)}` });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("WIDGET_SESSION_REFUSED");
    });

    it("refuses a suspended organization", async () => {
      const organization = await createOrganization({ status: "suspended" });

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("WIDGET_SESSION_REFUSED");
    });

    it("creates no customer when it refuses", async () => {
      const organization = await createOrganization({ status: "suspended" });

      await openSession({ widgetKey: organization.widgetKey });

      expect(await CustomerModel.countDocuments({})).toBe(0);
    });

    it("rejects a missing widget key as a validation failure", async () => {
      const response = await openSession({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it.each([
      ["a slug", "acme-corp"],
      ["an ObjectId", "507f1f77bcf86cd799439011"],
      ["an empty string", ""],
      ["a mongo operator", '{"$ne":null}'],
    ])("rejects %s as a malformed widget key", async (_label, widgetKey) => {
      const response = await openSession({ widgetKey });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    /*
      THE enumeration property (ADR-019 §12).

      An unknown key and a suspended tenant must be indistinguishable, or the
      endpoint becomes an oracle for which keys are real and which tenants
      exist.
    */
    it("refuses an unknown key and a suspended tenant identically", async () => {
      const suspended = await createOrganization({ status: "suspended" });

      const unknownKey = await openSession({ widgetKey: `wk_${"z".repeat(43)}` });
      const suspendedTenant = await openSession({ widgetKey: suspended.widgetKey });

      expect(unknownKey.status).toBe(suspendedTenant.status);
      expect(unknownKey.body.error.code).toBe(suspendedTenant.body.error.code);
      expect(unknownKey.body.error.message).toBe(suspendedTenant.body.error.message);
    });

    it("refuses a disallowed origin identically to an unknown key", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const badOrigin = await openSession({ widgetKey: organization.widgetKey }, DISALLOWED_ORIGIN);
      const unknownKey = await openSession({ widgetKey: `wk_${"z".repeat(43)}` }, ALLOWED_ORIGIN);

      expect(badOrigin.status).toBe(unknownKey.status);
      expect(badOrigin.body.error.message).toBe(unknownKey.body.error.message);
    });

    it("names no tenant, key, reason, or internal detail in a refusal", async () => {
      const organization = await createOrganization({ status: "suspended" });

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.text).not.toContain(organization.widgetKey!);
      expect(response.text).not.toContain(organization._id.toString());
      expect(response.text).not.toContain(organization.slug);
      expect(response.text).not.toContain("suspended");
      expect(response.body.error.message).not.toMatch(/suspend|origin|unknown|exist|key/i);
    });
  });

  // ---- the origin policy (ADR-019 §10) ----

  describe("the origin policy", () => {
    it("allows an origin the tenant listed", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey }, ALLOWED_ORIGIN);

      expect(response.status).toBe(201);
    });

    it("refuses an origin the tenant did not list", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey }, DISALLOWED_ORIGIN);

      expect(response.status).toBe(403);
    });

    it("refuses every browser origin when the list is empty", async () => {
      const organization = await createOrganization({ allowedOrigins: [] });

      const response = await openSession({ widgetKey: organization.widgetKey }, ALLOWED_ORIGIN);

      expect(response.status).toBe(403);
    });

    /*
      An absent Origin means the caller is not a browser making a cross-origin
      request, and the header only constrains the one caller that cannot lie
      about it (ADR-019 §10).
    */
    it("allows a request with no Origin header at all", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(201);
    });

    it("allows a request with no Origin even when the list is empty", async () => {
      const organization = await createOrganization({ allowedOrigins: [] });

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(201);
    });

    it("refuses the literal null a sandboxed iframe sends", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey }, "null");

      expect(response.status).toBe(403);
    });

    it("checks the origin against the tenant the KEY resolved, not one the header names", async () => {
      const a = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });
      await createOrganization({ allowedOrigins: [DISALLOWED_ORIGIN] });

      // B allows this origin; A does not, and A is the tenant the key names.
      const response = await openSession({ widgetKey: a.widgetKey }, DISALLOWED_ORIGIN);

      expect(response.status).toBe(403);
    });

    it("creates no customer when the origin is refused", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      await openSession({ widgetKey: organization.widgetKey }, DISALLOWED_ORIGIN);

      expect(await CustomerModel.countDocuments({})).toBe(0);
    });
  });

  // ---- what a client may not send (ADR-019 §12) ----

  describe("client-supplied identifiers", () => {
    it("ignores an organizationId in the body", async () => {
      const a = await createOrganization();
      const b = await createOrganization();

      const response = await openSession({
        widgetKey: a.widgetKey,
        organizationId: b._id.toString(),
      });

      const customer = await CustomerModel.findById(response.body.data.customer.id);
      expect(customer!.organizationId.toString()).toBe(a._id.toString());
    });

    it("ignores a customerId in the body", async () => {
      const organization = await createOrganization();
      const existing = await CustomerModel.create({ organizationId: organization._id, name: "Somebody Else" });

      const response = await openSession({
        widgetKey: organization.widgetKey,
        customerId: existing._id.toString(),
        _id: existing._id.toString(),
      });

      expect(response.body.data.customer.id).not.toBe(existing._id.toString());
      expect(response.body.data.customer.name).toBeNull();
    });

    it.each([["role"], ["userId"], ["sessionId"], ["permissions"], ["organizationId"], ["membershipId"]])(
      "strips a client-supplied %s rather than honouring it",
      async (field) => {
        const organization = await createOrganization();

        const response = await openSession({ widgetKey: organization.widgetKey, [field]: "owner" });

        expect(response.status).toBe(201);
        expect(response.body.data.customer).not.toHaveProperty(field);
      },
    );

    it("creates no membership and no session of any kind", async () => {
      const organization = await createOrganization();

      await openSession({ widgetKey: organization.widgetKey });

      expect(await MembershipModel.countDocuments({})).toBe(0);
      expect(await SessionModel.countDocuments({})).toBe(0);
      expect(await UserModel.countDocuments({})).toBe(0);
    });

    it("sets no cookie", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.headers["set-cookie"]).toBeUndefined();
    });
  });

  // ---- the response carries the minimum (ADR-019 §12) ----

  describe("the session response", () => {
    it("returns exactly the documented shape", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      /*
        `visitorKey` appears because this is a NEW visitor: it is issued once,
        on the response that minted it, and never again (ADR-038 §3).
        `phone` is the third optional detail (ADR-038 §5).
      */
      // `appearance` and `availability` since ADR-040 §1–2: how the chat looks and whether anyone is there.
      expect(Object.keys(response.body.data).sort()).toEqual([
        "appearance",
        "availability",
        "customer",
        "expiresInSeconds",
        "token",
        "visitorKey",
      ]);
      expect(Object.keys(response.body.data.customer).sort()).toEqual(["email", "id", "name", "phone"]);
    });

    it("leaks no tenant data", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey }, ALLOWED_ORIGIN);

      expect(response.text).not.toContain(organization._id.toString());
      expect(response.text).not.toContain(organization.slug);
      // The name IS shown now: it is the chat's default title (ADR-040 §1), which every visitor sees anyway.
      expect(response.text).not.toContain(organization.widgetKey!);
      expect(response.text).not.toContain(ALLOWED_ORIGIN);
    });

    it("leaks no signing key", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.text).not.toContain(process.env.JWT_WIDGET_SECRET!);
      expect(response.text).not.toContain(process.env.JWT_ACCESS_SECRET!);
    });

    it("returns no database internals", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      for (const forbidden of ["__v", "_id", "organizationId", "lastSeenAt", "passwordHash", "createdAt"]) {
        expect(response.body.data.customer).not.toHaveProperty(forbidden);
      }
    });

    /*
      CORS is closed as of ADR-021 §5 — reflected, never `*`, and never
      credentialed. Reflecting the origin grants nothing by itself: the real
      allow/deny decision still happens inside `decideOrigin`, unchanged, and
      is asserted separately below. This only makes an answer the server was
      always going to give legible to the page that asked for it.
    */
    it("reflects the request Origin, never a wildcard, and never allows credentials", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey }, ALLOWED_ORIGIN);

      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
      expect(response.headers["access-control-allow-origin"]).not.toBe("*");
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(response.headers.vary).toBe("Origin");
    });

    // A refusal must be exactly as readable as a success (ADR-019 §12's
    // enumeration reasoning applied to this header): distinguishing them by
    // header presence would itself leak which branch was taken.
    it("reflects the origin identically on a refusal", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey }, DISALLOWED_ORIGIN);

      expect(response.status).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBe(DISALLOWED_ORIGIN);
    });

    it("sends no Access-Control-Allow-Origin for a non-browser caller with no Origin header", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("marks the resource cross-origin, overriding the API's default same-origin policy", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    });

    /*
      The preflight (ADR-021 §5): it resolves no tenant and performs no
      lookup, because a bodyless OPTIONS request structurally cannot carry a
      widgetKey. Answering it generically grants nothing — the actual POST
      still runs the full per-tenant decision.
    */
    it("answers an OPTIONS preflight without touching the database", async () => {
      const organization = await createOrganization({ allowedOrigins: [ALLOWED_ORIGIN] });

      const response = await request(app)
        .options(SESSION_PATH)
        .set("Origin", ALLOWED_ORIGIN)
        .set("Access-Control-Request-Method", "POST");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
      expect(response.headers["access-control-allow-methods"]).toBe("POST");
      expect(response.headers["access-control-allow-headers"]).toBe("Content-Type, Authorization, X-Filename");
      expect(await CustomerModel.countDocuments({ organizationId: organization._id })).toBe(0);
    });

    it("answers an OPTIONS preflight for an origin no organization has ever allowed", async () => {
      const response = await request(app)
        .options(SESSION_PATH)
        .set("Origin", "https://never-configured.example.com")
        .set("Access-Control-Request-Method", "POST");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("https://never-configured.example.com");
    });

    it("still carries the security headers every response gets", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });
  });

  // ---- input validation ----

  describe("supplied customer details", () => {
    it("rejects an email that is not an address", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, email: "not-an-email" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a name carrying control characters", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, name: "Ada\r\nBcc: x@y.z" });

      expect(response.status).toBe(400);
    });

    it("rejects an oversized name", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, name: "a".repeat(101) });

      expect(response.status).toBe(400);
    });

    it("treats an empty name as absent rather than storing one", async () => {
      const organization = await createOrganization();

      const response = await openSession({ widgetKey: organization.widgetKey, name: "   " });

      expect(response.status).toBe(201);
      expect(response.body.data.customer.name).toBeNull();
    });

    it("never echoes a rejected value back", async () => {
      const organization = await createOrganization();
      const rejected = "do-not-echo-this-address";

      const response = await openSession({ widgetKey: organization.widgetKey, email: rejected });

      expect(response.text).not.toContain(rejected);
    });

    /*
      Email is stored, never looked up (ADR-019 §5). If it were a lookup key,
      anyone who typed a known address would inherit that person's identity.
    */
    it("does not resume a customer from a matching email", async () => {
      const organization = await createOrganization();
      const first = await openSession({ widgetKey: organization.widgetKey, email: "ada@example.com" });

      const second = await openSession({ widgetKey: organization.widgetKey, email: "ada@example.com" });

      expect(second.body.data.customer.id).not.toBe(first.body.data.customer.id);
      expect(await CustomerModel.countDocuments({})).toBe(2);
    });

    it("answers a known address and an unknown one identically", async () => {
      const organization = await createOrganization();
      await openSession({ widgetKey: organization.widgetKey, email: "ada@example.com" });

      const known = await openSession({ widgetKey: organization.widgetKey, email: "ada@example.com" });
      const unknown = await openSession({ widgetKey: organization.widgetKey, email: "nobody@example.com" });

      expect(known.status).toBe(unknown.status);
      expect(Object.keys(known.body.data).sort()).toEqual(Object.keys(unknown.body.data).sort());
    });
  });

  // ---- rate limiting (ADR-019 §11) ----

  describe("rate limiting", () => {
    it("refuses past the widget session limit", async () => {
      const limited = createApp({ rateLimiting: true });
      const organization = await createOrganization();

      for (let i = 0; i < WIDGET_SESSION_LIMIT; i += 1) {
        const response = await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
        expect(response.status).toBe(201);
      }

      const overLimit = await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });

      expect(overLimit.status).toBe(429);
      expect(overLimit.body.error.code).toBe("TOO_MANY_REQUESTS");
    });

    it("sends Retry-After on a refusal, like every other class", async () => {
      const limited = createApp({ rateLimiting: true });
      const organization = await createOrganization();

      for (let i = 0; i <= WIDGET_SESSION_LIMIT; i += 1) {
        await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      }
      const response = await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });

      expect(response.headers["retry-after"]).toBeDefined();
    });

    /*
      Keyed by IP, never by widgetKey — a per-key counter would make one busy
      tenant's own visitors a shared outage and hand anyone who scraped a key
      a denial-of-service tool aimed at that tenant (ADR-019 §11).
    */
    it("does not give a second tenant a fresh budget from the same address", async () => {
      const limited = createApp({ rateLimiting: true });
      const a = await createOrganization();
      const b = await createOrganization();

      for (let i = 0; i <= WIDGET_SESSION_LIMIT; i += 1) {
        await request(limited).post(SESSION_PATH).send({ widgetKey: a.widgetKey });
      }

      const throughB = await request(limited).post(SESSION_PATH).send({ widgetKey: b.widgetKey });

      expect(throughB.status).toBe(429);
    });

    it("does not let widget traffic exhaust the staff credential budget", async () => {
      const limited = createApp({ rateLimiting: true });
      const organization = await createOrganization();

      for (let i = 0; i <= WIDGET_SESSION_LIMIT; i += 1) {
        await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      }
      expect((await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey })).status).toBe(429);

      // A different class, with its own budget intact.
      const login = await request(limited)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.com", password: "irrelevant-password" });
      expect(login.status).not.toBe(429);
    });

    it("cannot be bypassed with a forged forwarding header", async () => {
      const limited = createApp({ rateLimiting: true });
      const organization = await createOrganization();

      for (let i = 0; i <= WIDGET_SESSION_LIMIT; i += 1) {
        await request(limited).post(SESSION_PATH).send({ widgetKey: organization.widgetKey });
      }

      const response = await request(limited)
        .post(SESSION_PATH)
        .set("X-Forwarded-For", "203.0.113.9")
        .send({ widgetKey: organization.widgetKey });

      expect(response.status).toBe(429);
    });
  });
});
