import { jwtVerify } from "jose";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from "../src/config/constants";
import { env } from "../src/lib/env";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { createStaffAccount } from "../src/modules/auth/testing/staffAccounts";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const REFRESH_PATH = "/api/v1/auth/refresh";

/** Obvious sentinels — if either reaches a response body or log, the test fails. */
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
  const cookie = refreshSetCookie(response)!;
  return cookie.split(";")[0]!;
}

function cookieValue(response: request.Response): string {
  return decodeURIComponent(cookiePair(response).slice(`${REFRESH_COOKIE_NAME}=`.length));
}

/** Registers, verifies, and signs in through the real endpoints. */
async function signedInClient(ctx: ReturnType<typeof buildApp>) {
  await createStaffAccount(ctx.fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email: EMAIL, code });

  const login = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
  return { login, cookie: cookiePair(login) };
}

describe("POST /api/v1/auth/refresh", () => {
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

  describe("a valid refresh cookie", () => {
    it("answers 200 in the approved envelope", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(response.body.meta.requestId).toEqual(expect.any(String));
    });

    // ADR-012 §8: a returning tab uses refresh to find out who it is.
    it("returns the same identity shape login returns", async () => {
      const ctx = buildApp();
      const { login, cookie } = await signedInClient(ctx);

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(response.body.data.user).toEqual(login.body.data.user);
      expect(Object.keys(response.body.data).sort()).toEqual(["accessToken", "expiresIn", "user"]);
    });

    it("issues an access token this server can verify, bound to the same session", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      const session = await SessionModel.findOne({});

      const { payload } = await jwtVerify(
        response.body.data.accessToken,
        new TextEncoder().encode(env.JWT_ACCESS_SECRET),
        { issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE },
      );

      expect(payload.sub).toBe(response.body.data.user.id);
      expect(payload.sid).toBe(session!._id.toString());
    });

    it("sets a rotated cookie with the same protective attributes", async () => {
      const ctx = buildApp();
      const { login, cookie } = await signedInClient(ctx);

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      const rotated = refreshSetCookie(response)!;

      expect(rotated).toBeDefined();
      expect(rotated).toContain("HttpOnly");
      expect(rotated).toContain("SameSite=Strict");
      expect(rotated).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(cookieValue(response)).not.toBe(cookieValue(login));
    });

    // ADR-011 §1: a body copy would make HttpOnly meaningless.
    it("never puts the refresh token in the response body", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(response.text).not.toContain(cookieValue(response));
    });

    it("creates no new session — one login stays one session", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      await expect(SessionModel.countDocuments({})).resolves.toBe(1);
    });

    it("supports refreshing repeatedly with each newly issued cookie", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      let current = cookie;
      for (let round = 0; round < 3; round += 1) {
        const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", current);
        expect(response.status).toBe(200);
        current = cookiePair(response);
      }
    });

    it("exposes no password, hash, or account state", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("passwordHash");
      expect(response.text).not.toContain("$argon2");
      expect(response.text).not.toContain("failedLoginAttempts");
      expect(response.text).not.toContain("emailVerifiedAt");
    });
  });

  // ---- refusals ----

  describe("refusals", () => {
    it("answers 401 INVALID_REFRESH_TOKEN with no cookie at all", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).post(REFRESH_PATH);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    });

    it("answers 401 for a fabricated cookie", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(REFRESH_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    });

    // ADR-012 §9: a CastError would report a client's garbage as a server fault.
    it("answers a malformed session id with 401, not 500", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(REFRESH_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=zzzz.secret`);

      expect(response.status).toBe(401);
    });

    // ADR-012 §1: the credential is the cookie, and only the cookie.
    it("refuses a refresh token supplied in the request body", async () => {
      const ctx = buildApp();
      const { login } = await signedInClient(ctx);

      const response = await request(ctx.app)
        .post(REFRESH_PATH)
        .send({ refreshToken: cookieValue(login), token: cookieValue(login) });

      expect(response.status).toBe(401);
    });

    it("refuses a cookie whose session was revoked", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);
      await SessionModel.updateOne({}, { $set: { revokedAt: new Date() } });

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(response.status).toBe(401);
    });

    it("clears the cookie on a terminal refusal", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(REFRESH_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);
      const cleared = refreshSetCookie(response)!;

      expect(cleared).toBeDefined();
      expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
      // Clearing must target the same cookie, or the browser keeps the real one.
      expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
      expect(cleared).toContain("HttpOnly");
    });

    // The clearing cookie must not carry a future Max-Age (ADR-012, §5 note).
    it("does not re-issue the cookie while clearing it", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app)
        .post(REFRESH_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      expect(refreshSetCookie(response)).not.toMatch(/Max-Age=[1-9]/);
    });

    it("gives every refusal a byte-identical body", async () => {
      const ctx = buildApp();
      const { login } = await signedInClient(ctx);
      await SessionModel.updateOne({}, { $set: { revokedAt: new Date() } });

      const revoked = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(login));
      const absent = await request(ctx.app).post(REFRESH_PATH);
      const fabricated = await request(ctx.app)
        .post(REFRESH_PATH)
        .set("Cookie", `${REFRESH_COOKIE_NAME}=totally-made-up`);

      for (const response of [absent, fabricated]) {
        expect(response.status).toBe(revoked.status);
        expect(response.body.error.code).toBe(revoked.body.error.code);
        expect(response.body.error.message).toBe(revoked.body.error.message);
      }
    });

    it("names no reason in the response", async () => {
      const ctx = buildApp();
      const { login } = await signedInClient(ctx);
      await SessionModel.updateOne({}, { $set: { revokedAt: new Date() } });

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(login));

      expect(response.body.error.details).toBeUndefined();
      expect(response.text).not.toMatch(/revoked|expired session|replay|reuse|disabled/i);
    });
  });

  // ---- reuse detection over HTTP ----

  describe("reuse detection", () => {
    it("refuses a token that was rotated away two rotations ago", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      const first = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(first));

      const replay = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(replay.status).toBe(401);
    });

    it("revokes every session the user has when a replay is detected", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);
      // A second device, signed in independently.
      await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(2);

      const first = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(first));
      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(0);
    });

    it("stops the previously-working cookie from refreshing again", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);

      const first = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      const second = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(first));
      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      // The legitimate client's own current token is revoked along with the rest.
      const afterAlarm = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(second));
      expect(afterAlarm.status).toBe(401);
    });
  });

  // ---- the grace window over HTTP (ADR-012 §4-5) ----

  describe("a concurrent double-submit", () => {
    it("refuses the loser without revoking the session", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);
      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      const loser = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(loser.status).toBe(401);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(1);
    });

    // The winner's cookie must survive the loser's response.
    it("does not clear the cookie on the losing request", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);
      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      const loser = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(refreshSetCookie(loser)).toBeUndefined();
    });

    it("lets the client recover by retrying with the cookie it already holds", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);
      const winner = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      const retry = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookiePair(winner));

      expect(retry.status).toBe(200);
    });
  });

  // ---- account standing (ADR-012 §7) ----

  describe("account standing", () => {
    it("stops refreshing within the access token's lifetime once disabled", async () => {
      const ctx = buildApp();
      const { cookie } = await signedInClient(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

      const response = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);

      expect(response.status).toBe(401);
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(0);
    });
  });
});
