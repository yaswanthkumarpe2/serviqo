import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "../../config/constants";
import { verifyPassword } from "../../lib/crypto/password";
import { sha256 } from "../../lib/crypto/tokens";
import { env } from "../../lib/env";
import { EmailAlreadyExistsError } from "../../lib/errors";
import { AccountTokenModel } from "../accountTokens/accountToken.model";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";
import { UserModel } from "../users/user.model";
import { userRepository } from "../users/user.repository";
import { createRegistrationService } from "./registration.service";
import { createFailingEmailProvider, createFakeEmailProvider } from "./testing/fakeEmailProvider";

import type { AuthLogger } from "./authLogging";

/** Obvious sentinels — if either reaches a database, response, or log, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

const validInput = { name: "Ada Lovelace", email: EMAIL, password: PASSWORD };

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

/** Capture logger, so the real Pino instance is never reconfigured or weakened. */
function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const log: AuthLogger = {
    info(payload, message) {
      entries.push({ payload, message });
    },
    error(payload, message) {
      entries.push({ payload, message });
    },
  };
  return { log, entries, serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n") };
}

function buildService() {
  const fake = createFakeEmailProvider();
  return { fake, service: createRegistrationService({ emailProvider: fake.provider }) };
}

/** The raw document, bypassing every Mongoose transform and `select: false`. */
async function rawUserDocument() {
  return mongoose.connection.collection("users").findOne({});
}

async function rawAccountTokenDocuments() {
  return mongoose.connection.collection("accounttokens").find({}).toArray();
}

describe("Registration service", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Uniqueness assertions must run against real, built indexes.
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

  // ---- user persistence ----

  describe("user persistence", () => {
    it("creates the user and returns the safe DTO", async () => {
      const { service } = buildService();
      const user = await service.register(validInput);

      expect(user).toEqual({
        id: expect.any(String),
        name: "Ada Lovelace",
        email: EMAIL,
        emailVerified: false,
      });
    });

    it("leaves the user unverified", async () => {
      const { service } = buildService();
      await service.register(validInput);

      const stored = await UserModel.findOne({ email: EMAIL });
      expect(stored?.emailVerifiedAt).toBeNull();
    });

    it("keeps the schema default status of active", async () => {
      const { service } = buildService();
      await service.register(validInput);

      const stored = await UserModel.findOne({ email: EMAIL });
      expect(stored?.status).toBe("active");
      expect(stored?.failedLoginAttempts).toBe(0);
      expect(stored?.lockedUntil).toBeNull();
    });

    it("normalizes the stored email through the User model", async () => {
      const { service } = buildService();
      const user = await service.register({ ...validInput, email: "  Ada@Example.COM  " });

      expect(user.email).toBe(EMAIL);
      expect(await UserModel.findOne({ email: EMAIL })).not.toBeNull();
    });

    it("stores a hash, not the password", async () => {
      const { service } = buildService();
      await service.register(validInput);

      const stored = await UserModel.findOne({ email: EMAIL }).select("+passwordHash");
      expect(stored?.passwordHash).toBeDefined();
      expect(stored?.passwordHash).not.toBe(PASSWORD);
      expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it("stores a hash the password actually verifies against", async () => {
      const { service } = buildService();
      await service.register(validInput);

      const stored = await UserModel.findOne({ email: EMAIL }).select("+passwordHash");
      await expect(verifyPassword(stored!.passwordHash, PASSWORD)).resolves.toBe(true);
      await expect(verifyPassword(stored!.passwordHash, "some-other-password")).resolves.toBe(false);
    });

    it("never writes the plaintext password into MongoDB", async () => {
      const { service } = buildService();
      await service.register(validInput);

      const raw = await rawUserDocument();
      expect(JSON.stringify(raw)).not.toContain(PASSWORD);
    });
  });

  // ---- verification token ----

  describe("verification token", () => {
    it("issues exactly one email-verification token for the new user", async () => {
      const { service } = buildService();
      const user = await service.register(validInput);

      const tokens = await AccountTokenModel.find({ userId: user.id });
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.purpose).toBe("email_verification");
      expect(tokens[0]!.consumedAt).toBeNull();
    });

    it("sets the expiry from the approved TTL", async () => {
      const before = Date.now();
      const { service } = buildService();
      await service.register(validInput);
      const after = Date.now();

      const token = await AccountTokenModel.findOne({});
      const expiresAt = token!.expiresAt.getTime();

      expect(expiresAt).toBeGreaterThanOrEqual(before + EMAIL_VERIFICATION_TOKEN_TTL_MS);
      expect(expiresAt).toBeLessThanOrEqual(after + EMAIL_VERIFICATION_TOKEN_TTL_MS);
    });

    it("persists the SHA-256 hash of the code carried by the email", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);

      const code = fake.verifications[0]!.code;
      expect(code).toMatch(/^[0-9]{6}$/);

      const stored = await AccountTokenModel.findOne({}).select("+tokenHash");
      expect(stored!.tokenHash).toBe(sha256(code));
    });

    it("never persists the raw secret anywhere", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);

      const code = fake.verifications[0]!.code;
      const [rawUser, rawTokens] = await Promise.all([rawUserDocument(), rawAccountTokenDocuments()]);

      /*
        Quoted, because a bare six-digit string is short enough to collide by
        chance with digits inside an ObjectId or a timestamp. The quoted form
        is what a stored value would actually serialize to, and it keeps this
        assertion from failing at random.
      */
      expect(JSON.stringify(rawUser)).not.toContain(`"${code}"`);
      expect(JSON.stringify(rawTokens)).not.toContain(`"${code}"`);
    });

    it("never returns the raw secret or the token hash to the caller", async () => {
      const { service, fake } = buildService();
      const user = await service.register(validInput);

      const code = fake.verifications[0]!.code;
      const stored = await AccountTokenModel.findOne({}).select("+tokenHash");

      const serialized = JSON.stringify(user);
      expect(serialized).not.toContain(`"${code}"`);
      expect(serialized).not.toContain(stored!.tokenHash);
      expect(serialized).not.toContain(PASSWORD);
    });

    // A user created microseconds ago cannot have prior tokens, so the call
    // would be a database round trip purely for symmetry (ADR-005 §7).
    it("does not invalidate outstanding tokens for a brand-new user", async () => {
      const invalidate = vi.spyOn(accountTokenRepository, "invalidateOutstandingForUser");

      const { service } = buildService();
      await service.register(validInput);

      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  // ---- verification URL ----

  describe("verification URL", () => {
    it("sends exactly one verification email to the stored address", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);

      expect(fake.verifications).toHaveLength(1);
      expect(fake.verifications[0]!.to).toBe(EMAIL);
      expect(fake.passwordResets).toHaveLength(0);
      expect(fake.invitations).toHaveLength(0);
    });

    it("builds the link from CLIENT_URL with the address in the query string", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);

      const url = new URL(fake.verifications[0]!.verificationUrl);
      expect(url.origin).toBe(new URL(env.CLIENT_URL).origin);
      // Exactly "/verify-email" — the redaction allowlist matches this path
      // exactly, and a path-segment form would classify as "unknown".
      expect(url.pathname).toBe("/verify-email");
      // The address, for prefill. Not a credential.
      expect(url.searchParams.get("email")).toBe(validInput.email);
    });

    /*
      Stronger than the "keep the secret out of the pathname" rule it
      replaces: since ADR-030 the URL carries NO secret in any position, so
      it is safe in a referrer header, a browser history, a proxy log, or a
      screenshot. Possessing this link grants nothing.
    */
    it("puts no code anywhere in the link", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);

      const captured = fake.verifications[0]!;
      expect(captured.verificationUrl).not.toContain(captured.code);
      expect(new URL(captured.verificationUrl).searchParams.get("token")).toBeNull();
    });
  });

  // ---- duplicate email ----

  describe("duplicate email", () => {
    it("rejects a second registration for the same address", async () => {
      const { service } = buildService();
      await service.register(validInput);

      await expect(service.register(validInput)).rejects.toBeInstanceOf(EmailAlreadyExistsError);
    });

    it("treats a differently-cased address as the same account", async () => {
      const { service } = buildService();
      await service.register(validInput);

      await expect(service.register({ ...validInput, email: "ADA@EXAMPLE.COM" })).rejects.toBeInstanceOf(
        EmailAlreadyExistsError,
      );
    });

    it("creates no second user, token, or email", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);
      await expect(service.register(validInput)).rejects.toThrow();

      expect(await UserModel.countDocuments()).toBe(1);
      expect(await AccountTokenModel.countDocuments()).toBe(1);
      expect(fake.verifications).toHaveLength(1);
    });

    it("does not resend verification to an existing unverified user", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);
      const firstUrl = fake.verifications[0]!.verificationUrl;

      await expect(service.register(validInput)).rejects.toThrow();

      expect(fake.verifications).toHaveLength(1);
      expect(fake.verifications[0]!.verificationUrl).toBe(firstUrl);
    });

    // The pre-check cannot win this race; the unique index is what does.
    it("resolves concurrent identical registrations to exactly one account", async () => {
      const { service, fake } = buildService();

      const results = await Promise.allSettled([service.register(validInput), service.register(validInput)]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(EmailAlreadyExistsError);

      expect(await UserModel.countDocuments()).toBe(1);
      expect(await AccountTokenModel.countDocuments()).toBe(1);
      expect(fake.verifications).toHaveLength(1);
    });

    // The concurrency case above races by construction, so which of the two
    // protections fires is timing-dependent. This forces the pre-check to
    // miss, proving the unique index alone is sufficient.
    it("still rejects when the pre-check misses and only the index catches it", async () => {
      const { service, fake } = buildService();
      await service.register(validInput);

      vi.spyOn(userRepository, "findByEmail").mockResolvedValueOnce(null);

      await expect(service.register(validInput)).rejects.toBeInstanceOf(EmailAlreadyExistsError);
      expect(await UserModel.countDocuments()).toBe(1);
      expect(await AccountTokenModel.countDocuments()).toBe(1);
      expect(fake.verifications).toHaveLength(1);
    });

    it("does not leak the MongoDB duplicate-key message", async () => {
      const { service } = buildService();
      await service.register(validInput);

      await expect(service.register(validInput)).rejects.toThrow(/already exists/i);
      await expect(service.register(validInput)).rejects.not.toThrow(/E11000|dup key|index/i);
    });
  });

  // ---- verification token failure (ADR-007 §3) ----

  describe("verification token creation failure", () => {
    function breakTokenCreation() {
      return vi
        .spyOn(accountTokenRepository, "create")
        .mockRejectedValue(Object.assign(new Error("E11000 duplicate key { tokenHash: \"leaked\" }"), {
          name: "MongoServerError",
        }));
    }

    it("fails the registration generically", async () => {
      breakTokenCreation();
      const { service } = buildService();

      await expect(service.register(validInput)).rejects.toThrow(/Verification token issuance failed/);
    });

    it("preserves the user, unverified", async () => {
      breakTokenCreation();
      const { service } = buildService();
      await expect(service.register(validInput)).rejects.toThrow();

      const stored = await UserModel.findOne({ email: EMAIL });
      expect(stored).not.toBeNull();
      expect(stored!.emailVerifiedAt).toBeNull();
      expect(await UserModel.countDocuments()).toBe(1);
    });

    it("creates no token and sends no email", async () => {
      breakTokenCreation();
      const { service, fake } = buildService();
      await expect(service.register(validInput)).rejects.toThrow();

      expect(await AccountTokenModel.countDocuments()).toBe(0);
      expect(fake.verifications).toHaveLength(0);
    });

    it("logs the userId without the password, token, or database message", async () => {
      breakTokenCreation();
      const { service } = buildService();
      const capture = createCapturingLogger();

      await expect(service.register(validInput, capture.log)).rejects.toThrow();

      const stored = await UserModel.findOne({ email: EMAIL });
      const logged = capture.serialized();

      expect(logged).toContain(stored!._id.toString());
      expect(logged).toContain("auth.registration.verification_token_failed");
      expect(logged).toContain("MongoServerError");
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain("E11000");
      expect(logged).not.toContain("leaked");
      expect(logged).not.toContain(EMAIL);
    });

    it("throws an error carrying no database detail", async () => {
      breakTokenCreation();
      const { service } = buildService();

      const error = await service.register(validInput).catch((err: unknown) => err);
      const serialized = `${(error as Error).message} ${JSON.stringify((error as Error).cause ?? null)}`;

      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("leaked");
      expect(serialized).not.toContain(PASSWORD);
    });
  });

  // ---- delivery failure (ADR-007 §4) ----

  describe("email delivery failure", () => {
    function buildFailingService() {
      return createRegistrationService({ emailProvider: createFailingEmailProvider("smtp exploded") });
    }

    it("still succeeds", async () => {
      const service = buildFailingService();
      const user = await service.register(validInput);

      expect(user.email).toBe(EMAIL);
      expect(user.emailVerified).toBe(false);
    });

    it("preserves both the user and the token", async () => {
      const service = buildFailingService();
      await service.register(validInput);

      expect(await UserModel.countDocuments()).toBe(1);
      expect(await AccountTokenModel.countDocuments()).toBe(1);
    });

    it("logs the failure safely", async () => {
      const service = buildFailingService();
      const capture = createCapturingLogger();

      await service.register(validInput, capture.log);

      const logged = capture.serialized();
      expect(logged).toContain("auth.registration.verification_email_failed");
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain("/verify-email");
      expect(logged).not.toContain(EMAIL);
    });

    it("returns a DTO that makes no delivery claim", async () => {
      const service = buildFailingService();
      const user = await service.register(validInput);

      expect(Object.keys(user).sort()).toEqual(["email", "emailVerified", "id", "name"]);
    });
  });

  // ---- isolation ----

  describe("isolation", () => {
    it("registering one user does not disturb another", async () => {
      const { service, fake } = buildService();

      const first = await service.register(validInput);
      const second = await service.register({
        name: "Grace Hopper",
        email: "grace@example.com",
        password: "another-good-password",
      });

      expect(first.id).not.toBe(second.id);
      expect(await UserModel.countDocuments()).toBe(2);
      expect(await AccountTokenModel.countDocuments()).toBe(2);

      const tokens = await AccountTokenModel.find({ userId: first.id });
      expect(tokens).toHaveLength(1);

      /*
        Deliberately NOT "the two codes differ". With only a million codes,
        two registrations colliding is a one-in-a-million coincidence rather
        than a bug — asserting distinctness would buy nothing and fail at
        random. What must hold is that each user owns their own token, which
        is what makes a shared code harmless (ADR-030 §5).
      */
      const [firstUrl, secondUrl] = fake.verifications.map((v) => v.verificationUrl);
      expect(new URL(firstUrl!).searchParams.get("email")).toBe(validInput.email);
      expect(new URL(secondUrl!).searchParams.get("email")).toBe("grace@example.com");
      expect(await AccountTokenModel.countDocuments({ userId: second.id })).toBe(1);
    });

    it("a failure for one user leaves the other intact", async () => {
      const { service } = buildService();
      await service.register(validInput);

      vi.spyOn(accountTokenRepository, "create").mockRejectedValueOnce(new Error("boom"));
      await expect(
        service.register({ name: "Grace Hopper", email: "grace@example.com", password: "another-good-password" }),
      ).rejects.toThrow();

      const untouched = await UserModel.findOne({ email: EMAIL });
      expect(untouched).not.toBeNull();
      expect(await AccountTokenModel.countDocuments({ userId: untouched!._id })).toBe(1);
    });
  });
});
