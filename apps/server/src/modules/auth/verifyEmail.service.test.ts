import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "../../config/constants";
import { generateSecret, sha256 } from "../../lib/crypto/tokens";
import { InvalidVerificationTokenError } from "../../lib/errors";
import { AccountTokenModel } from "../accountTokens/accountToken.model";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";
import { UserModel } from "../users/user.model";
import { userRepository } from "../users/user.repository";
import { createFakeEmailProvider } from "./testing/fakeEmailProvider";
import { createStaffAccount } from "./testing/staffAccounts";
import { createVerificationService } from "./verification.service";

import type { AuthLogger } from "./authLogging";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
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
  const log: AuthLogger = { info: record, error: record };
  return {
    log,
    serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n"),
  };
}

function buildServices() {
  const fake = createFakeEmailProvider();
  return {
    fake,
    verification: createVerificationService({ emailProvider: fake.provider }),
  };
}

/** Creates an unverified staff account and returns the six-digit code from the captured email. */
async function registerAndGetCode(services: ReturnType<typeof buildServices>, email = EMAIL) {
  const user = await createStaffAccount(services.fake.provider, { name: "Ada Lovelace", email, password: PASSWORD });
  const code = services.fake.verifications.at(-1)!.code;
  return { user, code };
}

/** A six-digit value that is not `code`. Never the real one, always well-formed. */
function wrongCode(code = ""): string {
  return code === "000000" ? "111111" : "000000";
}

async function storedUser(email = EMAIL) {
  return UserModel.findOne({ email });
}

/** Every token document for a user, including spent ones. */
async function allTokens(userId: string) {
  return AccountTokenModel.find({ userId, purpose: "email_verification" });
}

async function outstandingCount(userId: string) {
  return AccountTokenModel.countDocuments({ userId, purpose: "email_verification", consumedAt: null });
}

describe("Email verification consumption", () => {
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

  // ---- the happy path ----

  describe("valid token", () => {
    it("resolves and sets emailVerifiedAt", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);

      const before = Date.now();
      await expect(services.verification.verifyEmail({ email: EMAIL, code })).resolves.toBeUndefined();
      const after = Date.now();

      const user = await storedUser();
      expect(user!.emailVerifiedAt).not.toBeNull();
      const verifiedAt = user!.emailVerifiedAt!.getTime();
      expect(verifiedAt).toBeGreaterThanOrEqual(before);
      expect(verifiedAt).toBeLessThanOrEqual(after);
    });

    it("marks the redeemed token consumed rather than deleting it", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      await services.verification.verifyEmail({ email: EMAIL, code });

      // ADR-005 §6: the spent token survives so a replay stays
      // distinguishable from a fabrication.
      const tokens = await allTokens(user.id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.consumedAt).not.toBeNull();
    });

    it("leaves no outstanding token behind", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      await services.verification.verifyEmail({ email: EMAIL, code });

      expect(await outstandingCount(user.id)).toBe(0);
    });

    it("deletes other outstanding tokens for the same user", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      // A second live token, as the ADR-008 §3 concurrency window allows.
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(generateSecret()),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });
      expect(await outstandingCount(user.id)).toBe(2);

      await services.verification.verifyEmail({ email: EMAIL, code });

      expect(await outstandingCount(user.id)).toBe(0);
    });

    it("does not touch another user's tokens or verified state", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      const other = await registerAndGetCode(services, "grace@example.com");

      await services.verification.verifyEmail({ email: EMAIL, code });

      expect(await outstandingCount(other.user.id)).toBe(1);
      expect((await storedUser("grace@example.com"))!.emailVerifiedAt).toBeNull();
    });

    it("does not touch the user's password-reset tokens", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "password_reset",
        tokenHash: sha256(generateSecret()),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });

      await services.verification.verifyEmail({ email: EMAIL, code });

      expect(await AccountTokenModel.countDocuments({ userId: user.id, purpose: "password_reset" })).toBe(1);
    });

    it("changes nothing else about the user", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      const before = await UserModel.findOne({ email: EMAIL }).select("+passwordHash");

      await services.verification.verifyEmail({ email: EMAIL, code });

      const after = await UserModel.findOne({ email: EMAIL }).select("+passwordHash");
      expect(after!.email).toBe(before!.email);
      expect(after!.name).toBe(before!.name);
      expect(after!.passwordHash).toBe(before!.passwordHash);
      expect(after!.status).toBe("active");
      expect(after!.failedLoginAttempts).toBe(0);
      expect(after!.lockedUntil).toBeNull();
    });
  });

  // ---- rejection, all identical (ADR-009 §1) ----

  describe("rejected tokens", () => {
    it("rejects a token that never existed", async () => {
      const services = buildServices();
      await registerAndGetCode(services);

      await expect(services.verification.verifyEmail({ email: EMAIL, code: wrongCode() })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
    });

    it("rejects an arbitrary non-token string", async () => {
      const services = buildServices();
      await expect(services.verification.verifyEmail({ email: EMAIL, code: wrongCode() })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
    });

    it("rejects an expired token", async () => {
      const services = buildServices();
      const { user } = await registerAndGetCode(services);

      const expiredSecret = generateSecret();
      await AccountTokenModel.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(expiredSecret),
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(services.verification.verifyEmail({ email: EMAIL, code: expiredSecret })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
      expect((await storedUser())!.emailVerifiedAt).toBeNull();
    });

    it("rejects an already-consumed token", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      await services.verification.verifyEmail({ email: EMAIL, code });

      await expect(services.verification.verifyEmail({ email: EMAIL, code })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
    });

    // ADR-005 §3: purpose lives in the consumption predicate, so a
    // password-reset token cannot be redeemed here.
    it("rejects a token issued for a different purpose", async () => {
      const services = buildServices();
      const { user } = await registerAndGetCode(services);

      const resetSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "password_reset",
        tokenHash: sha256(resetSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });

      await expect(services.verification.verifyEmail({ email: EMAIL, code: resetSecret })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
      expect((await storedUser())!.emailVerifiedAt).toBeNull();
      // The reset token must survive: this endpoint may not spend it.
      expect(
        await AccountTokenModel.countDocuments({ userId: user.id, purpose: "password_reset", consumedAt: null }),
      ).toBe(1);
    });

    it("rejects a token whose user no longer exists", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      await UserModel.deleteOne({ _id: user.id });

      await expect(services.verification.verifyEmail({ email: EMAIL, code })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
    });

    it("gives every rejection the identical message", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      const expiredSecret = generateSecret();
      await AccountTokenModel.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(expiredSecret),
        expiresAt: new Date(Date.now() - 1000),
      });
      await services.verification.verifyEmail({ email: EMAIL, code });

      const messages = await Promise.all(
        [wrongCode(code), expiredSecret, code].map((candidate) =>
          services.verification.verifyEmail({ email: EMAIL, code: candidate }).catch((err: unknown) => ({
            code: (err as InvalidVerificationTokenError).code,
            status: (err as InvalidVerificationTokenError).httpStatus,
            message: (err as Error).message,
          })),
        ),
      );

      expect(new Set(messages.map((m) => JSON.stringify(m))).size).toBe(1);
      expect(messages[0]).toMatchObject({ code: "INVALID_VERIFICATION_TOKEN", status: 400 });
    });

    it("does not reveal expiry, consumption state, or account existence in the message", async () => {
      const services = buildServices();
      const error = await services.verification
        .verifyEmail({ email: EMAIL, code: wrongCode() })
        .then(() => null)
        .catch((err: unknown) => err as Error);

      expect(error).not.toBeNull();
      expect(error!.message).not.toMatch(/expired at|consumed|already|user|account|exist/i);
      expect(JSON.stringify(error)).not.toContain("userId");
    });
  });

  // ---- already verified (ADR-009 §5) ----

  describe("already-verified account", () => {
    it("resolves rather than throwing when a valid token is redeemed twice over", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      // A second live token, then verify with the first.
      const secondSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(secondSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });
      await services.verification.verifyEmail({ email: EMAIL, code });

      // Re-create a live token to stand in for one that outlived cleanup.
      const thirdSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(thirdSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });

      await expect(services.verification.verifyEmail({ email: EMAIL, code: thirdSecret })).resolves.toBeUndefined();
    });

    it("does not move the original verification timestamp", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      await services.verification.verifyEmail({ email: EMAIL, code });
      const firstTimestamp = (await storedUser())!.emailVerifiedAt!.getTime();

      const laterSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(laterSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });
      await services.verification.verifyEmail({ email: EMAIL, code: laterSecret });

      expect((await storedUser())!.emailVerifiedAt!.getTime()).toBe(firstTimestamp);
    });

    it("still clears outstanding tokens", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      await services.verification.verifyEmail({ email: EMAIL, code });

      const leftover = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(leftover),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });

      await services.verification.verifyEmail({ email: EMAIL, code: leftover });

      expect(await outstandingCount(user.id)).toBe(0);
    });

    it("does not refund the spent token", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      await services.verification.verifyEmail({ email: EMAIL, code });

      const secondSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(secondSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });
      await services.verification.verifyEmail({ email: EMAIL, code: secondSecret });

      // Presenting it again must fail — it was consumed, not returned.
      await expect(services.verification.verifyEmail({ email: EMAIL, code: secondSecret })).rejects.toBeInstanceOf(
        InvalidVerificationTokenError,
      );
    });
  });

  // ---- concurrency ----

  describe("concurrency", () => {
    /**
     * Deterministic by construction: the consume predicate is a single
     * atomic findOneAndUpdate, so of N callers presenting one token exactly
     * one can match `consumedAt: null` (ADR-005 §4).
     */
    it("lets exactly one of many concurrent redemptions of one token succeed", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => services.verification.verifyEmail({ email: EMAIL, code })),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
      for (const rejected of results.filter((r) => r.status === "rejected")) {
        expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(InvalidVerificationTokenError);
      }

      expect(await outstandingCount(user.id)).toBe(0);
      expect((await storedUser())!.emailVerifiedAt).not.toBeNull();
    });

    /**
     * Two distinct valid tokens — the bounded state ADR-008 §3 tolerates.
     * Both consume successfully, so the set-once guarantee has to come from
     * the update predicate rather than from the token.
     */
    it("sets emailVerifiedAt once when two distinct valid tokens race", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      const secondSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(secondSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });

      const results = await Promise.allSettled([
        services.verification.verifyEmail({ email: EMAIL, code }),
        services.verification.verifyEmail({ email: EMAIL, code: secondSecret }),
      ]);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const verified = (await storedUser())!.emailVerifiedAt;
      expect(verified).not.toBeNull();
      expect(await outstandingCount(user.id)).toBe(0);
    });

    /**
     * Forces the losing branch deterministically instead of relying on
     * scheduling: the update predicate misses because the account was
     * verified in between.
     */
    it("keeps the earlier timestamp when the set-once update loses", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      const original = new Date(Date.now() - 60_000);
      const markSpy = vi.spyOn(userRepository, "markEmailVerified").mockImplementation(async (id) => {
        // Simulate the winner landing first.
        await UserModel.updateOne({ _id: id }, { $set: { emailVerifiedAt: original } });
        return null;
      });

      await expect(services.verification.verifyEmail({ email: EMAIL, code })).resolves.toBeUndefined();

      expect(markSpy).toHaveBeenCalled();
      expect((await storedUser())!.emailVerifiedAt!.getTime()).toBe(original.getTime());
      expect(await outstandingCount(user.id)).toBe(0);
    });

    it("never re-verifies through the repository predicate", async () => {
      const services = buildServices();
      const { user } = await registerAndGetCode(services);
      const first = new Date(Date.now() - 60_000);
      await UserModel.updateOne({ _id: user.id }, { $set: { emailVerifiedAt: first } });

      const result = await userRepository.markEmailVerified(user.id, new Date());

      expect(result).toBeNull();
      expect((await storedUser())!.emailVerifiedAt!.getTime()).toBe(first.getTime());
    });
  });

  // ---- resilience ----

  describe("cleanup failure", () => {
    it("still verifies the account when clearing tokens fails", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      vi.spyOn(accountTokenRepository, "invalidateOutstandingForUser").mockRejectedValue(new Error("boom"));
      const capture = createCapturingLogger();

      await expect(services.verification.verifyEmail({ email: EMAIL, code }, capture.log)).resolves.toBeUndefined();

      expect((await storedUser())!.emailVerifiedAt).not.toBeNull();
      expect(capture.serialized()).toContain("auth.verify_email.cleanup_failed");
    });
  });

  // ---- secrecy ----

  describe("secrecy", () => {
    it("never logs the submitted code or its hash", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      const capture = createCapturingLogger();

      await services.verification.verifyEmail({ email: EMAIL, code }, capture.log);

      const logged = capture.serialized();
      /*
        Quoted, because a bare six-digit string is short enough to collide by
        chance with digits inside an ObjectId or a timestamp — a false pass
        would be bad, but a flaky false FAILURE on a secrecy test is what
        gets a suite muted. The JSON-quoted form is what a logged value would
        actually look like.
      */
      expect(logged).not.toContain(`"${code}"`);
      expect(logged).not.toContain(sha256(code));
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain(PASSWORD);
    });

    it("never logs a rejected token", async () => {
      const services = buildServices();
      const capture = createCapturingLogger();
      const attempted = generateSecret();

      await services.verification.verifyEmail({ email: EMAIL, code: attempted }, capture.log).catch(() => undefined);

      expect(capture.serialized()).not.toContain(attempted);
      expect(capture.serialized()).not.toContain(sha256(attempted));
    });

    it("returns nothing at all", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);

      expect(await services.verification.verifyEmail({ email: EMAIL, code })).toBeUndefined();
    });
  });
});
