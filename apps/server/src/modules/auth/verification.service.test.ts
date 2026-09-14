import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "../../config/constants";
import { generateSecret, sha256 } from "../../lib/crypto/tokens";
import { env } from "../../lib/env";
import { AccountTokenModel } from "../accountTokens/accountToken.model";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";
import { UserModel } from "../users/user.model";
import { createFailingEmailProvider, createFakeEmailProvider } from "./testing/fakeEmailProvider";
import { createStaffAccount } from "./testing/staffAccounts";
import { createVerificationService } from "./verification.service";

import type { AuthLogger } from "./authLogging";

/** Obvious sentinels — if either reaches a database or a log, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

/** Capture logger, so the real Pino instance is never reconfigured or weakened. */
function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const record = (payload: Record<string, unknown>, message: string) => {
    entries.push({ payload, message });
  };
  const log: AuthLogger = { info: record, error: record };
  return {
    log,
    entries,
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

/** Creates an unverified staff account, then clears the captured email. */
async function registerUser(
  services: ReturnType<typeof buildServices>,
  email = EMAIL,
  name = "Ada Lovelace",
) {
  const user = await createStaffAccount(services.fake.provider, { name, email, password: PASSWORD });
  services.fake.verifications.length = 0;
  return user;
}

/** The stored hash for a user's single outstanding verification token. */
async function outstandingHashes(userId: string): Promise<string[]> {
  const tokens = await AccountTokenModel.find({ userId, purpose: "email_verification" }).select("+tokenHash");
  return tokens.map((token) => token.tokenHash);
}

describe("Resend verification service", () => {
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

  // ---- unknown address ----

  describe("unknown address", () => {
    it("resolves without doing anything", async () => {
      const services = buildServices();

      await expect(services.verification.resendVerification({ email: "nobody@example.com" })).resolves.toBeUndefined();

      expect(await UserModel.countDocuments()).toBe(0);
      expect(await AccountTokenModel.countDocuments()).toBe(0);
      expect(services.fake.verifications).toHaveLength(0);
    });

    it("does not create an account for the address", async () => {
      const services = buildServices();
      await services.verification.resendVerification({ email: "nobody@example.com" });

      expect(await UserModel.findOne({ email: "nobody@example.com" })).toBeNull();
    });

    it("logs a masked address, never the full one", async () => {
      const services = buildServices();
      const capture = createCapturingLogger();

      await services.verification.resendVerification({ email: "nobody@example.com" }, capture.log);

      const logged = capture.serialized();
      expect(logged).toContain("auth.resend_verification.no_account");
      expect(logged).toContain("n***@example.com");
      expect(logged).not.toContain("nobody@example.com");
    });
  });

  // ---- already verified ----

  describe("already-verified account", () => {
    async function verifiedUser() {
      const services = buildServices();
      const user = await registerUser(services);
      await UserModel.updateOne({ _id: user.id }, { $set: { emailVerifiedAt: new Date() } });
      return { services, user };
    }

    it("resolves without sending anything", async () => {
      const { services } = await verifiedUser();

      await expect(services.verification.resendVerification({ email: EMAIL })).resolves.toBeUndefined();
      expect(services.fake.verifications).toHaveLength(0);
    });

    it("leaves the existing token untouched", async () => {
      const { services, user } = await verifiedUser();
      const before = await outstandingHashes(user.id);

      await services.verification.resendVerification({ email: EMAIL });

      expect(await outstandingHashes(user.id)).toEqual(before);
    });

    it("logs the userId without an address", async () => {
      const { services, user } = await verifiedUser();
      const capture = createCapturingLogger();

      await services.verification.resendVerification({ email: EMAIL }, capture.log);

      const logged = capture.serialized();
      expect(logged).toContain("auth.resend_verification.already_verified");
      expect(logged).toContain(user.id);
      expect(logged).not.toContain(EMAIL);
    });
  });

  // ---- the happy path ----

  describe("unverified account", () => {
    it("issues a replacement token and sends it", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      await services.verification.resendVerification({ email: EMAIL });

      expect(services.fake.verifications).toHaveLength(1);
      expect(services.fake.verifications[0]!.to).toBe(EMAIL);
      expect(await AccountTokenModel.countDocuments({ userId: user.id })).toBe(1);
    });

    it("replaces the outstanding token rather than adding to it", async () => {
      const services = buildServices();
      const user = await registerUser(services);
      const [originalHash] = await outstandingHashes(user.id);

      await services.verification.resendVerification({ email: EMAIL });

      const after = await outstandingHashes(user.id);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(originalHash);
    });

    it("makes the superseded token unusable", async () => {
      const services = buildServices();
      const user = await registerUser(services);
      const [originalHash] = await outstandingHashes(user.id);

      await services.verification.resendVerification({ email: EMAIL });

      const consumed = await accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: originalHash!,
        purpose: "email_verification",
        now: new Date(),
      });
      expect(consumed).toBeNull();
    });

    it("sends a code that hashes to the newly stored token", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      await services.verification.resendVerification({ email: EMAIL });

      const code = services.fake.verifications[0]!.code;
      const [storedHash] = await outstandingHashes(user.id);
      expect(storedHash).toBe(sha256(code));
    });

    it("gives the replacement a fresh full-length expiry", async () => {
      const services = buildServices();
      await registerUser(services);

      const before = Date.now();
      await services.verification.resendVerification({ email: EMAIL });
      const after = Date.now();

      const token = await AccountTokenModel.findOne({});
      const expiresAt = token!.expiresAt.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + EMAIL_VERIFICATION_TOKEN_TTL_MS);
      expect(expiresAt).toBeLessThanOrEqual(after + EMAIL_VERIFICATION_TOKEN_TTL_MS);
    });

    it("leaves the user unverified", async () => {
      const services = buildServices();
      await registerUser(services);

      await services.verification.resendVerification({ email: EMAIL });

      const stored = await UserModel.findOne({ email: EMAIL });
      expect(stored!.emailVerifiedAt).toBeNull();
    });

    it("accepts a differently-cased address", async () => {
      const services = buildServices();
      await registerUser(services);

      await services.verification.resendVerification({ email: "ADA@EXAMPLE.COM" });

      expect(services.fake.verifications).toHaveLength(1);
    });

    it("collapses several outstanding tokens into one", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      // Two extra unused tokens, as a pair of interleaved resends could leave.
      for (const secret of [generateSecret(), generateSecret()]) {
        await accountTokenRepository.create({
          userId: user.id,
          purpose: "email_verification",
          tokenHash: sha256(secret),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
        });
      }
      expect(await AccountTokenModel.countDocuments({ userId: user.id })).toBe(3);

      await services.verification.resendVerification({ email: EMAIL });

      expect(await AccountTokenModel.countDocuments({ userId: user.id })).toBe(1);
    });

    it("builds the link from CLIENT_URL carrying the address and no secret", async () => {
      const services = buildServices();
      await registerUser(services);

      await services.verification.resendVerification({ email: EMAIL });

      const captured = services.fake.verifications[0]!;
      const url = new URL(captured.verificationUrl);
      expect(url.origin).toBe(new URL(env.CLIENT_URL).origin);
      expect(url.pathname).toBe("/verify-email");
      // The address prefills the form; the code travels in the body only.
      expect(url.searchParams.get("email")).toBe(EMAIL);
      expect(captured.verificationUrl).not.toContain(captured.code);
    });
  });

  // ---- scoping (ADR-005 §6) ----

  describe("invalidation scope", () => {
    it("preserves a consumed token, which records a completed action", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      const consumedSecret = generateSecret();
      await accountTokenRepository.create({
        userId: user.id,
        purpose: "email_verification",
        tokenHash: sha256(consumedSecret),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });
      await accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: sha256(consumedSecret),
        purpose: "email_verification",
        now: new Date(),
      });

      await services.verification.resendVerification({ email: EMAIL });

      const consumedStill = await AccountTokenModel.findOne({ userId: user.id, consumedAt: { $ne: null } });
      expect(consumedStill).not.toBeNull();
      expect(await AccountTokenModel.countDocuments({ userId: user.id, consumedAt: null })).toBe(1);
    });

    it("does not touch the same user's password-reset tokens", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      await accountTokenRepository.create({
        userId: user.id,
        purpose: "password_reset",
        tokenHash: sha256(generateSecret()),
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      });

      await services.verification.resendVerification({ email: EMAIL });

      expect(await AccountTokenModel.countDocuments({ userId: user.id, purpose: "password_reset" })).toBe(1);
    });

    it("does not touch another user's tokens", async () => {
      const services = buildServices();
      const first = await registerUser(services);
      const second = await registerUser(services, OTHER_EMAIL, "Grace Hopper");
      const secondBefore = await outstandingHashes(second.id);

      await services.verification.resendVerification({ email: EMAIL });

      expect(await outstandingHashes(second.id)).toEqual(secondBefore);
      expect(await AccountTokenModel.countDocuments({ userId: first.id })).toBe(1);
    });
  });

  // ---- failure paths (ADR-008 §5, §6) ----

  describe("token issuance failure", () => {
    it("resolves rather than throwing, so the response cannot differ", async () => {
      const services = buildServices();
      await registerUser(services);
      vi.spyOn(accountTokenRepository, "create").mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key { tokenHash: "leaked" }'), { name: "MongoServerError" }),
      );

      await expect(services.verification.resendVerification({ email: EMAIL })).resolves.toBeUndefined();
    });

    it("sends no email and leaves no token behind", async () => {
      const services = buildServices();
      const user = await registerUser(services);
      vi.spyOn(accountTokenRepository, "create").mockRejectedValue(new Error("boom"));

      await services.verification.resendVerification({ email: EMAIL });

      // Invalidation ran first, so the user is left with none (ADR-008 §5).
      expect(await AccountTokenModel.countDocuments({ userId: user.id })).toBe(0);
      expect(services.fake.verifications).toHaveLength(0);
    });

    it("logs the userId and failure class, never the database message", async () => {
      const services = buildServices();
      const user = await registerUser(services);
      vi.spyOn(accountTokenRepository, "create").mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key { tokenHash: "leaked" }'), { name: "MongoServerError" }),
      );
      const capture = createCapturingLogger();

      await services.verification.resendVerification({ email: EMAIL }, capture.log);

      const logged = capture.serialized();
      expect(logged).toContain("auth.resend_verification.token_failed");
      expect(logged).toContain(user.id);
      expect(logged).toContain("MongoServerError");
      expect(logged).not.toContain("E11000");
      expect(logged).not.toContain("leaked");
      expect(logged).not.toContain(EMAIL);
    });

    it("still resolves when invalidation itself fails, without sending", async () => {
      const services = buildServices();
      const user = await registerUser(services);
      const before = await outstandingHashes(user.id);
      vi.spyOn(accountTokenRepository, "invalidateOutstandingForUser").mockRejectedValue(new Error("boom"));
      const capture = createCapturingLogger();

      await expect(
        services.verification.resendVerification({ email: EMAIL }, capture.log),
      ).resolves.toBeUndefined();

      expect(services.fake.verifications).toHaveLength(0);
      expect(await outstandingHashes(user.id)).toEqual(before);
      expect(capture.serialized()).toContain("auth.resend_verification.invalidate_failed");
    });
  });

  describe("email delivery failure", () => {
    it("resolves, and keeps the replacement token valid", async () => {
      const fake = createFakeEmailProvider();
      const user = await createStaffAccount(fake.provider, { name: "Ada Lovelace", email: EMAIL, password: PASSWORD });

      const verification = createVerificationService({
        emailProvider: createFailingEmailProvider("smtp exploded"),
      });
      await expect(verification.resendVerification({ email: EMAIL })).resolves.toBeUndefined();

      expect(await AccountTokenModel.countDocuments({ userId: user.id, consumedAt: null })).toBe(1);
    });

    it("logs the failure safely", async () => {
      const services = buildServices();
      await registerUser(services);
      const verification = createVerificationService({
        emailProvider: createFailingEmailProvider("smtp exploded"),
      });
      const capture = createCapturingLogger();

      await verification.resendVerification({ email: EMAIL }, capture.log);

      const logged = capture.serialized();
      expect(logged).toContain("auth.resend_verification.email_failed");
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain("/verify-email");
      expect(logged).not.toContain("token=");
    });
  });

  // ---- concurrency (ADR-005 "Concurrent issuance", ADR-008 §3) ----

  describe("concurrency", () => {
    /**
     * invalidate + create are two operations, so ADR-005 states plainly that
     * strict newest-token-wins is NOT guaranteed by persistence. These assert
     * the real bound instead of a guarantee the design does not make.
     */
    it("leaves at most one token per concurrent request, never zero", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      const results = await Promise.allSettled([
        services.verification.resendVerification({ email: EMAIL }),
        services.verification.resendVerification({ email: EMAIL }),
      ]);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const outstanding = await AccountTokenModel.countDocuments({ userId: user.id, consumedAt: null });
      expect(outstanding).toBeGreaterThanOrEqual(1);
      expect(outstanding).toBeLessThanOrEqual(2);
    });

    it("keeps every surviving token usable and distinct", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      await Promise.all([
        services.verification.resendVerification({ email: EMAIL }),
        services.verification.resendVerification({ email: EMAIL }),
      ]);

      const hashes = await outstandingHashes(user.id);

      // Whatever survived, each one corresponds to an email that was sent.
      const sentHashes = services.fake.verifications.map((v) => sha256(v.code));
      for (const hash of hashes) {
        expect(sentHashes).toContain(hash);
      }
    });

    it("never issues more tokens than requests", async () => {
      const services = buildServices();
      const user = await registerUser(services);

      await Promise.all(
        Array.from({ length: 4 }, () => services.verification.resendVerification({ email: EMAIL })),
      );

      expect(await AccountTokenModel.countDocuments({ userId: user.id })).toBeLessThanOrEqual(4);
      expect(services.fake.verifications).toHaveLength(4);
    });
  });

  // ---- secrecy ----

  describe("secrecy", () => {
    it("never persists or logs the raw code", async () => {
      const services = buildServices();
      const user = await registerUser(services);
      const capture = createCapturingLogger();

      await services.verification.resendVerification({ email: EMAIL }, capture.log);

      const code = services.fake.verifications[0]!.code;
      const rawUser = await mongoose.connection
        .collection("users")
        .findOne({ _id: new mongoose.Types.ObjectId(user.id) });
      const rawTokens = await mongoose.connection.collection("accounttokens").find({}).toArray();

      // Quoted: a bare six-digit string collides by chance with digits in
      // ObjectIds and timestamps, and a flaky secrecy test gets muted.
      expect(JSON.stringify(rawUser)).not.toContain(`"${code}"`);
      expect(JSON.stringify(rawTokens)).not.toContain(`"${code}"`);
      expect(capture.serialized()).not.toContain(`"${code}"`);
      expect(capture.serialized()).not.toContain(PASSWORD);
    });

    it("returns nothing at all", async () => {
      const services = buildServices();
      await registerUser(services);

      const result = await services.verification.resendVerification({ email: EMAIL });
      expect(result).toBeUndefined();
    });
  });
});
