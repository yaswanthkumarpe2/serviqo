import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const REFRESH_PATH = "/api/v1/auth/refresh";
const LOGOUT_PATH = "/api/v1/auth/logout";

/** Obvious sentinels — if either reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

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

async function registeredAndVerified(ctx: ReturnType<typeof buildApp>) {
  await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });
}

/**
 * The session a cookie addresses. The token is `<sessionId>.<secret>` and the
 * id half is not secret (ADR-004 §2), so a test may read it.
 */
function sessionIdOf(cookie: string): string {
  const token = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length));
  return token.slice(0, token.indexOf("."));
}

/** Signs in and returns the cookie that device now holds. */
async function signIn(ctx: ReturnType<typeof buildApp>) {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
  return { login, cookie: cookiePair(login) };
}

describe("POST /api/v1/auth/logout", () => {
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
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(response.body.meta.requestId).toEqual(expect.any(String));
    });

    // ADR-013 §2: a constant body is not a channel.
    it("returns a data payload that discloses nothing", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(response.body.data).toEqual({});
    });

    it("revokes the session", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(0);
    });

    it("clears the refresh cookie with the attributes that identify it", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const cleared = refreshSetCookie(response)!;

      expect(cleared).toBeDefined();
      expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
      expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(cleared).toContain("HttpOnly");
    });

    // A live Max-Age would re-issue the cookie at the moment it is destroyed.
    it("does not re-issue the cookie while clearing it", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(refreshSetCookie(response)).not.toMatch(/Max-Age=[1-9]/);
    });

    // The point of the whole slice: a reload must not restore the session.
    it("stops the cookie from refreshing afterwards", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const refresh = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(refresh.status).toBe(401);
      expect(refresh.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    });

    it("leaks no token, password, or hash", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);
      const presentedToken = cookie.slice(`${REFRESH_COOKIE_NAME}=`.length);

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(response.text).not.toContain(decodeURIComponent(presentedToken));
      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("$argon2");
    });
  });

  // ---- idempotency (ADR-013 §1) ----

  describe("logging out twice", () => {
    it("answers 200 both times", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const first = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("answers both with a byte-identical body", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const first = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(second.body.data).toEqual(first.body.data);
      expect(second.body.success).toBe(first.body.success);
    });

    it("clears the cookie on the second call too", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(refreshSetCookie(second)).toContain("Expires=Thu, 01 Jan 1970");
    });

    it("preserves the first revocation timestamp", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const firstRevokedAt = (await SessionModel.findOne({}))!.revokedAt!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect((await SessionModel.findOne({}))!.revokedAt!.getTime()).toBe(firstRevokedAt);
    });
  });

  // ---- everything else also succeeds (ADR-013 §1) ----

  describe("calls with nothing to revoke", () => {
    it("answers 200 with no cookie at all", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGOUT_PATH);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it("answers 200 for a fabricated cookie", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGOUT_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      expect(response.status).toBe(200);
    });

    // A CastError would report a client's garbage as a server fault.
    it("answers 200 for a malformed session id, not 500", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGOUT_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=zzzz.secret`);

      expect(response.status).toBe(200);
    });

    it("answers 200 against a session revoked by something else", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);
      await SessionModel.updateOne({}, { $set: { revokedAt: new Date() } });

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      expect(response.status).toBe(200);
    });

    it("still clears the cookie when it revoked nothing", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(LOGOUT_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      expect(refreshSetCookie(response)).toContain("Expires=Thu, 01 Jan 1970");
    });

    // Answering differently would confirm which session ids are real.
    it("is indistinguishable from a real logout", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      const real = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const absent = await request(ctx.app).post(LOGOUT_PATH);
      const fabricated = await request(ctx.app)
        .post(LOGOUT_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      for (const response of [absent, fabricated]) {
        expect(response.status).toBe(real.status);
        expect(response.body.data).toEqual(real.body.data);
        expect(response.body.success).toBe(real.body.success);
      }
    });
  });

  // ---- the secret is the credential (ADR-013 §3) ----

  describe("a session id presented without its secret", () => {
    it("does not revoke the session", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      await signIn(ctx);
      const sessionId = (await SessionModel.findOne({}))!._id.toString();

      const response = await request(ctx.app)
        .post(LOGOUT_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=${sessionId}.a-secret-that-was-never-issued`);

      expect(response.status).toBe(200);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(1);
    });

    it("leaves that session able to keep refreshing", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);
      const sessionId = (await SessionModel.findOne({}))!._id.toString();

      await request(ctx.app)
        .post(LOGOUT_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=${sessionId}.a-secret-that-was-never-issued`);

      const refresh = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      expect(refresh.status).toBe(200);
    });
  });

  // ---- multiple devices (ADR-013 §6) ----

  describe("multiple devices", () => {
    it("signs out only the device that asked", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const laptop = await signIn(ctx);
      const phone = await signIn(ctx);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(2);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", laptop.cookie);

      // Named explicitly, not counted: both sessions belong to the same user,
      // so the guarantee is which one ended, not how many.
      expect((await SessionModel.findById(sessionIdOf(laptop.cookie)))!.revokedAt).not.toBeNull();
      expect((await SessionModel.findById(sessionIdOf(phone.cookie)))!.revokedAt).toBeNull();
    });

    it("leaves the other device able to refresh", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const laptop = await signIn(ctx);
      const phone = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", laptop.cookie);

      const phoneRefresh = await request(ctx.app).post(REFRESH_PATH).set("Cookie", phone.cookie);
      expect(phoneRefresh.status).toBe(200);

      const laptopRefresh = await request(ctx.app).post(REFRESH_PATH).set("Cookie", laptop.cookie);
      expect(laptopRefresh.status).toBe(401);
    });

    it("still lets the signed-out device sign in again", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);
      const again = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(again.status).toBe(200);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(1);
    });
  });

  // ---- request boundary ----

  describe("request boundary", () => {
    // ADR-013 §3: the credential is the cookie, and only the cookie.
    it("ignores a refresh token supplied in the body", async () => {
      const ctx = buildApp();
      await registeredAndVerified(ctx);
      const { cookie } = await signIn(ctx);
      const token = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length));

      const response = await request(ctx.app).post(LOGOUT_PATH).send({ refreshToken: token });

      expect(response.status).toBe(200);
      // Nothing was revoked, because no cookie was presented.
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(1);
    });

    it("accepts a request with no body at all", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(LOGOUT_PATH).set("Content-Type", "application/json");

      expect(response.status).toBe(200);
    });
  });
});
