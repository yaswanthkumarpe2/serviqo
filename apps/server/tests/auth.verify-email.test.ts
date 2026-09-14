import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "../src/lib/crypto/tokens";
import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { UserModel } from "../src/modules/users/user.model";

const VERIFY_PATH = "/api/v1/auth/verify-email";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

/**
 * A well-formed code that no test issues.
 *
 * Six digits cannot be *guaranteed* distinct from a randomly issued one, but
 * the tests using it register no account at all, so the refusal comes from
 * the address having no pending code rather than from the digits.
 */
const UNISSUED_CODE = "000000";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

async function registerAndGetCode(ctx: ReturnType<typeof buildApp>) {
  await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });
  return ctx.fake.verifications.at(-1)!.code;
}

describe("POST /api/v1/auth/verify-email", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AccountTokenModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- success ----

  describe("valid code", () => {
    it("answers 204 with no body", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(response.body).toEqual({});
    });

    it("populates emailVerifiedAt", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).not.toBeNull();
    });

    it("leaves no outstanding verification token", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      expect(await AccountTokenModel.countDocuments({ consumedAt: null })).toBe(0);
    });

    it("issues no session, token, or cookie", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["authorization"]).toBeUndefined();
      expect(response.text).toBe("");
      // Nothing anywhere in the app has created a session collection.
      const collections = await mongoose.connection.db!.listCollections().toArray();
      const sessions = collections.find((c) => c.name === "sessions");
      if (sessions) {
        expect(await mongoose.connection.collection("sessions").countDocuments()).toBe(0);
      }
    });

    it("sends no content-type or content-length", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      expect(response.headers["content-type"]).toBeUndefined();
      expect(response.headers["content-length"]).toBeUndefined();
    });
  });

  // ---- rejection ----

  describe("rejected codes", () => {
    it("answers 400 INVALID_VERIFICATION_TOKEN for an unknown token", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: UNISSUED_CODE });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: "INVALID_VERIFICATION_TOKEN", version: "v1" },
      });
      expect(response.body.error.requestId).toEqual(expect.any(String));
    });

    it("answers identically on a second use of the same token", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const first = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });
      const second = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      expect(first.status).toBe(204);
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe("INVALID_VERIFICATION_TOKEN");
    });

    it("answers 400 for an expired token", async () => {
      const ctx = buildApp();
      await registerAndGetCode(ctx);
      const user = await UserModel.findOne({ email: EMAIL });

      const expired = "314159";
      await AccountTokenModel.create({
        userId: user!._id,
        purpose: "email_verification",
        tokenHash: sha256(expired),
        expiresAt: new Date(Date.now() - 1000),
      });

      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: expired });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_VERIFICATION_TOKEN");
      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).toBeNull();
    });

    /**
     * The core enumeration property: unknown, expired, and already-consumed
     * must be byte-identical apart from per-request identifiers.
     */
    it("answers identically for unknown, expired, and consumed tokens", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);
      const user = await UserModel.findOne({ email: EMAIL });

      const expired = "314159";
      await AccountTokenModel.create({
        userId: user!._id,
        purpose: "email_verification",
        tokenHash: sha256(expired),
        expiresAt: new Date(Date.now() - 1000),
      });
      await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      const responses = await Promise.all(
        [UNISSUED_CODE, expired, code].map((candidate) =>
          request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: candidate }),
        ),
      );

      const shape = (r: (typeof responses)[number]) => ({
        status: r.status,
        code: r.body.error.code,
        message: r.body.error.message,
        keys: Object.keys(r.body.error).sort(),
      });

      expect(shape(responses[1]!)).toEqual(shape(responses[0]!));
      expect(shape(responses[2]!)).toEqual(shape(responses[0]!));
    });

    it("carries no details, expiry, or account information", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: UNISSUED_CODE });

      expect(response.body.error).not.toHaveProperty("details");
      expect(Object.keys(response.body.error).sort()).toEqual([
        "code",
        "message",
        "requestId",
        "timestamp",
        "version",
      ]);
      const serialized = JSON.stringify(response.body).toLowerCase();
      expect(serialized).not.toContain("expire");
      expect(serialized).not.toContain("consumed");
      expect(serialized).not.toContain("user");
      expect(serialized).not.toContain("account");
    });

    it("never echoes the submitted code", async () => {
      const ctx = buildApp();
      const attempted = "271828";
      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: attempted });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(attempted);
      expect(serialized).not.toContain(sha256(attempted));
    });
  });

  // ---- already verified ----

  describe("already-verified account", () => {
    it("answers 204 when a live token is redeemed against a verified account", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);
      await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

      const user = await UserModel.findOne({ email: EMAIL });
      const leftover = "606060";
      await AccountTokenModel.create({
        userId: user!._id,
        purpose: "email_verification",
        tokenHash: sha256(leftover),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: leftover });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
    });
  });

  // ---- validation and boundary ----

  describe("validation", () => {
    it("answers 400 VALIDATION_ERROR when code is missing", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(VERIFY_PATH).send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      const fields = response.body.error.details.map((d: { field: string }) => d.field);
      // Both halves are required: the address routes, the code proves.
      expect(fields).toContain("email");
      expect(fields).toContain("code");
    });

    it("answers 400 VALIDATION_ERROR for an empty token", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: "   " });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("answers 400 VALIDATION_ERROR for an oversized token", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: "1".repeat(513) });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("tolerates surrounding whitespace on a real token", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const response = await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code: `  ${code}  ` });

      expect(response.status).toBe(204);
    });

    it("strips unrecognized keys", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const response = await request(ctx.app)
        .post(VERIFY_PATH)
        .send({ email: EMAIL, code, userId: "deadbeefdeadbeefdeadbeef", emailVerifiedAt: new Date().toISOString() });

      expect(response.status).toBe(204);
      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).not.toBeNull();
    });

    it("answers 400 MALFORMED_JSON without echoing the fragment", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);
      const response = await request(ctx.app)
        .post(VERIFY_PATH)
        .set("Content-Type", "application/json")
        .send(`{"email": "${EMAIL}", "code": "${code}",}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("MALFORMED_JSON");
      expect(JSON.stringify(response.body)).not.toContain(`"${code}"`);
    });

    it("answers 400 for a non-JSON content type", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(VERIFY_PATH).set("Content-Type", "text/plain").send("token=abc");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it.each(["get", "put", "patch", "delete"] as const)("answers 404 for %s", async (method) => {
      const ctx = buildApp();
      const response = await request(ctx.app)[method](VERIFY_PATH);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ---- correlation ----

  describe("correlation", () => {
    it("propagates X-Request-Id on the 204", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const response = await request(ctx.app).post(VERIFY_PATH).set("X-Request-Id", "verify-req-id").send({ email: EMAIL, code });

      expect(response.status).toBe(204);
      expect(response.headers["x-request-id"]).toBe("verify-req-id");
      expect(response.headers["x-correlation-id"]).toBeDefined();
    });

    it("propagates X-Request-Id into the 400 envelope", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app)
        .post(VERIFY_PATH)
        .set("X-Request-Id", "verify-fail-id")
        .send({ email: EMAIL, code: UNISSUED_CODE });

      expect(response.headers["x-request-id"]).toBe("verify-fail-id");
      expect(response.body.error.requestId).toBe("verify-fail-id");
    });
  });

  // ---- concurrency at the HTTP boundary ----

  describe("concurrency", () => {
    it("lets exactly one of several concurrent requests succeed", async () => {
      const ctx = buildApp();
      const code = await registerAndGetCode(ctx);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code })),
      );

      expect(responses.filter((r) => r.status === 204)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 400)).toHaveLength(4);
      for (const failed of responses.filter((r) => r.status === 400)) {
        expect(failed.body.error.code).toBe("INVALID_VERIFICATION_TOKEN");
      }

      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).not.toBeNull();
      expect(await AccountTokenModel.countDocuments({ consumedAt: null })).toBe(0);
    });
  });
});
