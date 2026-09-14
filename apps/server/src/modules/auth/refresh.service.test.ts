import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { REFRESH_RACE_GRACE_MS, SESSION_TTL_MS } from "../../config/constants";
import { sha256 } from "../../lib/crypto/tokens";
import { SessionModel } from "../sessions/session.model";
import { sessionRepository } from "../sessions/session.repository";
import { UserModel } from "../users/user.model";
import { RefreshRejectedError, createRefreshService } from "./refresh.service";
import { formatRefreshToken, generateRefreshSecret } from "./refreshToken";

import type { SessionDocument } from "../sessions/session.model";
import type { UserDocument } from "../users/user.model";
import type { AuthLogger } from "./authLogging";

/** An obvious sentinel — if it reaches a database, response, or log, the test fails. */
const EMAIL = "ada@example.com";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$DO_NOT_LEAK$DO_NOT_LEAK";

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
    events: () => entries.map((e) => e.payload.event),
    reasons: () => entries.map((e) => e.payload.reason),
  };
}

interface SeedUserOptions {
  verified?: boolean;
  status?: "active" | "disabled";
  email?: string;
}

async function seedUser({ verified = true, status = "active", email = EMAIL }: SeedUserOptions = {}) {
  return UserModel.create({
    name: "Ada Lovelace",
    email,
    passwordHash: PASSWORD_HASH,
    emailVerifiedAt: verified ? new Date() : null,
    status,
  });
}

interface SeedSessionOptions {
  expiresAt?: Date;
  revokedAt?: Date | null;
}

/** Creates a session and returns the raw token a client would hold for it. */
async function seedSession(user: UserDocument, { expiresAt, revokedAt = null }: SeedSessionOptions = {}) {
  const { secret, secretHash } = generateRefreshSecret();
  const session = await sessionRepository.create({
    userId: user._id,
    currentRefreshTokenHash: secretHash,
    expiresAt: expiresAt ?? new Date(Date.now() + SESSION_TTL_MS),
  });

  if (revokedAt !== null) {
    await SessionModel.updateOne({ _id: session._id }, { $set: { revokedAt } });
  }

  return { session, secret, token: formatRefreshToken(session._id.toString(), secret) };
}

async function reload(session: SessionDocument) {
  return sessionRepository.findByIdWithRefreshTokenState(session._id);
}

const service = () => createRefreshService();

/**
 * Refreshes a token that must be refused, and returns the refusal.
 *
 * Fails loudly if the refresh succeeds, so a test asserting something about a
 * rejection can never quietly pass because the rejection stopped happening.
 */
async function refusalFor(token: string | undefined): Promise<RefreshRejectedError> {
  try {
    await service().refresh(token);
  } catch (err) {
    return err as RefreshRejectedError;
  }
  throw new Error("Expected the refresh to be refused, but it succeeded");
}

describe("Refresh service", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await SessionModel.init();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), SessionModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- the valid current token ----

  describe("a valid current token", () => {
    it("returns the session owner's identity and a new access token", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      const result = await service().refresh(token);

      // Same projection login returns, `kind` included (ADR-034 §1) — the two
      // are aliased deliberately so a reloaded tab learns exactly what a fresh
      // sign-in would.
      expect(result.user).toEqual({ id: user._id.toString(), name: "Ada Lovelace", email: EMAIL, kind: "agent" });
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.expiresIn).toBeGreaterThan(0);
    });

    it("rotates the token: the presented secret stops working", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      await service().refresh(token);

      await expect(service().refresh(token)).rejects.toBeInstanceOf(RefreshRejectedError);
    });

    it("issues a different refresh token that does work", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      const first = await service().refresh(token);
      expect(first.refreshToken).not.toBe(token);

      const second = await service().refresh(first.refreshToken);
      expect(second.accessToken).toEqual(expect.any(String));
    });

    // ADR-004 §1: rotation changes which token a session accepts, never which
    // session exists.
    it("keeps the session id stable across rotation", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      const result = await service().refresh(token);

      expect(result.refreshToken.split(".")[0]).toBe(session._id.toString());
      await expect(SessionModel.countDocuments({})).resolves.toBe(1);
    });

    it("stores only the hash of the new secret, never the secret", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      const result = await service().refresh(token);
      const newSecret = result.refreshToken.slice(result.refreshToken.indexOf(".") + 1);

      const stored = await reload(session);
      expect(stored!.currentRefreshTokenHash).toBe(sha256(newSecret));

      const raw = await mongoose.connection.collection("sessions").findOne({});
      expect(JSON.stringify(raw)).not.toContain(newSecret);
    });

    it("moves the outgoing hash into history so reuse stays detectable", async () => {
      const user = await seedUser();
      const { session, secret } = await seedSession(user);

      await service().refresh(formatRefreshToken(session._id.toString(), secret));

      const stored = await reload(session);
      expect(stored!.previousRefreshTokenHashes).toContain(sha256(secret));
    });

    // ADR-012 consequences: refresh does not extend the session.
    it("does not move the session's expiry", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      const originalExpiry = session.expiresAt.getTime();

      await service().refresh(token);

      const stored = await reload(session);
      expect(stored!.expiresAt.getTime()).toBe(originalExpiry);
    });

    it("logs the success without the secret", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      const capture = createCapturingLogger();

      const result = await service().refresh(token, capture.log);
      const newSecret = result.refreshToken.slice(result.refreshToken.indexOf(".") + 1);

      expect(capture.events()).toContain("auth.refresh.succeeded");
      expect(capture.serialized()).not.toContain(newSecret);
      expect(capture.serialized()).not.toContain(token);
    });
  });

  // ---- refusals that clear the cookie ----

  describe("refusals", () => {
    it("refuses a missing cookie", async () => {
      await expect(service().refresh(undefined)).rejects.toMatchObject({
        code: "INVALID_REFRESH_TOKEN",
        httpStatus: 401,
        clearCookie: true,
      });
    });

    it("refuses a malformed token without touching the database", async () => {
      await expect(service().refresh("garbage")).rejects.toMatchObject({ clearCookie: true });
      await expect(service().refresh("not-an-id.secret")).rejects.toMatchObject({ clearCookie: true });
    });

    // A CastError here would answer a hand-typed cookie with a 500.
    it("refuses a malformed session id rather than raising a cast error", async () => {
      const error = await service()
        .refresh("zzzz.secret")
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RefreshRejectedError);
    });

    it("refuses a session that does not exist", async () => {
      const token = formatRefreshToken(new mongoose.Types.ObjectId().toString(), "secret");

      await expect(service().refresh(token)).rejects.toMatchObject({ clearCookie: true });
    });

    it("refuses a secret the session has never accepted", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);

      const token = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);

      await expect(service().refresh(token)).rejects.toBeInstanceOf(RefreshRejectedError);
    });

    // An unknown secret is noise, not theft — it must not revoke anything.
    it("revokes nothing when the secret is merely unknown", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const token = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);

      await service().refresh(token).catch(() => undefined);

      const stored = await reload(session);
      expect(stored!.revokedAt).toBeNull();
    });

    it("refuses a revoked session", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user, { revokedAt: new Date() });

      await expect(service().refresh(token)).rejects.toMatchObject({ clearCookie: true });
    });

    // ADR-004 §6: TTL is asynchronous, so validity is evaluated logically.
    it("refuses an expired session that is still physically present", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user, { expiresAt: new Date(Date.now() - 1000) });

      await expect(SessionModel.countDocuments({ _id: session._id })).resolves.toBe(1);
      await expect(service().refresh(token)).rejects.toBeInstanceOf(RefreshRejectedError);
    });

    it("gives every refusal the same code and message", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user, { revokedAt: new Date() });
      const unknownSecret = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);

      const errors = await Promise.all([undefined, "garbage", unknownSecret].map(refusalFor));

      const messages = new Set(errors.map((err) => err.message));
      const codes = new Set(errors.map((err) => err.code));
      expect(messages.size).toBe(1);
      expect(codes.size).toBe(1);
    });
  });

  // ---- reuse detection (ADR-004 §4) ----

  describe("reuse detection", () => {
    /** Rotates twice so the original token is two rotations deep — outside any race. */
    async function replayedToken(user: UserDocument) {
      const { session, token } = await seedSession(user);
      const first = await service().refresh(token);
      await service().refresh(first.refreshToken);
      return { session, staleToken: token };
    }

    it("refuses a token that has already been rotated away", async () => {
      const user = await seedUser();
      const { staleToken } = await replayedToken(user);

      await expect(service().refresh(staleToken)).rejects.toBeInstanceOf(RefreshRejectedError);
    });

    it("revokes every session the user has, not just the replayed one", async () => {
      const user = await seedUser();
      const other = await seedSession(user);
      const third = await seedSession(user);
      const { staleToken } = await replayedToken(user);

      await service().refresh(staleToken).catch(() => undefined);

      const stillActive = await sessionRepository.findActiveByUser(user._id);
      expect(stillActive).toHaveLength(0);
      expect((await reload(other.session))!.revokedAt).not.toBeNull();
      expect((await reload(third.session))!.revokedAt).not.toBeNull();
    });

    it("leaves other users' sessions alone", async () => {
      const user = await seedUser();
      const bystander = await seedUser({ email: "grace@example.com" });
      const untouched = await seedSession(bystander);
      const { staleToken } = await replayedToken(user);

      await service().refresh(staleToken).catch(() => undefined);

      expect((await reload(untouched.session))!.revokedAt).toBeNull();
    });

    it("logs reuse as its own security event", async () => {
      const user = await seedUser();
      const { staleToken } = await replayedToken(user);
      const capture = createCapturingLogger();

      await service().refresh(staleToken, capture.log).catch(() => undefined);

      expect(capture.events()).toContain("auth.refresh.reuse_detected");
      expect(capture.serialized()).not.toContain(staleToken);
    });

    // The revoked session must not re-run revocation on every subsequent replay.
    it("answers a further replay from the validity check, not detection again", async () => {
      const user = await seedUser();
      const { staleToken } = await replayedToken(user);
      await service().refresh(staleToken).catch(() => undefined);
      const capture = createCapturingLogger();

      await service().refresh(staleToken, capture.log).catch(() => undefined);

      expect(capture.events()).not.toContain("auth.refresh.reuse_detected");
      expect(capture.reasons()).toContain("session_revoked");
    });
  });

  // ---- the grace window (ADR-012 §4) ----

  describe("concurrent refresh within the grace window", () => {
    it("refuses the immediately-previous token without revoking anything", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      await service().refresh(token);

      // Presented immediately, so lastRotatedAt is well inside the window.
      const error = await refusalFor(token);

      expect(error).toBeInstanceOf(RefreshRejectedError);
      expect((await reload(session))!.revokedAt).toBeNull();
    });

    // The whole point: the winner's cookie must survive the loser's response.
    it("does not ask the controller to clear the cookie", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await service().refresh(token);

      await expect(service().refresh(token)).rejects.toMatchObject({ clearCookie: false });
    });

    // ADR-012 §4: the window governs revocation only, never issuance.
    it("issues credentials of no kind to the losing request", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      const winner = await service().refresh(token);

      const error = await refusalFor(token);

      expect(error).not.toHaveProperty("accessToken");
      expect(error).not.toHaveProperty("refreshToken");
      // The winner's token is untouched by the loser's attempt.
      await expect(service().refresh(winner.refreshToken)).resolves.toMatchObject({
        accessToken: expect.any(String),
      });
    });

    it("treats the previous token as replay once the window has passed", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      await service().refresh(token);

      // Age lastRotatedAt past the window rather than waiting ten seconds.
      await SessionModel.updateOne(
        { _id: session._id },
        { $set: { lastRotatedAt: new Date(Date.now() - REFRESH_RACE_GRACE_MS - 1000) } },
      );

      await expect(service().refresh(token)).rejects.toMatchObject({ clearCookie: true });
      expect((await reload(session))!.revokedAt).not.toBeNull();
    });

    // Only the LAST history entry can be a concurrent refresh; an older hash
    // means the session rotated more than once since that token was current.
    it("treats an older history entry as replay even inside the window", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      const first = await service().refresh(token);
      await service().refresh(first.refreshToken);

      // lastRotatedAt is moments old, but `token` is two rotations deep.
      await expect(service().refresh(token)).rejects.toMatchObject({ clearCookie: true });
      expect((await reload(session))!.revokedAt).not.toBeNull();
    });

    // ADR-012 §6: the compare-and-swap guard, exercised through the service.
    it("lets exactly one of two simultaneous refreshes of the same token win", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      const outcomes = await Promise.all([
        service()
          .refresh(token)
          .then(() => "issued")
          .catch(() => "refused"),
        service()
          .refresh(token)
          .then(() => "issued")
          .catch(() => "refused"),
      ]);

      expect(outcomes.filter((outcome) => outcome === "issued")).toHaveLength(1);
      // No false theft alarm, and the session advanced exactly one step.
      const stored = await reload(session);
      expect(stored!.revokedAt).toBeNull();
      expect(stored!.previousRefreshTokenHashes).toHaveLength(1);
    });
  });

  // ---- account entitlement (ADR-012 §7) ----

  describe("account standing", () => {
    it("refuses a session whose user has been disabled", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await UserModel.updateOne({ _id: user._id }, { $set: { status: "disabled" } });

      await expect(service().refresh(token)).rejects.toBeInstanceOf(RefreshRejectedError);
    });

    it("revokes the session so the dead cookie stops coming back", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      await UserModel.updateOne({ _id: user._id }, { $set: { status: "disabled" } });

      await service().refresh(token).catch(() => undefined);

      expect((await reload(session))!.revokedAt).not.toBeNull();
    });

    it("refuses a session whose user no longer exists", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await UserModel.deleteOne({ _id: user._id });

      await expect(service().refresh(token)).rejects.toMatchObject({ clearCookie: true });
    });

    // Defense in depth against a future email-change flow that un-verifies.
    it("refuses a session whose address is no longer verified", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });

      await expect(service().refresh(token)).rejects.toBeInstanceOf(RefreshRejectedError);
    });

    // The account is checked before anything is minted, not after.
    it("rotates nothing when the account is refused", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const before = await reload(session);
      await UserModel.updateOne({ _id: user._id }, { $set: { status: "disabled" } });

      await service()
        .refresh(formatRefreshToken(session._id.toString(), "wrong"))
        .catch(() => undefined);

      const after = await reload(session);
      expect(after!.currentRefreshTokenHash).toBe(before!.currentRefreshTokenHash);
      expect(after!.previousRefreshTokenHashes).toHaveLength(0);
    });
  });
});
