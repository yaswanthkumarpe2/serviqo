import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider, extractToken } from "../src/modules/auth/testing/fakeEmailProvider";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const REFRESH_PATH = "/api/v1/auth/refresh";
const LOGOUT_ALL_PATH = "/api/v1/auth/logout-all";

/** Obvious sentinels — if either reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

function refreshSetCookie(response: request.Response): string | undefined {
  const cookies = response.headers["set-cookie"] as unknown as string[] | undefined;
  return cookies?.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

/** The `name=value` pair a browser would send back, without the attributes. */
function cookiePair(response: request.Response): string {
  return refreshSetCookie(response)!.split(";")[0]!;
}

/**
 * The session a cookie addresses. The token is `<sessionId>.<secret>` and the
 * id half is not secret (ADR-004 §2), so a test may read it.
 */
function sessionIdOf(cookie: string): string {
  const token = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length));
  return token.slice(0, token.indexOf("."));
}

async function registerAndVerify(ctx: ReturnType<typeof buildApp>, email: string) {
  await request(ctx.app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email, password: PASSWORD });
  const token = extractToken(ctx.fake.verifications.at(-1)!.verificationUrl)!;
  await request(ctx.app).post(VERIFY_PATH).send({ token });
}

/** Signs in and returns the cookie that device now holds. */
async function signIn(ctx: ReturnType<typeof buildApp>, email = EMAIL) {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return cookiePair(login);
}

describe("POST /api/v1/auth/logout-all", () => {
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

  // ---- the ordinary case ----

  describe("a signed-in browser", () => {
    it("answers 200 in the approved envelope", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(response.body.meta.requestId).toEqual(expect.any(String));
    });

    // ADR-014 §2: a count would be a fact about the account — how many
    // devices this person uses.
    it("carries no field reporting how many sessions were revoked", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      await signIn(ctx);
      await signIn(ctx);
      const cookie = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect(response.body.data).toEqual({});
      expect(Object.keys(response.body.data)).toHaveLength(0);
      expect(Object.keys(response.body).sort()).toEqual(["data", "meta", "success"]);
      expect(response.text).not.toMatch(/revoked|count|sessions|devices/i);
    });

    /*
      The load-bearing version of the assertion above: one device and three
      devices must produce the same body. Anything that varied with the number
      of sessions would be the channel ADR-008 §1 closed.
    */
    it("answers identically whether one device was signed in or three", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const lone = await signIn(ctx);
      const oneDevice = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", lone);

      await signIn(ctx);
      await signIn(ctx);
      const third = await signIn(ctx);
      const threeDevices = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", third);

      expect(threeDevices.status).toBe(oneDevice.status);
      expect(threeDevices.body.data).toEqual(oneDevice.body.data);
      expect(threeDevices.body.success).toBe(oneDevice.body.success);
      // Only the per-request correlation fields differ.
      expect(Object.keys(threeDevices.body.meta).sort()).toEqual(Object.keys(oneDevice.body.meta).sort());
    });

    it("clears the refresh cookie with the attributes that identify it", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      const cleared = refreshSetCookie(response)!;

      expect(cleared).toBeDefined();
      expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
      expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(cleared).toContain("HttpOnly");
      expect(cleared).not.toMatch(/Max-Age=[1-9]/);
    });

    it("leaks no token, password, or hash", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);
      const token = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length));

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain(token.slice(token.indexOf(".") + 1));
      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("$argon2");
    });
  });

  // ---- the topology this endpoint exists for ----

  describe("three devices, two users", () => {
    /**
     * Device A and B belong to one user; device C to another. A signs out
     * everywhere.
     */
    async function threeDevices() {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      await registerAndVerify(ctx, OTHER_EMAIL);

      const deviceA = await signIn(ctx, EMAIL);
      const deviceB = await signIn(ctx, EMAIL);
      const deviceC = await signIn(ctx, OTHER_EMAIL);

      return { ctx, deviceA, deviceB, deviceC };
    }

    it("revokes A and B, and leaves C active", async () => {
      const { ctx, deviceA, deviceB, deviceC } = await threeDevices();

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", deviceA);

      expect((await SessionModel.findById(sessionIdOf(deviceA)))!.revokedAt).not.toBeNull();
      expect((await SessionModel.findById(sessionIdOf(deviceB)))!.revokedAt).not.toBeNull();
      expect((await SessionModel.findById(sessionIdOf(deviceC)))!.revokedAt).toBeNull();
    });

    it("stops A and B refreshing, and lets C carry on", async () => {
      const { ctx, deviceA, deviceB, deviceC } = await threeDevices();

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", deviceA);

      await expect(
        request(ctx.app).post(REFRESH_PATH).set("Cookie", deviceA).then((r) => r.status),
      ).resolves.toBe(401);
      await expect(
        request(ctx.app).post(REFRESH_PATH).set("Cookie", deviceB).then((r) => r.status),
      ).resolves.toBe(401);
      await expect(
        request(ctx.app).post(REFRESH_PATH).set("Cookie", deviceC).then((r) => r.status),
      ).resolves.toBe(200);
    });

    it("lets the signed-out user sign in again afterwards", async () => {
      const { ctx, deviceA } = await threeDevices();

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", deviceA);
      const again = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(again.status).toBe(200);
      const fresh = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(again));
      expect(fresh.status).toBe(200);
    });
  });

  // ---- idempotency (ADR-014 §1) ----

  describe("repeating the call", () => {
    it("answers 200 every time", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);

      const first = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      const third = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    });

    it("answers each with a byte-identical body", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);

      const first = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect(second.body.data).toEqual(first.body.data);
      expect(second.body.success).toBe(first.body.success);
    });

    it("clears the cookie on the repeat too", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect(refreshSetCookie(second)).toContain("Expires=Thu, 01 Jan 1970");
    });

    it("preserves the original revocation timestamps", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const deviceA = await signIn(ctx);
      const deviceB = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", deviceA);
      const firstB = (await SessionModel.findById(sessionIdOf(deviceB)))!.revokedAt!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", deviceA);

      expect((await SessionModel.findById(sessionIdOf(deviceB)))!.revokedAt!.getTime()).toBe(firstB);
    });
  });

  // ---- everything else also succeeds (ADR-014 §1) ----

  describe("calls with nothing to revoke", () => {
    it("answers 200 with no cookie at all", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("answers 200 for a fabricated cookie", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGOUT_ALL_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      expect(response.status).toBe(200);
    });

    // A CastError would report a client's garbage as a server fault.
    it("answers 200 for a malformed session id, not 500", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGOUT_ALL_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=zzzz.secret`);

      expect(response.status).toBe(200);
    });

    it("answers 200 against an expired session", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);
      await SessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect(response.status).toBe(200);
    });

    it("still clears the cookie when it revoked nothing", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGOUT_ALL_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      expect(refreshSetCookie(response)).toContain("Expires=Thu, 01 Jan 1970");
    });

    // Answering differently would confirm which session ids are real.
    it("is indistinguishable from a real logout-all", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);

      const real = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      const absent = await request(ctx.app).post(LOGOUT_ALL_PATH);
      const fabricated = await request(ctx.app)
        .post(LOGOUT_ALL_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      for (const response of [absent, fabricated]) {
        expect(response.status).toBe(real.status);
        expect(response.body.data).toEqual(real.body.data);
        expect(response.body.success).toBe(real.body.success);
      }
    });
  });

  // ---- the secret is the credential (ADR-014 §3) ----

  describe("a session id presented without its secret", () => {
    it("cannot sign a stranger out of every device", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const deviceA = await signIn(ctx);
      const deviceB = await signIn(ctx);

      // Only the non-secret half of the token, which anyone could guess.
      const response = await request(ctx.app)
        .post(LOGOUT_ALL_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=${sessionIdOf(deviceA)}.a-secret-that-was-never-issued`);

      expect(response.status).toBe(200);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(2);
      expect((await SessionModel.findById(sessionIdOf(deviceB)))!.revokedAt).toBeNull();
    });

    it("leaves both sessions able to keep refreshing", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const deviceA = await signIn(ctx);
      const deviceB = await signIn(ctx);

      await request(ctx.app)
        .post(LOGOUT_ALL_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=${sessionIdOf(deviceA)}.a-secret-that-was-never-issued`);

      await expect(
        request(ctx.app).post(REFRESH_PATH).set("Cookie", deviceB).then((r) => r.status),
      ).resolves.toBe(200);
    });
  });

  // ---- request boundary ----

  describe("request boundary", () => {
    // ADR-014 §3: the credential is the cookie, and only the cookie.
    it("ignores a refresh token supplied in the body", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const cookie = await signIn(ctx);
      const token = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length));

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).send({ refreshToken: token });

      expect(response.status).toBe(200);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(1);
    });

    it("accepts a request with no body at all", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGOUT_ALL_PATH).set("Content-Type", "application/json");

      expect(response.status).toBe(200);
    });
  });
});
