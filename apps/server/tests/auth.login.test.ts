import { jwtVerify } from "jose";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  LOGIN_MAX_FAILED_ATTEMPTS,
  REFRESH_COOKIE_NAME,
} from "../src/config/constants";
import { env } from "../src/lib/env";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";

/** Obvious sentinels — if either reaches a response body, cookie, or log, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

/** Registers and verifies through the real endpoints — the full slice-9-to-12 path. */
async function registeredAndVerifiedUser(ctx: ReturnType<typeof buildApp>) {
  await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });
}

function refreshCookie(response: request.Response): string | undefined {
  const cookies = response.headers["set-cookie"] as unknown as string[] | undefined;
  return cookies?.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

describe("POST /api/v1/auth/login", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
    await SessionModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
      SessionModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- success ----

  describe("valid credentials", () => {
    it("answers 200 in the approved envelope", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(response.body.meta.requestId).toEqual(expect.any(String));
    });

    it("returns the user's identity, an access token, and its lifetime", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.body.data.user).toEqual({
        id: expect.any(String),
        name: "Ada Lovelace",
        email: EMAIL,
        // Which staff surface this account belongs on (ADR-037) — reported by
        // login so the browser knows where to go without a second request.
        kind: "agent",
      });
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.expiresIn).toBeGreaterThan(0);
    });

    it("issues an access token this server can verify", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const session = await SessionModel.findOne({});

      const { payload } = await jwtVerify(
        response.body.data.accessToken,
        new TextEncoder().encode(env.JWT_ACCESS_SECRET),
        { issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE },
      );

      expect(payload.sub).toBe(response.body.data.user.id);
      expect(payload.sid).toBe(session!._id.toString());
    });

    it("sets the refresh token in an HttpOnly, SameSite=Strict, path-scoped cookie", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const cookie = refreshCookie(response)!;

      expect(cookie).toBeDefined();
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/api/v1/auth");
    });

    // ADR-011 §1: a body copy would make HttpOnly meaningless.
    it("never puts the refresh token in the response body", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const cookie = refreshCookie(response)!;
      const refreshToken = cookie.slice(`${REFRESH_COOKIE_NAME}=`.length).split(";")[0]!;

      expect(response.text).not.toContain(refreshToken);
      expect(Object.keys(response.body.data).sort()).toEqual(["accessToken", "expiresIn", "user"]);
    });

    it("creates a Session that stores no raw secret", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      const cookie = refreshCookie(response)!;
      const refreshToken = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length).split(";")[0]!);
      const secret = refreshToken.slice(refreshToken.indexOf(".") + 1);

      const raw = await mongoose.connection.collection("sessions").findOne({});
      expect(JSON.stringify(raw)).not.toContain(secret);
    });

    it("never exposes the password or its hash", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("passwordHash");
      expect(response.text).not.toContain("$argon2");
    });

    it("discloses no account state a client has no business seeing", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.text).not.toContain("failedLoginAttempts");
      expect(response.text).not.toContain("lockedUntil");
      expect(response.text).not.toContain("emailVerifiedAt");
    });

    it("issues a distinct session per login", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(await SessionModel.countDocuments({})).toBe(2);
    });
  });

  // ---- generic failures ----

  describe("credential failures", () => {
    it("answers 401 INVALID_CREDENTIALS for an unknown address", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("answers 401 INVALID_CREDENTIALS for a wrong password", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: "wrong-password" });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    // The response must not distinguish "no such account" from "wrong password".
    it("answers both with a byte-identical error body", async () => {
      const ctx = buildApp();
      const unknown = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      await registeredAndVerifiedUser(ctx);
      const wrong = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: "wrong-password" });

      expect(wrong.body.error.code).toBe(unknown.body.error.code);
      expect(wrong.body.error.message).toBe(unknown.body.error.message);
      expect(wrong.status).toBe(unknown.status);
    });

    it("sets no cookie and creates no session on failure", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: "wrong-password" });

      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await SessionModel.countDocuments({})).toBe(0);
    });

    it("names no failure reason in the response", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: "wrong-password" });

      expect(response.body.error.details).toBeUndefined();
      expect(response.text).not.toMatch(/locked|disabled|not found|unknown/i);
    });

    it("locks the account after the configured number of failures", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      for (let attempt = 0; attempt < LOGIN_MAX_FAILED_ATTEMPTS; attempt += 1) {
        await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: "wrong-password" });
      }

      // The correct password is now refused, and refused identically.
      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
      expect((await UserModel.findOne({}))!.lockedUntil).not.toBeNull();
    });
  });

  // ---- unverified ----

  describe("unverified account", () => {
    it("answers 403 EMAIL_NOT_VERIFIED with correct credentials", async () => {
      const ctx = buildApp();
      await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    });

    // Unreachable without the password, so it is never an enumeration oracle.
    it("stays generic when the password is wrong", async () => {
      const ctx = buildApp();
      await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: "wrong-password" });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("issues nothing", async () => {
      const ctx = buildApp();
      await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await SessionModel.countDocuments({})).toBe(0);
    });

    it("succeeds once the address is verified", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);
    });
  });

  // ---- request boundary ----

  describe("request validation", () => {
    it("rejects a missing password with 400 VALIDATION_ERROR", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details).toEqual([{ field: "password", message: expect.any(String) }]);
    });

    it("rejects a malformed address before any database work", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: "nope", password: PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("never echoes the submitted password in a validation failure", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: "nope", password: PASSWORD });

      expect(response.text).not.toContain(PASSWORD);
    });

    it("answers malformed JSON with MALFORMED_JSON, not a 500", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGIN_PATH)
        .set("Content-Type", "application/json")
        .send(`{"email":"${EMAIL}","password":"${PASSWORD}"`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("MALFORMED_JSON");
      expect(response.text).not.toContain(PASSWORD);
    });

    it("strips unrecognized keys rather than trusting them", async () => {
      const ctx = buildApp();
      await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });

      // A client attempting to declare itself verified must not be believed.
      const response = await request(ctx.app)
        .post(LOGIN_PATH)
        .send({ email: EMAIL, password: PASSWORD, emailVerifiedAt: new Date().toISOString(), status: "active" });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    });
  });

  // ---- session metadata ----

  describe("session metadata", () => {
    it("records the User-Agent the client sent", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      await request(ctx.app)
        .post(LOGIN_PATH)
        .set("User-Agent", "Mozilla/5.0 (Serviqo Test)")
        .send({ email: EMAIL, password: PASSWORD });

      expect((await SessionModel.findOne({}))!.userAgent).toBe("Mozilla/5.0 (Serviqo Test)");
    });

    it("truncates an oversized User-Agent instead of failing the login", async () => {
      const ctx = buildApp();
      await registeredAndVerifiedUser(ctx);

      const response = await request(ctx.app)
        .post(LOGIN_PATH)
        .set("User-Agent", "U".repeat(2000))
        .send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);
      expect((await SessionModel.findOne({}))!.userAgent!.length).toBe(512);
    });
  });
});
