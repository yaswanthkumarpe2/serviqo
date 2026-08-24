import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CustomerModel } from "../modules/customers/customer.model";
import { OrganizationModel } from "../modules/organizations/organization.model";
import { issueWidgetToken } from "../modules/widget/widgetToken";
import { authenticateSocketHandshake } from "./socketAuthentication";

/**
 * Unit coverage for the socket handshake's authentication core (ADR-023 §3).
 * Mirrors `requireWidgetToken.test.ts` case for case — the two are meant to
 * refuse identically, because they compose the identical primitives.
 */
describe("authenticateSocketHandshake — the widget branch", () => {
  let mongoServer: MongoMemoryServer;
  let counter = 0;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await OrganizationModel.init();
    await CustomerModel.init();
  });

  afterEach(async () => {
    await Promise.all([OrganizationModel.deleteMany({}), CustomerModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  async function seedOrgAndCustomer(status: "active" | "suspended" = "active") {
    counter += 1;
    const organization = await OrganizationModel.create({ name: `Org ${counter}`, slug: `org-${counter}`, status });
    const customer = await CustomerModel.create({ organizationId: organization._id });
    return { organization, customer };
  }

  it("resolves a valid token for an active organization and existing customer", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { token } = await issueWidgetToken({
      customerId: customer._id.toString(),
      organizationId: organization._id.toString(),
    });

    const outcome = await authenticateSocketHandshake({ token: token });

    expect(outcome).toEqual({
      ok: true,
      // `kind` discriminates the two principal types the handshake now
      // resolves (ADR-025 §9); the widget branch's behaviour is unchanged.
      kind: "widget",
      principal: { customerId: customer._id.toString(), organizationId: organization._id.toString() },
    });
  });

  it("refuses a missing token", async () => {
    const outcome = await authenticateSocketHandshake({ token: undefined });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "missing_token" });
  });

  it("refuses a non-string token", async () => {
    const outcome = await authenticateSocketHandshake({ token: 12345 });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "missing_token" });
  });

  it("refuses a malformed token", async () => {
    const outcome = await authenticateSocketHandshake({ token: "not.a.jwt" });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "invalid_token" });
  });

  it("refuses an expired token", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { SignJWT } = await import("jose");
    const expiredToken = await new SignJWT({ org: organization._id.toString() })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(customer._id.toString())
      .setIssuer("serviqo")
      .setAudience("serviqo-widget")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 60 * 60)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60 * 60)
      .sign(new TextEncoder().encode(process.env.JWT_WIDGET_SECRET!));

    const outcome = await authenticateSocketHandshake({ token: expiredToken });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "invalid_token" });
  });

  it("refuses a token signed with the wrong issuer", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { SignJWT } = await import("jose");
    const wrongIssuer = await new SignJWT({ org: organization._id.toString() })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(customer._id.toString())
      .setIssuer("not-serviqo")
      .setAudience("serviqo-widget")
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_WIDGET_SECRET!));

    const outcome = await authenticateSocketHandshake({ token: wrongIssuer });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "invalid_token" });
  });

  it("refuses a token signed with the wrong audience", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { SignJWT } = await import("jose");
    const wrongAudience = await new SignJWT({ org: organization._id.toString() })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(customer._id.toString())
      .setIssuer("serviqo")
      .setAudience("serviqo-dashboard")
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(process.env.JWT_WIDGET_SECRET!));

    const outcome = await authenticateSocketHandshake({ token: wrongAudience });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "invalid_token" });
  });

  it("refuses a staff access token presented as a widget token", async () => {
    const { issueAccessToken } = await import("../modules/auth/accessToken");
    const { token } = await issueAccessToken({
      userId: "507f1f77bcf86cd799439011",
      sessionId: "507f191e810c19729de860ea",
    });

    const outcome = await authenticateSocketHandshake({ token: token });
    expect(outcome).toEqual({ ok: false, kind: "invalid_token", reason: "invalid_token" });
  });

  it("refuses when the organization no longer exists", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { token } = await issueWidgetToken({
      customerId: customer._id.toString(),
      organizationId: organization._id.toString(),
    });
    await OrganizationModel.deleteOne({ _id: organization._id });

    const outcome = await authenticateSocketHandshake({ token: token });
    expect(outcome).toEqual({
      ok: false,
      kind: "session_refused",
      reason: "organization_not_found",
      organizationId: organization._id.toString(),
    });
  });

  it("refuses when the organization is suspended", async () => {
    const { organization, customer } = await seedOrgAndCustomer("suspended");
    const { token } = await issueWidgetToken({
      customerId: customer._id.toString(),
      organizationId: organization._id.toString(),
    });

    const outcome = await authenticateSocketHandshake({ token: token });
    expect(outcome).toEqual({
      ok: false,
      kind: "session_refused",
      reason: "organization_not_active",
      organizationId: organization._id.toString(),
    });
  });

  it("refuses when the customer no longer exists in that organization", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { token } = await issueWidgetToken({
      customerId: customer._id.toString(),
      organizationId: organization._id.toString(),
    });
    await CustomerModel.deleteOne({ _id: customer._id });

    const outcome = await authenticateSocketHandshake({ token: token });
    expect(outcome).toEqual({
      ok: false,
      kind: "session_refused",
      reason: "customer_not_found",
      organizationId: organization._id.toString(),
    });
  });

  it("refuses a forged token naming a real customer under a different organization", async () => {
    const { organization: orgA } = await seedOrgAndCustomer();
    const { customer: customerB } = await seedOrgAndCustomer();
    const { token } = await issueWidgetToken({
      customerId: customerB._id.toString(),
      organizationId: orgA._id.toString(),
    });

    const outcome = await authenticateSocketHandshake({ token: token });
    expect(outcome).toEqual({
      ok: false,
      kind: "session_refused",
      reason: "customer_not_found",
      organizationId: orgA._id.toString(),
    });
  });
});
