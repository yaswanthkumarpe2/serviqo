import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { InvalidWidgetTokenError, WidgetSessionRefusedError } from "../lib/errors";
import { CustomerModel } from "../modules/customers/customer.model";
import { OrganizationModel } from "../modules/organizations/organization.model";
import { issueWidgetToken } from "../modules/widget/widgetToken";
import { requireWidgetToken } from "./requireWidgetToken";

import type { NextFunction, Request, Response } from "express";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeRequest(header?: string) {
  const log = fakeLog();
  const req = {
    log,
    get: (name: string) => (name.toLowerCase() === "authorization" ? header : undefined),
  } as unknown as Request;
  return { req, log };
}

async function run(header?: string) {
  const { req, log } = fakeRequest(header);
  const next = vi.fn() as unknown as NextFunction;
  await requireWidgetToken(req, {} as Response, next);
  return { req, log, next: next as unknown as ReturnType<typeof vi.fn> };
}

describe("requireWidgetToken", () => {
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

  describe("a request carrying a valid token for an active organization and existing customer", () => {
    it("attaches widgetPrincipal and continues", async () => {
      const { organization, customer } = await seedOrgAndCustomer();
      const { token } = await issueWidgetToken({
        customerId: customer._id.toString(),
        organizationId: organization._id.toString(),
      });

      const { req, next } = await run(`Bearer ${token}`);

      expect(req.widgetPrincipal).toEqual({
        customerId: customer._id.toString(),
        organizationId: organization._id.toString(),
      });
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe("credential-shape refusals → 401 INVALID_WIDGET_TOKEN", () => {
    const cases: [label: string, header: string | undefined, reason: string][] = [
      ["no Authorization header", undefined, "missing_header"],
      ["an empty header", "", "malformed_header"],
      ["the Basic scheme", "Basic dXNlcjpwYXNz", "malformed_header"],
      ["a token that does not verify", "Bearer not.a.jwt", "invalid_token"],
    ];

    it.each(cases)("refuses %s", async (_label, header, reason) => {
      const { next, req, log } = await run(header);

      const error = next.mock.calls[0]![0] as unknown;
      expect(error).toBeInstanceOf(InvalidWidgetTokenError);
      expect((error as InvalidWidgetTokenError).httpStatus).toBe(401);
      expect((error as InvalidWidgetTokenError).code).toBe("INVALID_WIDGET_TOKEN");
      expect(req.widgetPrincipal).toBeUndefined();

      const [payload] = log.info.mock.calls[0] as [{ reason: string }];
      expect(payload.reason).toBe(reason);
    });

    it("refuses a staff access token presented as a widget token", async () => {
      // A staff token is signed with a different key and carries the wrong
      // audience — it fails verifyWidgetToken at the signature, never reaching
      // a claim check (ADR-019 §8).
      const { issueAccessToken } = await import("../modules/auth/accessToken");
      const { token } = await issueAccessToken({
        userId: "507f1f77bcf86cd799439011",
        sessionId: "507f191e810c19729de860ea",
      });

      const { next } = await run(`Bearer ${token}`);

      expect(next.mock.calls[0]![0]).toBeInstanceOf(InvalidWidgetTokenError);
    });

    it("refuses an expired token", async () => {
      const { organization, customer } = await seedOrgAndCustomer();
      const { token } = await issueWidgetToken({
        customerId: customer._id.toString(),
        organizationId: organization._id.toString(),
      });

      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
        const { next } = await run(`Bearer ${token}`);
        expect(next.mock.calls[0]![0]).toBeInstanceOf(InvalidWidgetTokenError);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("a verified token whose session is no longer valid → 403 WIDGET_SESSION_REFUSED", () => {
    it("refuses when the organization no longer exists", async () => {
      const { organization, customer } = await seedOrgAndCustomer();
      const { token } = await issueWidgetToken({
        customerId: customer._id.toString(),
        organizationId: organization._id.toString(),
      });
      await OrganizationModel.deleteOne({ _id: organization._id });

      const { next, req } = await run(`Bearer ${token}`);

      const error = next.mock.calls[0]![0] as unknown;
      expect(error).toBeInstanceOf(WidgetSessionRefusedError);
      expect((error as WidgetSessionRefusedError).httpStatus).toBe(403);
      expect(req.widgetPrincipal).toBeUndefined();
    });

    it("refuses when the organization is suspended", async () => {
      const { organization, customer } = await seedOrgAndCustomer("suspended");
      const { token } = await issueWidgetToken({
        customerId: customer._id.toString(),
        organizationId: organization._id.toString(),
      });

      const { next } = await run(`Bearer ${token}`);

      expect(next.mock.calls[0]![0]).toBeInstanceOf(WidgetSessionRefusedError);
    });

    it("refuses when the customer no longer exists in that organization", async () => {
      const { organization, customer } = await seedOrgAndCustomer();
      const { token } = await issueWidgetToken({
        customerId: customer._id.toString(),
        organizationId: organization._id.toString(),
      });
      await CustomerModel.deleteOne({ _id: customer._id });

      const { next } = await run(`Bearer ${token}`);

      expect(next.mock.calls[0]![0]).toBeInstanceOf(WidgetSessionRefusedError);
    });

    it("refuses identically to unknown-organization when the customer belongs to a different organization", async () => {
      const { organization: orgA } = await seedOrgAndCustomer();
      const { organization: orgB, customer: customerB } = await seedOrgAndCustomer();
      // A token whose claims name mismatched org/customer pairs cannot be
      // produced by issueWidgetToken from real data, so this simulates a
      // forged/tampered claim set directly.
      const { token } = await issueWidgetToken({
        customerId: customerB._id.toString(),
        organizationId: orgA._id.toString(),
      });

      const { next } = await run(`Bearer ${token}`);

      expect(next.mock.calls[0]![0]).toBeInstanceOf(WidgetSessionRefusedError);
      void orgB;
    });
  });

  it("never logs the presented token", async () => {
    const { organization, customer } = await seedOrgAndCustomer();
    const { token } = await issueWidgetToken({
      customerId: customer._id.toString(),
      organizationId: organization._id.toString(),
    });

    const { log } = await run(`Bearer ${token}.tampered`);

    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(token);
  });
});
