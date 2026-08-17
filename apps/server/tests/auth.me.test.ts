import { SignJWT } from "jose";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, REFRESH_COOKIE_NAME } from "../src/config/constants";
import { env } from "../src/lib/env";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider, extractToken } from "../src/modules/auth/testing/fakeEmailProvider";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const LOGOUT_PATH = "/api/v1/auth/logout";
const LOGOUT_ALL_PATH = "/api/v1/auth/logout-all";
const REFRESH_PATH = "/api/v1/auth/refresh";
const ME_PATH = "/api/v1/auth/me";

/** Obvious sentinels — if either reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";
const NAME = "Ada Lovelace";

const key = () => new TextEncoder().encode(env.JWT_ACCESS_SECRET);

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

type Ctx = ReturnType<typeof buildApp>;

async function registerAndVerify(ctx: Ctx, email: string, name = NAME) {
  await request(ctx.app).post(REGISTER_PATH).send({ name, email, password: PASSWORD });
  const token = extractToken(ctx.fake.verifications.at(-1)!.verificationUrl)!;
  await request(ctx.app).post(VERIFY_PATH).send({ token });
}

function cookiePair(response: request.Response): string {
  const cookies = response.headers["set-cookie"] as unknown as string[] | undefined;
  return cookies!.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`))!.split(";")[0]!;
}

/** Signs in and returns everything that sign-in produced. */
async function signIn(ctx: Ctx, email = EMAIL) {
  const login = await request(ctx.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return {
    accessToken: login.body.data.accessToken as string,
    userId: login.body.data.user.id as string,
    cookie: cookiePair(login),
  };
}

const authorized = (ctx: Ctx, accessToken: string) =>
  request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`);

/** Mints a token directly, so one claim at a time can be made wrong. */
async function signToken({
  sub,
  sid = "507f191e810c19729de860ea",
  issuer = ACCESS_TOKEN_ISSUER,
  audience = ACCESS_TOKEN_AUDIENCE,
  expiresIn = "15m",
  signingKey = key(),
}: {
  sub: string;
  sid?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  signingKey?: Uint8Array;
}): Promise<string> {
  return new SignJWT({ sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signingKey);
}

describe("GET /api/v1/auth/me", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
    await SessionModel.init();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AccountTokenModel.deleteMany({}), SessionModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- the ordinary case ----

  describe("a valid access token", () => {
    it("answers 200 in the approved envelope", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);

      const response = await authorized(ctx, accessToken);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.meta).toMatchObject({ version: "v1" });
      expect(response.body.meta.requestId).toEqual(expect.any(String));
      expect(Object.keys(response.body).sort()).toEqual(["data", "meta", "success"]);
    });

    it("returns the user who signed in", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken, userId } = await signIn(ctx);

      const response = await authorized(ctx, accessToken);

      expect(response.body.data.user).toMatchObject({ id: userId, name: NAME, email: EMAIL });
    });

    it("returns the account's state and timestamps", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);

      const { user } = (await authorized(ctx, accessToken)).body.data;

      expect(user.status).toBe("active");
      expect(Date.parse(user.emailVerifiedAt)).not.toBeNaN();
      expect(Date.parse(user.createdAt)).not.toBeNaN();
    });

    it("carries exactly the approved fields", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);

      const { user } = (await authorized(ctx, accessToken)).body.data;

      expect(Object.keys(user).sort()).toEqual([
        "createdAt",
        "email",
        "emailVerifiedAt",
        "id",
        "name",
        "status",
      ]);
    });

    /*
      Two accounts exist and each token resolves to its own. The load-bearing
      version of "returns the user who signed in": a response that ignored the
      subject would pass that test and fail this one.
    */
    it("resolves each token to its own user", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL, "Ada Lovelace");
      await registerAndVerify(ctx, OTHER_EMAIL, "Grace Hopper");
      const ada = await signIn(ctx, EMAIL);
      const grace = await signIn(ctx, OTHER_EMAIL);

      const adaResponse = await authorized(ctx, ada.accessToken);
      const graceResponse = await authorized(ctx, grace.accessToken);

      expect(adaResponse.body.data.user.email).toBe(EMAIL);
      expect(adaResponse.body.data.user.name).toBe("Ada Lovelace");
      expect(graceResponse.body.data.user.email).toBe(OTHER_EMAIL);
      expect(graceResponse.body.data.user.name).toBe("Grace Hopper");
    });

    it("can be called repeatedly with the same answer", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);

      const first = await authorized(ctx, accessToken);
      const second = await authorized(ctx, accessToken);

      expect(second.status).toBe(200);
      expect(second.body.data).toEqual(first.body.data);
    });
  });

  // ---- what must never appear in the response ----

  describe("the response body", () => {
    it("exposes no credential or lockout state", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      // Give the account lockout state worth leaking.
      await UserModel.updateOne({ email: EMAIL }, { $set: { failedLoginAttempts: 4 } });
      const { accessToken } = await signIn(ctx);

      const response = await authorized(ctx, accessToken);
      const { user } = response.body.data;

      for (const field of [
        "passwordHash",
        "password",
        "failedLoginAttempts",
        "loginFailureCount",
        "lockedUntil",
        "lockout",
        "currentRefreshTokenHash",
        "previousRefreshTokenHashes",
        "refreshTokenHash",
        "sessions",
        "__v",
        "_id",
      ]) {
        expect(user).not.toHaveProperty(field);
      }
      expect(response.text).not.toContain(PASSWORD);
      expect(response.text).not.toContain("$argon2");
      expect(response.text).not.toMatch(/passwordHash|lockedUntil|failedLoginAttempts/i);
    });

    // ADR-015 §12: a read of identity, not a credential endpoint.
    it("returns no token of any kind", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken, cookie } = await signIn(ctx);
      const refreshToken = decodeURIComponent(cookie.slice(`${REFRESH_COOKIE_NAME}=`.length));

      const response = await authorized(ctx, accessToken);

      expect(response.text).not.toContain(accessToken);
      expect(response.text).not.toContain(refreshToken);
      expect(response.body.data).not.toHaveProperty("accessToken");
      expect(response.body.data).not.toHaveProperty("refreshToken");
      expect(response.body.data).not.toHaveProperty("token");
      // And it does not re-issue the cookie either.
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    // ADR-015 §9: nothing creates a Membership, so any organization field
    // would be null for every caller.
    it("carries no organization, role, or permission data", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);

      const response = await authorized(ctx, accessToken);

      for (const field of ["organizationId", "organization", "role", "memberships", "permissions"]) {
        expect(response.body.data.user).not.toHaveProperty(field);
      }
    });
  });

  // ---- refusals: every one of them a 401 in the same envelope ----

  describe("refusals", () => {
    /** Builds the header variants that must all be refused before a token is even parsed. */
    async function refusalCases(ctx: Ctx, userId: string): Promise<[label: string, header?: string][]> {
      const { accessToken } = await signIn(ctx);
      const [header, payload, signature] = accessToken.split(".");

      return [
        ["no Authorization header", undefined],
        ["an empty Authorization header", ""],
        ["a bare token with no scheme", accessToken],
        ["the Basic scheme", `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64")}`],
        ["Bearer with no credential", "Bearer"],
        ["a tampered signature", `Bearer ${header}.${payload}.${signature!.slice(0, -4)}AAAA`],
        ["a token signed with another secret", `Bearer ${await signToken({ sub: userId, signingKey: new TextEncoder().encode("a-different-secret-of-sufficient-length") })}`],
        ["an expired token", `Bearer ${await signToken({ sub: userId, expiresIn: "-1s" })}`],
        ["a token from another issuer", `Bearer ${await signToken({ sub: userId, issuer: "not-serviqo" })}`],
        ["a token minted for the widget audience", `Bearer ${await signToken({ sub: userId, audience: "serviqo-widget" })}`],
        ["a token for a user who does not exist", `Bearer ${await signToken({ sub: "507f1f77bcf86cd799439099" })}`],
      ];
    }

    it("answers 401 for every kind of bad credential", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { userId } = await signIn(ctx);

      for (const [label, header] of await refusalCases(ctx, userId)) {
        const call = request(ctx.app).get(ME_PATH);
        const response = await (header === undefined ? call : call.set("Authorization", header));

        expect(response.status, label).toBe(401);
        expect(response.body.success, label).toBe(false);
      }
    });

    /*
      ADR-015 §6. If any branch were distinguishable — a different code, a
      different message, a `details` array — this is where it would show.
      "Expired" is the one that reads harmless and is refused with the rest.
    */
    it("makes no refusal distinguishable from another", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { userId } = await signIn(ctx);

      const bodies: string[] = [];
      for (const [, header] of await refusalCases(ctx, userId)) {
        const call = request(ctx.app).get(ME_PATH);
        const response = await (header === undefined ? call : call.set("Authorization", header));
        bodies.push(JSON.stringify({ code: response.body.error.code, message: response.body.error.message }));
      }

      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0]!).code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("uses the existing failure envelope", async () => {
      const ctx = buildApp();

      const response = await request(ctx.app).get(ME_PATH);

      expect(Object.keys(response.body).sort()).toEqual(["error", "success"]);
      expect(response.body.error).toMatchObject({
        code: "INVALID_ACCESS_TOKEN",
        message: expect.any(String),
        version: "v1",
      });
      expect(response.body.error.requestId).toEqual(expect.any(String));
      expect(response.body.error.timestamp).toEqual(expect.any(String));
      // No field-level detail: this is not a validation failure.
      expect(response.body.error).not.toHaveProperty("details");
    });

    it("never echoes the credential it refused", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);
      const tampered = `${accessToken.slice(0, -4)}AAAA`;

      const response = await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${tampered}`);

      expect(response.text).not.toContain(tampered);
      expect(response.text).not.toContain(accessToken.split(".")[2]);
    });
  });

  // ---- the account gate (ADR-015 §7) ----

  describe("an account that changed after the token was issued", () => {
    it("refuses a disabled user, whose token is otherwise perfectly valid", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);
      // The token still verifies; the account is what changed.
      expect((await authorized(ctx, accessToken)).status).toBe(200);

      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

      const response = await authorized(ctx, accessToken);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("exposes nothing about the disabled account it refused", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

      const response = await authorized(ctx, accessToken);

      expect(response.text).not.toContain(EMAIL);
      expect(response.text).not.toContain(NAME);
      expect(response.text).not.toMatch(/disabled|suspended|inactive/i);
    });

    it("refuses a user deleted mid-session", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken } = await signIn(ctx);

      await UserModel.deleteMany({});

      expect((await authorized(ctx, accessToken)).status).toBe(401);
    });

    // Disabled and deleted must be one answer, or a token becomes a probe for
    // account state.
    it("answers a disabled and a deleted account identically", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const disabled = await signIn(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });
      const disabledResponse = await authorized(ctx, disabled.accessToken);

      await UserModel.deleteMany({});
      const deletedResponse = await authorized(ctx, disabled.accessToken);

      expect(deletedResponse.status).toBe(disabledResponse.status);
      expect(deletedResponse.body.error.code).toBe(disabledResponse.body.error.code);
      expect(deletedResponse.body.error.message).toBe(disabledResponse.body.error.message);
    });
  });

  // ---- ADR-010: this endpoint is staff-only, permanently ----

  describe("principal types (ADR-010 §5)", () => {
    /*
      No customer credential exists yet, so this test constructs the closest
      thing to one: a token signed with the CORRECT key, for a real user, under
      a widget audience. The audience claim is the only thing refusing it —
      which is the whole point of ADR-010 §5 requiring the claim before the
      second principal type exists.
    */
    it("refuses a correctly-signed token whose audience is not the dashboard", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { userId } = await signIn(ctx);

      const widgetToken = await signToken({ sub: userId, audience: "serviqo-widget" });

      const response = await authorized(ctx, widgetToken);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_ACCESS_TOKEN");
    });

    it("accepts the same subject under the dashboard audience", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { userId } = await signIn(ctx);

      // Identical but for `aud`, so the audience is provably the deciding claim.
      const dashboardToken = await signToken({ sub: userId });

      expect((await authorized(ctx, dashboardToken)).status).toBe(200);
    });
  });

  // ---- identity is never taken from the request (ADR-015 §11) ----

  describe("client-supplied identity", () => {
    it("ignores a userId in the query string", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL, "Ada Lovelace");
      await registerAndVerify(ctx, OTHER_EMAIL, "Grace Hopper");
      const ada = await signIn(ctx, EMAIL);
      const grace = await signIn(ctx, OTHER_EMAIL);

      const response = await request(ctx.app)
        .get(`${ME_PATH}?userId=${grace.userId}&id=${grace.userId}&email=${OTHER_EMAIL}`)
        .set("Authorization", `Bearer ${ada.accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.user.id).toBe(ada.userId);
      expect(response.body.data.user.email).toBe(EMAIL);
    });

    it("ignores a userId, email, name, role, and organizationId in the body", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL, "Ada Lovelace");
      await registerAndVerify(ctx, OTHER_EMAIL, "Grace Hopper");
      const ada = await signIn(ctx, EMAIL);
      const grace = await signIn(ctx, OTHER_EMAIL);

      const response = await request(ctx.app)
        .get(ME_PATH)
        .set("Authorization", `Bearer ${ada.accessToken}`)
        .send({
          userId: grace.userId,
          email: OTHER_EMAIL,
          name: "Grace Hopper",
          role: "owner",
          organizationId: "507f1f77bcf86cd799439011",
          status: "disabled",
        });

      expect(response.status).toBe(200);
      expect(response.body.data.user).toMatchObject({ id: ada.userId, email: EMAIL, name: "Ada Lovelace" });
      expect(response.body.data.user.status).toBe("active");
      expect(response.body.data.user).not.toHaveProperty("role");
      expect(response.body.data.user).not.toHaveProperty("organizationId");
    });

    // The refresh cookie is not a credential for this route. A browser sends
    // it on same-origin auth calls, and it must not stand in for a token.
    it("refuses a request carrying only the refresh cookie", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { cookie } = await signIn(ctx);

      const response = await request(ctx.app).get(ME_PATH).set("Cookie", cookie);

      expect(response.status).toBe(401);
    });
  });

  // ---- the fifteen-minute window, stated as a test (ADR-015 §8) ----

  describe("session revocation", () => {
    /*
      Deliberate and documented: the access token outlives the session it names
      by up to ACCESS_TOKEN_TTL_MS. This test exists so the behaviour is
      asserted rather than discovered, and so changing it is a decision someone
      makes on purpose — it would fail loudly.
    */
    it("still answers after the session was revoked by logout", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken, cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_PATH).set("Cookie", cookie);

      // The refresh credential is dead...
      expect((await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie)).status).toBe(401);
      // ...and the access token is not, until it expires.
      expect((await authorized(ctx, accessToken)).status).toBe(200);
    });

    it("still answers after logout-all, for the same reason", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken, cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);

      expect((await authorized(ctx, accessToken)).status).toBe(200);
    });

    // Disabling the account is the control that IS immediate — the asymmetry
    // ADR-015 §8 draws between the account and the session.
    it("stops immediately when the account is disabled, unlike revocation", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const { accessToken, cookie } = await signIn(ctx);

      await request(ctx.app).post(LOGOUT_ALL_PATH).set("Cookie", cookie);
      expect((await authorized(ctx, accessToken)).status).toBe(200);

      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });
      expect((await authorized(ctx, accessToken)).status).toBe(401);
    });
  });

  // ---- the token issued by refresh works here too ----

  it("accepts an access token minted by the refresh endpoint", async () => {
    const ctx = buildApp();
    await registerAndVerify(ctx, EMAIL);
    const { cookie } = await signIn(ctx);

    const refreshed = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
    const response = await authorized(ctx, refreshed.body.data.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe(EMAIL);
  });

  // Only GET is defined. Anything else must be a clean 404 rather than a 500
  // or an accidental match on another handler.
  it("is not reachable by POST", async () => {
    const ctx = buildApp();
    await registerAndVerify(ctx, EMAIL);
    const { accessToken } = await signIn(ctx);

    const response = await request(ctx.app).post(ME_PATH).set("Authorization", `Bearer ${accessToken}`);

    expect(response.status).toBe(404);
  });
});
