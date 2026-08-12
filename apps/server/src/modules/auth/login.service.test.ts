import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOGIN_MAX_FAILED_ATTEMPTS, SESSION_TTL_MS } from "../../config/constants";
import { hashPassword } from "../../lib/crypto/password";
import { sha256 } from "../../lib/crypto/tokens";
import { EmailNotVerifiedError, InvalidCredentialsError } from "../../lib/errors";
import { SessionModel } from "../sessions/session.model";
import { UserModel } from "../users/user.model";
import { createLoginService } from "./login.service";
import { REFRESH_TOKEN_SEPARATOR } from "./refreshToken";

import type { AuthLogger } from "./authLogging";

/** Obvious sentinels — if either reaches a database, response, or log, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const WRONG_PASSWORD = "DO_NOT_LEAK_THIS_WRONG_PASSWORD";
const EMAIL = "ada@example.com";

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const record = (payload: Record<string, unknown>, message: string) => {
    entries.push({ payload, message });
  };
  return {
    log: { info: record, error: record } satisfies AuthLogger,
    entries,
    serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n"),
  };
}

/**
 * Argon2id is deliberately expensive, so the fixture password is hashed once
 * for the whole file rather than per user.
 */
let passwordHash: string;

interface SeedOptions {
  verified?: boolean;
  status?: "active" | "disabled";
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
}

async function seedUser({
  verified = true,
  status = "active",
  failedLoginAttempts = 0,
  lockedUntil = null,
}: SeedOptions = {}) {
  return UserModel.create({
    name: "Ada Lovelace",
    email: EMAIL,
    passwordHash,
    emailVerifiedAt: verified ? new Date() : null,
    status,
    failedLoginAttempts,
    lockedUntil,
  });
}

const service = () => createLoginService();
const credentials = { email: EMAIL, password: PASSWORD };

describe("Login service", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await SessionModel.init();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), SessionModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- success ----

  describe("valid credentials", () => {
    it("returns the user's identity and nothing about their account state", async () => {
      const user = await seedUser();

      const result = await service().login(credentials, {});

      expect(result.user).toEqual({ id: user._id.toString(), name: "Ada Lovelace", email: EMAIL });
    });

    it("creates exactly one Session for the user", async () => {
      const user = await seedUser();

      await service().login(credentials, {});

      const sessions = await SessionModel.find({ userId: user._id });
      expect(sessions).toHaveLength(1);
    });

    it("stores only the SHA-256 of the refresh secret, never the secret", async () => {
      await seedUser();

      const result = await service().login(credentials, {});
      const secret = result.refreshToken.slice(result.refreshToken.indexOf(REFRESH_TOKEN_SEPARATOR) + 1);

      const raw = await mongoose.connection.collection("sessions").findOne({});
      expect(raw!.currentRefreshTokenHash).toBe(sha256(secret));
      expect(JSON.stringify(raw)).not.toContain(secret);
    });

    it("routes the refresh token by the new session's id (ADR-004 §2)", async () => {
      await seedUser();

      const result = await service().login(credentials, {});
      const session = await SessionModel.findOne({});

      const sessionId = result.refreshToken.slice(0, result.refreshToken.indexOf(REFRESH_TOKEN_SEPARATOR));
      expect(sessionId).toBe(session!._id.toString());
    });

    it("starts the session with no rotation history", async () => {
      await seedUser();

      await service().login(credentials, {});

      const raw = await mongoose.connection.collection("sessions").findOne({});
      expect(raw!.previousRefreshTokenHashes).toEqual([]);
      expect(raw!.lastRotatedAt).toBeNull();
    });

    it("expires the session after the configured lifetime", async () => {
      await seedUser();
      const before = Date.now();

      await service().login(credentials, {});

      const session = await SessionModel.findOne({});
      const ttl = session!.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 5000);
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_MS + 5000);
    });

    it("records the User-Agent when the boundary supplies one", async () => {
      await seedUser();

      await service().login(credentials, { userAgent: "Mozilla/5.0 (test)" });

      expect((await SessionModel.findOne({}))!.userAgent).toBe("Mozilla/5.0 (test)");
    });

    it("succeeds when no User-Agent is available", async () => {
      await seedUser();

      await expect(service().login(credentials, {})).resolves.toBeDefined();
      expect((await SessionModel.findOne({}))!.userAgent).toBeUndefined();
    });

    it("issues an access token and reports its lifetime", async () => {
      await seedUser();

      const result = await service().login(credentials, {});

      expect(result.accessToken.split(".")).toHaveLength(3);
      expect(result.expiresIn).toBeGreaterThan(0);
    });

    it("clears lockout state left over from earlier failures", async () => {
      await seedUser({ failedLoginAttempts: 3 });

      await service().login(credentials, {});

      const user = await UserModel.findOne({});
      expect(user!.failedLoginAttempts).toBe(0);
      expect(user!.lockedUntil).toBeNull();
    });

    it("accepts the address in any casing, through the model's own rule", async () => {
      await seedUser();

      await expect(service().login({ email: "ADA@Example.COM", password: PASSWORD }, {})).resolves.toBeDefined();
    });
  });

  // ---- generic failures (ADR-011 §3) ----

  describe("credential failures", () => {
    it("rejects an unknown address", async () => {
      await expect(service().login(credentials, {})).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it("rejects an incorrect password", async () => {
      await seedUser();

      await expect(
        service().login({ email: EMAIL, password: WRONG_PASSWORD }, {}),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it("rejects a disabled account even with the correct password", async () => {
      await seedUser({ status: "disabled" });

      await expect(service().login(credentials, {})).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it("rejects a locked account even with the correct password", async () => {
      await seedUser({ lockedUntil: new Date(Date.now() + 60_000) });

      await expect(service().login(credentials, {})).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it("accepts a correct password once the lock has expired", async () => {
      await seedUser({ lockedUntil: new Date(Date.now() - 1000) });

      await expect(service().login(credentials, {})).resolves.toBeDefined();
    });

    // The whole point of §3: none of these branches may be distinguishable.
    it("answers every failure with the same code and message", async () => {
      const messages: string[] = [];

      const collect = async (input: { email: string; password: string }) => {
        try {
          await service().login(input, {});
        } catch (err) {
          messages.push(`${(err as InvalidCredentialsError).code}:${(err as Error).message}`);
        }
      };

      await collect(credentials); // unknown address
      await seedUser({ status: "disabled" });
      await collect(credentials); // disabled
      await UserModel.deleteMany({});
      await seedUser();
      await collect({ email: EMAIL, password: WRONG_PASSWORD }); // wrong password
      await UserModel.deleteMany({});
      await seedUser({ lockedUntil: new Date(Date.now() + 60_000) });
      await collect(credentials); // locked

      expect(messages).toHaveLength(4);
      expect(new Set(messages).size).toBe(1);
    });

    it("creates no session on any failure", async () => {
      await seedUser({ status: "disabled" });

      await expect(service().login(credentials, {})).rejects.toThrow();

      expect(await SessionModel.countDocuments({})).toBe(0);
    });
  });

  // ---- timing equalization (ADR-011 §4) ----

  describe("unknown address", () => {
    /**
     * Argon2id at 19 MiB reliably costs tens of milliseconds; an indexed
     * lookup that found nothing costs single-digit milliseconds. A generous
     * floor is enough to prove the dummy verification actually ran — without
     * it, response time is an account-existence oracle regardless of what the
     * status code says.
     */
    it("spends password-verification work even though no account exists", async () => {
      const svc = service();
      // Warm the dummy hash so this measures the verify, not its one-time
      // construction.
      await expect(svc.login(credentials, {})).rejects.toThrow();

      const startedAt = Date.now();
      await expect(svc.login(credentials, {})).rejects.toThrow();
      expect(Date.now() - startedAt).toBeGreaterThan(15);
    });
  });

  // ---- unverified (ADR-011 §6) ----

  describe("unverified account", () => {
    it("is refused specifically, because resend-verification is the remedy", async () => {
      await seedUser({ verified: false });

      await expect(service().login(credentials, {})).rejects.toBeInstanceOf(EmailNotVerifiedError);
    });

    it("is still refused generically when the password is wrong", async () => {
      await seedUser({ verified: false });

      await expect(
        service().login({ email: EMAIL, password: WRONG_PASSWORD }, {}),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it("creates no session", async () => {
      await seedUser({ verified: false });

      await expect(service().login(credentials, {})).rejects.toThrow();
      expect(await SessionModel.countDocuments({})).toBe(0);
    });
  });

  // ---- lockout (ADR-011 §7) ----

  describe("lockout", () => {
    it("counts each failed attempt", async () => {
      await seedUser();

      await expect(service().login({ email: EMAIL, password: WRONG_PASSWORD }, {})).rejects.toThrow();

      expect((await UserModel.findOne({}))!.failedLoginAttempts).toBe(1);
    });

    it("locks the account on the configured attempt and resets the counter", async () => {
      await seedUser({ failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 1 });

      await expect(service().login({ email: EMAIL, password: WRONG_PASSWORD }, {})).rejects.toThrow();

      const user = await UserModel.findOne({});
      expect(user!.lockedUntil).not.toBeNull();
      // Reset, so an expired lock grants a fresh budget rather than
      // re-locking on the very next mistake.
      expect(user!.failedLoginAttempts).toBe(0);
    });

    // Otherwise an attacker holds someone else's account locked forever by
    // continuing to guess.
    it("does not extend a lock when more attempts arrive", async () => {
      const lockedUntil = new Date(Date.now() + 60_000);
      await seedUser({ lockedUntil });

      await expect(service().login({ email: EMAIL, password: WRONG_PASSWORD }, {})).rejects.toThrow();

      const user = await UserModel.findOne({});
      expect(user!.lockedUntil!.getTime()).toBe(lockedUntil.getTime());
      expect(user!.failedLoginAttempts).toBe(0);
    });
  });

  // ---- logging ----

  describe("logging", () => {
    it("never logs the password, the refresh secret, or the access token", async () => {
      await seedUser();
      const capture = createCapturingLogger();

      const result = await service().login(credentials, { userAgent: "Mozilla/5.0 (test)" }, capture.log);

      const logged = capture.serialized();
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain(result.refreshToken);
      expect(logged).not.toContain(result.accessToken);
    });

    it("logs a masked address, never a full one, when no account exists", async () => {
      const capture = createCapturingLogger();

      await expect(service().login(credentials, {}, capture.log)).rejects.toThrow();

      const logged = capture.serialized();
      expect(logged).not.toContain(EMAIL);
      expect(logged).toContain("a***@example.com");
    });

    it("records the reason server-side even though the response does not", async () => {
      await seedUser({ status: "disabled" });
      const capture = createCapturingLogger();

      await expect(service().login(credentials, {}, capture.log)).rejects.toThrow();

      expect(capture.entries.at(-1)!.payload).toMatchObject({
        event: "auth.login.failed",
        reason: "account_disabled",
      });
    });

    it("correlates a success with both the user and the session", async () => {
      const user = await seedUser();
      const capture = createCapturingLogger();

      await service().login(credentials, {}, capture.log);
      const session = await SessionModel.findOne({});

      expect(capture.entries.at(-1)!.payload).toEqual({
        event: "auth.login.succeeded",
        userId: user._id.toString(),
        sessionId: session!._id.toString(),
      });
    });
  });

  // ---- serialization boundary ----

  describe("result", () => {
    it("carries no password hash and no lockout state", async () => {
      await seedUser({ failedLoginAttempts: 2 });

      const result = await service().login(credentials, {});

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(passwordHash);
      expect(serialized).not.toContain("failedLoginAttempts");
      expect(serialized).not.toContain("lockedUntil");
      expect(serialized).not.toContain("status");
    });
  });
});
