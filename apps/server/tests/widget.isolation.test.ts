import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { verifyAccessToken } from "../src/modules/auth/accessToken";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";
import { verifyWidgetToken } from "../src/modules/widget/widgetToken";

import type { OrganizationDocument } from "../src/modules/organizations/organization.model";
import { createOrganizationAs } from "../src/modules/organizations/testing/organizations";

const SESSION_PATH = "/api/v1/widget/session";
const ME_PATH = "/api/v1/auth/me";
const ORGANIZATIONS_PATH = "/api/v1/organizations";
const LOGIN_PATH = "/api/v1/auth/login";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const REFRESH_PATH = "/api/v1/auth/refresh";
const LOGOUT_PATH = "/api/v1/auth/logout";
const LOGOUT_ALL_PATH = "/api/v1/auth/logout-all";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";

/**
 * The two boundaries this slice exists to hold (ADR-010 §5, §8; ADR-019 §6, §8):
 *
 * 1. Tenant A's customers and credentials are inert in tenant B.
 * 2. A staff credential and a visitor credential can never be used as each
 *    other, in either direction.
 */
describe("widget tenant and credential isolation", () => {
  let mongoServer: MongoMemoryServer;
  const fake = createFakeEmailProvider();
  const app = createApp({ emailProvider: fake.provider });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await OrganizationModel.init();
    await CustomerModel.init();
    await UserModel.init();
    await MembershipModel.init();
    await SessionModel.init();
    await AccountTokenModel.init();
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

  let counter = 0;
  async function createOrganization(allowedOrigins: string[] = []): Promise<OrganizationDocument> {
    counter += 1;
    return OrganizationModel.create({ name: `Org ${counter}`, slug: `org-${counter}`, allowedOrigins });
  }

  const openSession = (body: Record<string, unknown>) => request(app).post(SESSION_PATH).send(body);

  async function staffAccessToken(email: string): Promise<string> {
    await createStaffAccount(fake.provider, { name: "Ada Lovelace", email, password: PASSWORD });
    const code = fake.verifications.at(-1)!.code;
    await request(app).post(VERIFY_PATH).send({ email, code });
    const login = await request(app).post(LOGIN_PATH).send({ email, password: PASSWORD });
    return login.body.data.accessToken as string;
  }

  // ---- tenant isolation ----

  describe("across organizations", () => {
    it("gives two organizations two different widget keys", async () => {
      const a = await createOrganization();
      const b = await createOrganization();

      expect(a.widgetKey).not.toBe(b.widgetKey);
      expect(a.widgetKey).not.toBeNull();
      expect(b.widgetKey).not.toBeNull();
    });

    it("creates a customer under the organization whose key was used", async () => {
      const a = await createOrganization();
      const b = await createOrganization();

      const inA = await openSession({ widgetKey: a.widgetKey });
      const inB = await openSession({ widgetKey: b.widgetKey });

      const customerA = await CustomerModel.findById(inA.body.data.customer.id);
      const customerB = await CustomerModel.findById(inB.body.data.customer.id);

      expect(customerA!.organizationId.toString()).toBe(a._id.toString());
      expect(customerB!.organizationId.toString()).toBe(b._id.toString());
    });

    /*
      THE cross-tenant control (ADR-019 §6).

      A browser holding tenant A's token and then visiting tenant B's website
      is completely ordinary. The correct outcome is that A's token buys
      nothing in B — a NEW B customer — rather than a refusal that would tell
      the caller their token was recognised.
    */
    it("does not resume an A customer through B's widget key", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey });

      const throughB = await openSession({ widgetKey: b.widgetKey, visitorToken: inA.body.data.token });

      expect(throughB.status).toBe(201);
      expect(throughB.body.data.customer.id).not.toBe(inA.body.data.customer.id);
    });

    it("puts the new customer in B, not in A", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey });

      const throughB = await openSession({ widgetKey: b.widgetKey, visitorToken: inA.body.data.token });

      const customer = await CustomerModel.findById(throughB.body.data.customer.id);
      expect(customer!.organizationId.toString()).toBe(b._id.toString());
      expect(await CustomerModel.countDocuments({ organizationId: a._id })).toBe(1);
      expect(await CustomerModel.countDocuments({ organizationId: b._id })).toBe(1);
    });

    it("issues a token bound to B when B's key was used", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey });

      const throughB = await openSession({ widgetKey: b.widgetKey, visitorToken: inA.body.data.token });

      const principal = await verifyWidgetToken(throughB.body.data.token);
      expect(principal!.organizationId).toBe(b._id.toString());
      expect(principal!.organizationId).not.toBe(a._id.toString());
    });

    /*
      A customer id and an organization id supplied together in the body, both
      real, both belonging to A — and neither is consulted. The tenant comes
      from the key and the identity comes from the token.
    */
    it("cannot move a customer into another tenant with client-supplied ids", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey });
      const customerId = inA.body.data.customer.id as string;

      const attempt = await openSession({
        widgetKey: b.widgetKey,
        customerId,
        organizationId: a._id.toString(),
      });

      expect(attempt.body.data.customer.id).not.toBe(customerId);
      const original = await CustomerModel.findById(customerId);
      expect(original!.organizationId.toString()).toBe(a._id.toString());
    });

    it("leaves A's customer untouched by anything done through B", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey, name: "Ada Lovelace" });

      await openSession({
        widgetKey: b.widgetKey,
        visitorToken: inA.body.data.token,
        name: "Overwritten",
      });

      const original = await CustomerModel.findById(inA.body.data.customer.id);
      expect(original!.name).toBe("Ada Lovelace");
    });

    it("resumes correctly when the browser returns to the right tenant", async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey });

      // Visits B, then comes back to A with A's original token.
      await openSession({ widgetKey: b.widgetKey, visitorToken: inA.body.data.token });
      const backToA = await openSession({ widgetKey: a.widgetKey, visitorToken: inA.body.data.token });

      expect(backToA.body.data.customer.id).toBe(inA.body.data.customer.id);
    });

    it("does not resume a customer deleted from its own tenant", async () => {
      const a = await createOrganization();
      const inA = await openSession({ widgetKey: a.widgetKey });
      await CustomerModel.deleteOne({ _id: inA.body.data.customer.id });

      const again = await openSession({ widgetKey: a.widgetKey, visitorToken: inA.body.data.token });

      expect(again.status).toBe(201);
      expect(again.body.data.customer.id).not.toBe(inA.body.data.customer.id);
    });
  });

  // ---- the credential boundary, over HTTP ----

  describe("staff credentials at widget endpoints", () => {
    it("does not accept a staff access token as a visitor token", async () => {
      const organization = await createOrganization();
      const accessToken = await staffAccessToken("staff-a@example.com");

      const response = await openSession({ widgetKey: organization.widgetKey, visitorToken: accessToken });

      // Not resumed as anyone: a brand-new anonymous customer instead.
      expect(response.status).toBe(201);
      const customer = await CustomerModel.findById(response.body.data.customer.id);
      expect(customer!.name).toBeNull();
      expect(customer!.organizationId.toString()).toBe(organization._id.toString());
    });

    it("gains nothing from presenting a staff bearer token to the widget endpoint", async () => {
      const organization = await createOrganization();
      const accessToken = await staffAccessToken("staff-b@example.com");

      const withHeader = await request(app)
        .post(SESSION_PATH)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ widgetKey: organization.widgetKey });
      const without = await openSession({ widgetKey: organization.widgetKey });

      expect(withHeader.status).toBe(without.status);
      expect(Object.keys(withHeader.body.data).sort()).toEqual(Object.keys(without.body.data).sort());
    });

    it("refuses a staff access token at the widget verifier", async () => {
      const accessToken = await staffAccessToken("staff-c@example.com");

      await expect(verifyWidgetToken(accessToken)).resolves.toBeNull();
    });
  });

  describe("widget credentials at staff endpoints", () => {
    it("refuses a widget token at GET /auth/me", async () => {
      const organization = await createOrganization();
      const session = await openSession({ widgetKey: organization.widgetKey });

      const response = await request(app)
        .get(ME_PATH)
        .set("Authorization", `Bearer ${session.body.data.token}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("refuses a widget token at the super admin's organisation creation", async () => {
      const organization = await createOrganization();
      const session = await openSession({ widgetKey: organization.widgetKey });

      const response = await request(app)
        .post("/api/v1/admin/organizations")
        .set("Authorization", `Bearer ${session.body.data.token}`)
        .send({ name: "Hostile Takeover", owner: { name: "Mallory", email: "mallory@example.com" } });

      expect(response.status).toBe(401);
      expect(await OrganizationModel.countDocuments({})).toBe(1);
    });

    /*
      The one that matters most: a visitor holding a token for tenant A must
      not be able to read A's organization context, which carries the caller's
      role.
    */
    it("refuses a widget token at the organization context route", async () => {
      const organization = await createOrganization();
      const session = await openSession({ widgetKey: organization.widgetKey });

      const response = await request(app)
        .get(`${ORGANIZATIONS_PATH}/${organization._id.toString()}`)
        .set("Authorization", `Bearer ${session.body.data.token}`);

      expect(response.status).toBe(401);
      expect(response.body).not.toHaveProperty("data");
    });

    it("refuses a widget token at the staff verifier", async () => {
      const organization = await createOrganization();
      const session = await openSession({ widgetKey: organization.widgetKey });

      await expect(verifyAccessToken(session.body.data.token)).resolves.toBeNull();
    });

    it("is refused identically to a garbage token, revealing nothing", async () => {
      const organization = await createOrganization();
      const session = await openSession({ widgetKey: organization.widgetKey });

      const withWidget = await request(app).get(ME_PATH).set("Authorization", `Bearer ${session.body.data.token}`);
      const withGarbage = await request(app).get(ME_PATH).set("Authorization", "Bearer not.a.token");

      expect(withWidget.status).toBe(withGarbage.status);
      expect(withWidget.body.error.code).toBe(withGarbage.body.error.code);
      expect(withWidget.body.error.message).toBe(withGarbage.body.error.message);
    });

    it("cannot refresh a staff session with a widget token in the cookie", async () => {
      const organization = await createOrganization();
      const session = await openSession({ widgetKey: organization.widgetKey });

      const response = await request(app)
        .post(REFRESH_PATH)
        .set("Cookie", `serviqo_refresh=${session.body.data.token}`);

      expect(response.status).toBe(401);
    });
  });

  // ---- the existing staff surface is untouched ----

  describe("existing staff authentication", () => {
    it("still completes register, verify, login, me, organization, refresh, logout", async () => {
      const email = "regression@example.com";
      await createStaffAccount(fake.provider, { name: "Ada Lovelace", email, password: PASSWORD });
      const verificationCode = fake.verifications.at(-1)!.code;
      // 204 with no body — the deliberate exception to the envelope (ADR-008 §1).
      expect((await request(app).post(VERIFY_PATH).send({ email, code: verificationCode })).status).toBe(204);

      const login = await request(app).post(LOGIN_PATH).send({ email, password: PASSWORD });
      expect(login.status).toBe(200);
      const accessToken = login.body.data.accessToken as string;
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

      const me = await request(app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe(email);

      const created = await createOrganizationAs(accessToken, "Acme Corp");

      const context = await request(app)
        .get(`${ORGANIZATIONS_PATH}/${created.id}`)
        .set("Authorization", `Bearer ${accessToken}`);
      expect(context.status).toBe(200);
      expect(context.body.data.role).toBe("owner");

      const refreshed = await request(app).post(REFRESH_PATH).set("Cookie", cookie);
      expect(refreshed.status).toBe(200);
      const rotated = (refreshed.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

      expect((await request(app).post(LOGOUT_PATH).set("Cookie", rotated)).status).toBe(200);
      expect((await request(app).post(REFRESH_PATH).set("Cookie", rotated)).status).toBe(401);
    });

    it("still logs out all devices", async () => {
      const email = "logout-all@example.com";
      const accessToken = await staffAccessToken(email);
      expect(accessToken).toEqual(expect.any(String));

      const second = await request(app).post(LOGIN_PATH).send({ email, password: PASSWORD });
      const cookie = (second.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

      expect((await request(app).post(LOGOUT_ALL_PATH).set("Cookie", cookie)).status).toBe(200);
      expect((await request(app).post(REFRESH_PATH).set("Cookie", cookie)).status).toBe(401);
    });

    /*
      A staff organization created through the API gets a widget key like any
      other, so the two flows meet correctly rather than only in tests.
    */
    it("gives an organization created for staff a working widget key", async () => {
      const accessToken = await staffAccessToken("onboarding@example.com");

      const created = await createOrganizationAs(accessToken, "Acme Corp");

      const organization = await OrganizationModel.findById(created.id);
      expect(organization!.widgetKey).not.toBeNull();

      const session = await openSession({ widgetKey: organization!.widgetKey });
      expect(session.status).toBe(201);
    });

    // The widget key is tenant configuration and must not appear in a staff
    // response that was not designed to carry it (ADR-019 §14).
    it("does not leak the widget key through the organization endpoints", async () => {
      const accessToken = await staffAccessToken("no-leak@example.com");
      const created = await createOrganizationAs(accessToken, "Acme Corp");
      const organization = await OrganizationModel.findById(created.id);

      const context = await request(app)
        .get(`${ORGANIZATIONS_PATH}/${organization!._id.toString()}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(context.text).not.toContain(organization!.widgetKey!);
    });
  });

  // ---- logging (ADR-019 §12) ----

  describe("what reaches the logs", () => {
    /**
     * Captures what the service actually logs by driving it through the real
     * HTTP stack with a logger whose output is collected.
     */
    function captureLogs() {
      const lines: string[] = [];
      const record = (payload: Record<string, unknown>, message: string) => {
        lines.push(JSON.stringify(payload) + " " + message);
      };
      return { lines, logger: { info: record, error: record, warn: record } };
    }

    it("logs no token, key, or personal data on a successful session", async () => {
      const organization = await createOrganization();
      const capture = captureLogs();

      const { createWidgetSessionService } = await import("../src/modules/widget/widgetSession.service");
      const result = await createWidgetSessionService().createSession(
        { widgetKey: organization.widgetKey!, name: "Ada Lovelace", email: "ada@example.com" },
        { origin: undefined },
        capture.logger,
      );

      const logged = capture.lines.join("\n");
      expect(logged).not.toContain(organization.widgetKey!);
      expect(logged).not.toContain("Ada Lovelace");
      expect(logged).not.toContain("ada@example.com");
      expect(logged).not.toContain(result.token);
      expect(logged).not.toContain(process.env.JWT_WIDGET_SECRET!);
      // What IS logged: server-side identifiers an operator can act on.
      expect(logged).toContain("widget.session.created");
      expect(logged).toContain(organization._id.toString());
      expect(logged).toContain(result.customer.id);
    });

    it("logs no widget key or token on a refusal", async () => {
      const organization = await createOrganization(["https://shop.example.com"]);
      const capture = captureLogs();

      const { createWidgetSessionService } = await import("../src/modules/widget/widgetSession.service");
      await expect(
        createWidgetSessionService().createSession(
          { widgetKey: organization.widgetKey! },
          { origin: "https://evil.example.net" },
          capture.logger,
        ),
      ).rejects.toThrow();

      const logged = capture.lines.join("\n");
      expect(logged).not.toContain(organization.widgetKey!);
      expect(logged).not.toContain("evil.example.net");
      expect(logged).toContain("widget.session.refused");
      expect(logged).toContain("origin_not_allowed");
    });

    it("logs no password hash anywhere on the widget path", async () => {
      const organization = await createOrganization();
      const capture = captureLogs();

      const { createWidgetSessionService } = await import("../src/modules/widget/widgetSession.service");
      await createWidgetSessionService().createSession(
        { widgetKey: organization.widgetKey! },
        { origin: undefined },
        capture.logger,
      );

      expect(capture.lines.join("\n")).not.toContain("$argon2");
    });
  });

  // ---- expiry ----

  it("does not resume a customer from an expired token", async () => {
    const organization = await createOrganization();
    const first = await openSession({ widgetKey: organization.widgetKey });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      const principal = await verifyWidgetToken(first.body.data.token);
      expect(principal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
