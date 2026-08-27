import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  AUTHENTICATED_WRITE_LIMIT,
  CREDENTIAL_LIMIT,
  CREDENTIAL_WINDOW_MS,
  LOGIN_LOCK_DURATION_MS,
  LOGIN_MAX_FAILED_ATTEMPTS,
  SESSION_LIMIT,
  SESSION_WINDOW_MS,
} from "../src/config/constants";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider, extractToken } from "../src/modules/auth/testing/fakeEmailProvider";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const REFRESH_PATH = "/api/v1/auth/refresh";
const LOGOUT_PATH = "/api/v1/auth/logout";
const ME_PATH = "/api/v1/auth/me";
const ORGANIZATIONS_PATH = "/api/v1/organizations";

/** Obvious sentinels — if either reaches a response or a log, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

/**
 * Rate limiting (ADR-018).
 *
 * Every app here passes `rateLimiting: true`. The default is off under
 * NODE_ENV=test (ADR-018 §8) so suites written before this slice do not fail
 * for reasons unrelated to what they assert — this file is the opt-in that
 * exercises the real middleware, the real store, and the real refusal path.
 *
 * Each `buildApp()` gets its own limiter set, because `createApp` builds them
 * per instance. One test therefore cannot exhaust another's budget.
 */
function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider, rateLimiting: true }) };
}

type Ctx = ReturnType<typeof buildApp>;

/** An app with limiting off, to prove the flag is what differs. */
function buildUnlimitedApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider, rateLimiting: false }) };
}

async function registerAndVerify(ctx: Ctx, email: string) {
  await request(ctx.app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email, password: PASSWORD });
  const token = extractToken(ctx.fake.verifications.at(-1)!.verificationUrl)!;
  await request(ctx.app).post(VERIFY_PATH).send({ token });
}

const attemptLogin = (ctx: Ctx, email = EMAIL, password = PASSWORD) =>
  request(ctx.app).post(LOGIN_PATH).send({ email, password });

describe("rate limiting", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
    await SessionModel.init();
    await OrganizationModel.init();
    await MembershipModel.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([
      UserModel.deleteMany({}),
      AccountTokenModel.deleteMany({}),
      SessionModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- the limit itself ----

  describe("the credential class", () => {
    it("allows requests below the limit", async () => {
      const ctx = buildApp();

      // One short of the limit; the registration attempts themselves count.
      for (let i = 0; i < CREDENTIAL_LIMIT - 1; i += 1) {
        const response = await attemptLogin(ctx, `nobody${i}@example.com`);
        expect(response.status).not.toBe(429);
      }
    });

    it("refuses the request that crosses the limit", async () => {
      const ctx = buildApp();

      for (let i = 0; i < CREDENTIAL_LIMIT; i += 1) {
        await attemptLogin(ctx, `nobody${i}@example.com`);
      }
      const overLimit = await attemptLogin(ctx, "nobody-final@example.com");

      expect(overLimit.status).toBe(429);
    });

    it("uses the approved error envelope", async () => {
      const ctx = buildApp();
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      const response = await attemptLogin(ctx);

      expect(response.status).toBe(429);
      expect(Object.keys(response.body).sort()).toEqual(["error", "success"]);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatchObject({ code: "TOO_MANY_REQUESTS", version: "v1" });
      expect(response.body.error.requestId).toEqual(expect.any(String));
      expect(response.body.error.timestamp).toEqual(expect.any(String));
      // Not a validation failure; no field-level detail.
      expect(response.body.error).not.toHaveProperty("details");
    });

    /*
      The limit and window are LOGIN_MAX_FAILED_ATTEMPTS and
      LOGIN_LOCK_DURATION_MS, so the per-IP bound and the per-account lockout
      enforce one policy rather than two (ADR-018 §3). This is the assertion
      that fails if someone changes one without the other.
    */
    it("shares its numbers with the account lockout policy", () => {
      expect(CREDENTIAL_LIMIT).toBe(LOGIN_MAX_FAILED_ATTEMPTS);
      expect(CREDENTIAL_WINDOW_MS).toBe(LOGIN_LOCK_DURATION_MS);
    });

    it("names no limit, window, or route class in the response", async () => {
      const ctx = buildApp();
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      const response = await attemptLogin(ctx);

      /*
        Asserted against the CODE and MESSAGE rather than the whole serialized
        envelope. `meta` carries a request-id UUID and an ISO timestamp, and
        both are arbitrary digit strings — scanning them for `String(10)` made
        this assertion fail for the hour between 10:00 and 11:00 UTC every day,
        reporting a clock as a disclosure. The disclosure it exists to catch is
        the limiter naming its own policy (ADR-018 §6), and the only fields
        that could carry that are these two.
      */
      const disclosable = `${response.body.error.code} ${response.body.error.message}`;

      expect(disclosable).not.toContain("credential");
      expect(disclosable).not.toContain(String(CREDENTIAL_LIMIT));
      expect(disclosable).not.toContain(String(CREDENTIAL_WINDOW_MS));
      expect(response.body.error.message).not.toMatch(/limit|window|bucket|class/i);
      // The refusal itself is unchanged and still generic.
      expect(response.body.error.code).toBe("TOO_MANY_REQUESTS");
    });
  });

  // ---- the enumeration trap (ADR-018 §5) ----

  describe("account existence", () => {
    /*
      The counter is per-IP and NEVER per-email. A per-email counter would
      make the refusal depend on which address was submitted, which is an
      observable difference between an address under attack and one nobody
      has touched.
    */
    it("refuses a real account and an unknown one identically", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);

      // The budget is spent entirely on addresses that do not exist.
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      const realAccount = await attemptLogin(ctx, EMAIL, "wrong-password");
      const unknownAccount = await attemptLogin(ctx, "definitely-not-registered@example.com", "wrong-password");

      expect(realAccount.status).toBe(429);
      expect(unknownAccount.status).toBe(429);
      expect(realAccount.body.error.code).toBe(unknownAccount.body.error.code);
      expect(realAccount.body.error.message).toBe(unknownAccount.body.error.message);
    });

    it("does not give a known address its own budget", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);

      // Spend the whole budget on unknown addresses...
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      // ...and the known one is refused too. A per-email counter would have
      // left it with a full budget, which is the oracle.
      const response = await attemptLogin(ctx, EMAIL);
      expect(response.status).toBe(429);
    });

    it("refuses before revealing whether the password was right", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      // The correct password, refused by the limiter rather than answered.
      const response = await attemptLogin(ctx, EMAIL, PASSWORD);

      expect(response.status).toBe(429);
      expect(response.body.data).toBeUndefined();
      expect(response.headers["set-cookie"]).toBeUndefined();
    });
  });

  // ---- classes are distinct (ADR-018 §3) ----

  describe("limiter classes", () => {
    /*
      Credential endpoints are stricter than session endpoints, which are
      stricter than authenticated reads. This proves the routes carry
      different limiters rather than one shared bucket.
    */
    it("exhausts the credential class without exhausting the session class", async () => {
      const ctx = buildApp();

      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      expect((await attemptLogin(ctx)).status).toBe(429);
      // Refresh is a different class and still answers its own refusal.
      expect((await request(ctx.app).post(REFRESH_PATH)).status).toBe(401);
    });

    it("exhausts the credential class without exhausting authenticated reads", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const login = await attemptLogin(ctx);
      const accessToken = login.body.data.accessToken as string;

      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      expect((await attemptLogin(ctx)).status).toBe(429);
      const me = await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
    });

    it("makes authentication stricter than ordinary authenticated reads", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const accessToken = (await attemptLogin(ctx)).body.data.accessToken as string;

      // Comfortably past the credential limit, nowhere near the read limit.
      for (let i = 0; i < CREDENTIAL_LIMIT * 3; i += 1) {
        const me = await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`);
        expect(me.status).toBe(200);
      }
    });

    it("limits the session class on refresh", async () => {
      const ctx = buildApp();

      for (let i = 0; i < SESSION_LIMIT; i += 1) {
        const response = await request(ctx.app).post(REFRESH_PATH);
        expect(response.status).toBe(401);
      }
      const overLimit = await request(ctx.app).post(REFRESH_PATH);

      expect(overLimit.status).toBe(429);
    });

    it("shares the session budget across refresh, logout and logout-all", async () => {
      const ctx = buildApp();

      for (let i = 0; i < SESSION_LIMIT; i += 1) await request(ctx.app).post(LOGOUT_PATH);
      // Logout answers 200 unconditionally, so the budget is spent silently.
      const refreshed = await request(ctx.app).post(REFRESH_PATH);

      expect(refreshed.status).toBe(429);
    });

    it("limits authenticated writes by user", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const accessToken = (await attemptLogin(ctx)).body.data.accessToken as string;

      for (let i = 0; i < AUTHENTICATED_WRITE_LIMIT; i += 1) {
        const response = await request(ctx.app)
          .post(ORGANIZATIONS_PATH)
          .set("Authorization", `Bearer ${accessToken}`)
          .send({ name: `Org ${i}` });
        expect(response.status).toBe(201);
      }

      const overLimit = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "One Too Many" });

      expect(overLimit.status).toBe(429);
    });

    /*
      Keyed by user, not IP (ADR-018 §4): a second account from the same
      socket has its own budget, so an office behind one NAT is not one
      shared outage.
    */
    it("gives a second user their own write budget", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      await registerAndVerify(ctx, "grace@example.com");
      const ada = (await attemptLogin(ctx)).body.data.accessToken as string;
      const grace = (await attemptLogin(ctx, "grace@example.com")).body.data.accessToken as string;

      for (let i = 0; i < AUTHENTICATED_WRITE_LIMIT; i += 1) {
        await request(ctx.app)
          .post(ORGANIZATIONS_PATH)
          .set("Authorization", `Bearer ${ada}`)
          .send({ name: `Ada Org ${i}` });
      }

      expect(
        (
          await request(ctx.app)
            .post(ORGANIZATIONS_PATH)
            .set("Authorization", `Bearer ${ada}`)
            .send({ name: "Ada Over" })
        ).status,
      ).toBe(429);
      expect(
        (
          await request(ctx.app)
            .post(ORGANIZATIONS_PATH)
            .set("Authorization", `Bearer ${grace}`)
            .send({ name: "Grace First" })
        ).status,
      ).toBe(201);
    });
  });

  // ---- headers cannot buy a fresh budget (ADR-018 §7) ----

  describe("forged client headers", () => {
    /*
      `trust proxy` is off, so `req.ip` is the socket address and
      X-Forwarded-For is ignored entirely. If it were trusted, one line in a
      request would buy a fresh identity per call and every limit would be
      decorative.
    */
    it.each([
      ["X-Forwarded-For"],
      ["X-Real-IP"],
      ["Forwarded"],
      ["X-Client-IP"],
      ["True-Client-IP"],
      ["CF-Connecting-IP"],
    ])("cannot bypass the limit with a forged %s", async (header) => {
      const ctx = buildApp();

      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);
      expect((await attemptLogin(ctx)).status).toBe(429);

      // A different spoofed address on every attempt.
      for (let i = 0; i < 3; i += 1) {
        const response = await request(ctx.app)
          .post(LOGIN_PATH)
          .set(header, `203.0.113.${i}`)
          .send({ email: EMAIL, password: PASSWORD });
        expect(response.status).toBe(429);
      }
    });

    it("cannot bypass the limit by rotating several forwarding headers at once", async () => {
      const ctx = buildApp();
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      const response = await request(ctx.app)
        .post(LOGIN_PATH)
        .set("X-Forwarded-For", "198.51.100.7, 203.0.113.9")
        .set("X-Real-IP", "198.51.100.7")
        .set("Forwarded", "for=198.51.100.7")
        .send({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(429);
    });

    // The user-keyed classes must key on the VERIFIED token, not a header.
    it("cannot bypass a write limit with a forged user header", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const accessToken = (await attemptLogin(ctx)).body.data.accessToken as string;

      for (let i = 0; i < AUTHENTICATED_WRITE_LIMIT; i += 1) {
        await request(ctx.app)
          .post(ORGANIZATIONS_PATH)
          .set("Authorization", `Bearer ${accessToken}`)
          .send({ name: `Org ${i}` });
      }

      const response = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${accessToken}`)
        .set("X-User-Id", "507f1f77bcf86cd799439099")
        .send({ name: "Forged", userId: "507f1f77bcf86cd799439099" });

      expect(response.status).toBe(429);
    });
  });

  // ---- window behaviour ----

  describe("the window", () => {
    it("allows the limit exactly, and refuses one more", async () => {
      const ctx = buildApp();

      for (let i = 0; i < CREDENTIAL_LIMIT; i += 1) {
        expect((await attemptLogin(ctx, `nobody${i}@example.com`)).status).not.toBe(429);
      }
      expect((await attemptLogin(ctx, "one-more@example.com")).status).toBe(429);
    });

    it("sends Retry-After and RateLimit on a refusal", async () => {
      const ctx = buildApp();
      for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

      const response = await attemptLogin(ctx);

      expect(response.headers["retry-after"]).toBeDefined();
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(response.headers["ratelimit-policy"] ?? response.headers.ratelimit).toBeDefined();
    });

    // Two spellings of one fact is one too many (ADR-018 §6).
    it("sends no legacy X-RateLimit headers", async () => {
      const ctx = buildApp();
      const response = await attemptLogin(ctx, "nobody@example.com");

      expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(response.headers["x-ratelimit-remaining"]).toBeUndefined();
    });

    /*
      The window resets. Time is advanced rather than waited out — a real
      fifteen-minute wait is not a test.

      Deliberately exercised on `POST /refresh` with no cookie, which
      `refresh.service.ts` rejects before any database call. The store's
      expiry runs on a `setInterval` created when the app is built, so the
      fake clock has to be installed FIRST — and doing that around Mongo
      would fight mongoose's own timers for no benefit. This route touches
      neither.
    */
    it("lets a caller through again once the window has passed", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const ctx = buildApp();

      for (let i = 0; i < SESSION_LIMIT; i += 1) {
        expect((await request(ctx.app).post(REFRESH_PATH)).status).toBe(401);
      }
      expect((await request(ctx.app).post(REFRESH_PATH)).status).toBe(429);

      await vi.advanceTimersByTimeAsync(SESSION_WINDOW_MS * 2 + 1000);

      // Refused by the credential check again rather than by the limiter,
      // which is the budget having rolled over.
      expect((await request(ctx.app).post(REFRESH_PATH)).status).toBe(401);
      vi.useRealTimers();
    });

    it("handles concurrent requests without exceeding the limit", async () => {
      const ctx = buildApp();

      // Fired together rather than in sequence.
      const responses = await Promise.all(
        Array.from({ length: CREDENTIAL_LIMIT + 5 }, (_, i) => attemptLogin(ctx, `nobody${i}@example.com`)),
      );

      const allowed = responses.filter((r) => r.status !== 429).length;
      const refused = responses.filter((r) => r.status === 429).length;

      expect(allowed).toBeLessThanOrEqual(CREDENTIAL_LIMIT);
      expect(refused).toBeGreaterThan(0);
      expect(allowed + refused).toBe(CREDENTIAL_LIMIT + 5);
    });
  });

  // ---- the flag, and normal behaviour under limits ----

  describe("with limiting disabled", () => {
    it("does not refuse past the limit", async () => {
      const ctx = buildUnlimitedApp();

      for (let i = 0; i < CREDENTIAL_LIMIT + 5; i += 1) {
        const response = await request(ctx.app)
          .post(LOGIN_PATH)
          .send({ email: `nobody${i}@example.com`, password: PASSWORD });
        expect(response.status).not.toBe(429);
      }
    });

    it("sets no rate-limit headers", async () => {
      const ctx = buildUnlimitedApp();

      const response = await request(ctx.app).post(LOGIN_PATH).send({ email: EMAIL, password: PASSWORD });

      expect(response.headers["ratelimit-policy"]).toBeUndefined();
      expect(response.headers["retry-after"]).toBeUndefined();
    });
  });

  /*
    The whole authenticated surface, exercised WITH limiting on, so "existing
    behaviour is intact" is proved under the configuration production runs
    rather than only under the one tests default to.
  */
  describe("existing behaviour under an enabled limiter", () => {
    it("completes register, verify, login, me, organization, refresh, logout", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);

      const login = await attemptLogin(ctx);
      expect(login.status).toBe(200);
      const accessToken = login.body.data.accessToken as string;
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

      const me = await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe(EMAIL);

      const created = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "Acme Corp" });
      expect(created.status).toBe(201);

      const context = await request(ctx.app)
        .get(`${ORGANIZATIONS_PATH}/${created.body.data.organization.id}`)
        .set("Authorization", `Bearer ${accessToken}`);
      expect(context.status).toBe(200);
      expect(context.body.data.role).toBe("owner");

      const refreshed = await request(ctx.app).post(REFRESH_PATH).set("Cookie", cookie);
      expect(refreshed.status).toBe(200);
      const rotated = (refreshed.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

      const loggedOut = await request(ctx.app).post(LOGOUT_PATH).set("Cookie", rotated);
      expect(loggedOut.status).toBe(200);
      expect((await request(ctx.app).post(REFRESH_PATH).set("Cookie", rotated)).status).toBe(401);
    });

    it("does not block a normal dashboard session", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx, EMAIL);
      const accessToken = (await attemptLogin(ctx)).body.data.accessToken as string;

      // Twenty page loads: /me plus an organization context each time.
      const created = await request(ctx.app)
        .post(ORGANIZATIONS_PATH)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "Acme" });
      const organizationId = created.body.data.organization.id as string;

      for (let i = 0; i < 20; i += 1) {
        expect((await request(ctx.app).get(ME_PATH).set("Authorization", `Bearer ${accessToken}`)).status).toBe(200);
        expect(
          (
            await request(ctx.app)
              .get(`${ORGANIZATIONS_PATH}/${organizationId}`)
              .set("Authorization", `Bearer ${accessToken}`)
          ).status,
        ).toBe(200);
      }
    });
  });

  // ---- the limiter must not become a leak (ADR-018 §10) ----

  it("leaks no credential material in a refusal", async () => {
    const ctx = buildApp();
    for (let i = 0; i <= CREDENTIAL_LIMIT; i += 1) await attemptLogin(ctx, `nobody${i}@example.com`);

    const response = await attemptLogin(ctx, EMAIL, PASSWORD);

    expect(response.text).not.toContain(PASSWORD);
    expect(response.text).not.toContain(EMAIL);
    expect(response.text).not.toContain("$argon2");
  });
});
