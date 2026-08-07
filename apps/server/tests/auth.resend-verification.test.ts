import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { accountTokenRepository } from "../src/modules/accountTokens/accountToken.repository";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { UserModel } from "../src/modules/users/user.model";

const REGISTER_PATH = "/api/v1/auth/register";
const RESEND_PATH = "/api/v1/auth/resend-verification";

/** Obvious sentinel — if it reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const UNKNOWN_EMAIL = "nobody@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

async function registerAda(app: ReturnType<typeof buildApp>["app"]) {
  return request(app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email: EMAIL, password: PASSWORD });
}

describe("POST /api/v1/auth/resend-verification", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([UserModel.deleteMany({}), AccountTokenModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- the silent contract ----

  describe("silent 204 contract", () => {
    it("answers 204 with no body for an unverified account", async () => {
      const { app, fake } = buildApp();
      await registerAda(app);
      fake.verifications.length = 0;

      const response = await request(app).post(RESEND_PATH).send({ email: EMAIL });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(response.body).toEqual({});
      expect(fake.verifications).toHaveLength(1);
    });

    it("answers 204 with no body for an unknown address", async () => {
      const { app, fake } = buildApp();

      const response = await request(app).post(RESEND_PATH).send({ email: UNKNOWN_EMAIL });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(fake.verifications).toHaveLength(0);
    });

    it("answers 204 with no body for an already-verified account", async () => {
      const { app, fake } = buildApp();
      await registerAda(app);
      await UserModel.updateOne({ email: EMAIL }, { $set: { emailVerifiedAt: new Date() } });
      fake.verifications.length = 0;

      const response = await request(app).post(RESEND_PATH).send({ email: EMAIL });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(fake.verifications).toHaveLength(0);
    });

    it("sends no content-type or content-length that could vary by outcome", async () => {
      const { app } = buildApp();
      await registerAda(app);

      const response = await request(app).post(RESEND_PATH).send({ email: EMAIL });

      expect(response.headers["content-type"]).toBeUndefined();
      expect(response.headers["content-length"]).toBeUndefined();
    });
  });

  // ---- enumeration resistance (ADR-008 §1) ----

  describe("enumeration resistance", () => {
    /**
     * The whole point of the endpoint: an attacker holding these three
     * responses side by side must not be able to tell which address exists,
     * which is verified, and which received mail.
     */
    it("answers identically for unknown, unverified, and verified addresses", async () => {
      const { app } = buildApp();

      // unverified
      await registerAda(app);
      const unverified = await request(app).post(RESEND_PATH).send({ email: EMAIL });

      // verified
      await UserModel.updateOne({ email: EMAIL }, { $set: { emailVerifiedAt: new Date() } });
      const verified = await request(app).post(RESEND_PATH).send({ email: EMAIL });

      // unknown
      const unknown = await request(app).post(RESEND_PATH).send({ email: UNKNOWN_EMAIL });

      const shape = (r: typeof unknown) => ({
        status: r.status,
        text: r.text,
        // Per-request identifiers are expected to differ; everything else
        // must not.
        headers: Object.fromEntries(
          Object.entries(r.headers).filter(([key]) => !["x-request-id", "x-correlation-id", "date"].includes(key)),
        ),
      });

      expect(shape(unverified)).toEqual(shape(unknown));
      expect(shape(verified)).toEqual(shape(unknown));
    });

    it("does not disclose existence through a token-write failure", async () => {
      // A 500 would be reachable only for an existing unverified account,
      // making the status itself an oracle (ADR-008 §5).
      const { app, fake } = buildApp();
      await registerAda(app);
      fake.verifications.length = 0;

      const create = vi.spyOn(accountTokenRepository, "create").mockRejectedValue(new Error("boom"));

      const response = await request(app).post(RESEND_PATH).send({ email: EMAIL });

      // Proves the failure actually happened rather than the assertion
      // passing because the injection silently missed.
      expect(create).toHaveBeenCalled();
      expect(await AccountTokenModel.countDocuments()).toBe(0);
      expect(fake.verifications).toHaveLength(0);

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
    });
  });

  // ---- persistence effects ----

  describe("persistence", () => {
    it("replaces the outstanding token rather than accumulating tokens", async () => {
      const { app } = buildApp();
      await registerAda(app);

      const before = await AccountTokenModel.find({}).select("+tokenHash");
      expect(before).toHaveLength(1);

      await request(app).post(RESEND_PATH).send({ email: EMAIL });

      const after = await AccountTokenModel.find({}).select("+tokenHash");
      expect(after).toHaveLength(1);
      expect(after[0]!.tokenHash).not.toBe(before[0]!.tokenHash);
      expect(after[0]!.consumedAt).toBeNull();
    });

    it("creates nothing for an unknown address", async () => {
      const { app } = buildApp();

      await request(app).post(RESEND_PATH).send({ email: UNKNOWN_EMAIL });

      expect(await UserModel.countDocuments()).toBe(0);
      expect(await AccountTokenModel.countDocuments()).toBe(0);
    });
  });

  // ---- validation and request boundary ----

  describe("validation", () => {
    it("answers 400 VALIDATION_ERROR for a malformed address", async () => {
      const { app } = buildApp();
      const response = await request(app).post(RESEND_PATH).send({ email: "not-an-email" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details).toEqual([{ field: "email", message: expect.any(String) }]);
    });

    it("answers 400 when email is missing", async () => {
      const { app } = buildApp();
      const response = await request(app).post(RESEND_PATH).send({});

      expect(response.status).toBe(400);
      expect(response.body.error.details.map((d: { field: string }) => d.field)).toContain("email");
    });

    it("never echoes the submitted address", async () => {
      const { app } = buildApp();
      const response = await request(app).post(RESEND_PATH).send({ email: "leak-me@@example" });

      expect(JSON.stringify(response.body)).not.toContain("leak-me");
    });

    it("ignores unrecognized keys instead of honouring them", async () => {
      const { app, fake } = buildApp();
      await registerAda(app);
      fake.verifications.length = 0;

      const response = await request(app)
        .post(RESEND_PATH)
        .send({ email: EMAIL, emailVerifiedAt: new Date().toISOString(), status: "disabled" });

      expect(response.status).toBe(204);
      const stored = await UserModel.findOne({ email: EMAIL });
      expect(stored!.emailVerifiedAt).toBeNull();
      expect(stored!.status).toBe("active");
    });

    it("answers 400 MALFORMED_JSON without echoing the body fragment", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(RESEND_PATH)
        .set("Content-Type", "application/json")
        .send(`{"email": "${EMAIL}",}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("MALFORMED_JSON");
      expect(JSON.stringify(response.body)).not.toContain(EMAIL);
    });

    it("answers 400 for a non-JSON content type", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(RESEND_PATH)
        .set("Content-Type", "text/plain")
        .send(`email=${EMAIL}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it.each(["get", "put", "patch", "delete"] as const)("answers 404 for %s", async (method) => {
      const { app } = buildApp();
      const response = await request(app)[method](RESEND_PATH);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ---- correlation ----

  describe("correlation", () => {
    it("still returns request identifiers in headers despite the empty body", async () => {
      const { app } = buildApp();
      await registerAda(app);

      const response = await request(app).post(RESEND_PATH).set("X-Request-Id", "resend-req-id").send({ email: EMAIL });

      expect(response.status).toBe(204);
      expect(response.headers["x-request-id"]).toBe("resend-req-id");
      expect(response.headers["x-correlation-id"]).toBeDefined();
    });
  });

  // ---- concurrency at the HTTP boundary ----

  describe("concurrency", () => {
    it("answers 204 to every concurrent request and issues no extra tokens", async () => {
      const { app, fake } = buildApp();
      await registerAda(app);
      fake.verifications.length = 0;

      const responses = await Promise.all(
        Array.from({ length: 3 }, () => request(app).post(RESEND_PATH).send({ email: EMAIL })),
      );

      expect(responses.map((r) => r.status)).toEqual([204, 204, 204]);
      expect(fake.verifications).toHaveLength(3);

      // ADR-005: invalidate+create are not atomic, so the bound is per
      // request, not exactly one.
      const outstanding = await AccountTokenModel.countDocuments({ consumedAt: null });
      expect(outstanding).toBeGreaterThanOrEqual(1);
      expect(outstanding).toBeLessThanOrEqual(3);
    });
  });
});
