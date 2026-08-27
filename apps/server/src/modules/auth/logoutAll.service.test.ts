import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SESSION_TTL_MS } from "../../config/constants";
import { SessionModel } from "../sessions/session.model";
import { sessionRepository } from "../sessions/session.repository";
import { UserModel } from "../users/user.model";
import { createLogoutAllService } from "./logoutAll.service";
import { formatRefreshToken, generateRefreshSecret } from "./refreshToken";

import type { SessionDocument } from "../sessions/session.model";
import type { UserDocument } from "../users/user.model";
import type { AuthLogger } from "./authLogging";

const EMAIL = "ada@example.com";
const OTHER_EMAIL = "grace@example.com";
/** An obvious sentinel — if it reaches a log or a response, the test fails. */
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
    serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n"),
    events: () => entries.map((e) => e.payload.event),
    reasons: () => entries.map((e) => e.payload.reason),
    payloads: () => entries.map((e) => e.payload),
  };
}

async function seedUser(email = EMAIL): Promise<UserDocument> {
  return UserModel.create({
    name: "Ada Lovelace",
    email,
    passwordHash: PASSWORD_HASH,
    emailVerifiedAt: new Date(),
    status: "active",
  });
}

/** Creates a session and returns the raw token that device would hold. */
async function seedSession(user: UserDocument, expiresAt?: Date) {
  const { secret, secretHash } = generateRefreshSecret();
  const session = await sessionRepository.create({
    userId: user._id,
    currentRefreshTokenHash: secretHash,
    expiresAt: expiresAt ?? new Date(Date.now() + SESSION_TTL_MS),
  });

  return { session, secret, token: formatRefreshToken(session._id.toString(), secret) };
}

const reload = (session: SessionDocument) => SessionModel.findById(session._id);
const service = () => createLogoutAllService();

describe("Logout-all service", () => {
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

  // ---- the ordinary case ----

  describe("a valid current token", () => {
    it("revokes the session that asked", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      await service().logoutAll(token);

      expect((await reload(session))!.revokedAt).not.toBeNull();
    });

    // "All devices" that spared the device asking would be a strange reading.
    it("revokes every other session the user holds", async () => {
      const user = await seedUser();
      const deviceA = await seedSession(user);
      const deviceB = await seedSession(user);
      const deviceC = await seedSession(user);

      await service().logoutAll(deviceA.token);

      expect((await reload(deviceA.session))!.revokedAt).not.toBeNull();
      expect((await reload(deviceB.session))!.revokedAt).not.toBeNull();
      expect((await reload(deviceC.session))!.revokedAt).not.toBeNull();
    });

    it("leaves the user with no active sessions at all", async () => {
      const user = await seedUser();
      const first = await seedSession(user);
      await seedSession(user);
      await seedSession(user);

      await service().logoutAll(first.token);

      await expect(sessionRepository.findActiveByUser(user._id)).resolves.toHaveLength(0);
    });

    it("resolves rather than returning anything a caller could branch on", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      await expect(service().logoutAll(token)).resolves.toBeUndefined();
    });
  });

  // ---- scope (ADR-014 §5) ----

  describe("other users", () => {
    it("never touches another user's sessions", async () => {
      const user = await seedUser();
      const bystander = await seedUser(OTHER_EMAIL);
      const mine = await seedSession(user);
      await seedSession(user);
      const theirs = await seedSession(bystander);

      await service().logoutAll(mine.token);

      expect((await reload(theirs.session))!.revokedAt).toBeNull();
    });

    it("leaves the other user able to keep working", async () => {
      const user = await seedUser();
      const bystander = await seedUser(OTHER_EMAIL);
      const mine = await seedSession(user);
      const theirs = await seedSession(bystander);

      await service().logoutAll(mine.token);

      const stillActive = await sessionRepository.findActiveByUser(bystander._id);
      expect(stillActive).toHaveLength(1);
      expect(stillActive[0]!._id.toString()).toBe(theirs.session._id.toString());
    });
  });

  // ---- already-revoked sessions keep their timestamps (ADR-004 §7) ----

  describe("sessions already revoked", () => {
    it("leaves an earlier revocation timestamp untouched", async () => {
      const user = await seedUser();
      const current = await seedSession(user);
      const old = await seedSession(user);
      await sessionRepository.revokeById(old.session._id);
      const originalRevokedAt = (await reload(old.session))!.revokedAt!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await service().logoutAll(current.token);

      expect((await reload(old.session))!.revokedAt!.getTime()).toBe(originalRevokedAt);
    });

    it("counts only the sessions it actually revoked", async () => {
      const user = await seedUser();
      const current = await seedSession(user);
      const second = await seedSession(user);
      await sessionRepository.revokeById(second.session._id);
      const capture = createCapturingLogger();

      await service().logoutAll(current.token, capture.log);

      const succeeded = capture.payloads().find((p) => p.event === "auth.logout_all.succeeded");
      expect(succeeded!.revokedCount).toBe(1);
    });
  });

  // ---- idempotency (ADR-014 §1) ----

  describe("repeating the call", () => {
    it("succeeds every time", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      await expect(service().logoutAll(token)).resolves.toBeUndefined();
      await expect(service().logoutAll(token)).resolves.toBeUndefined();
      await expect(service().logoutAll(token)).resolves.toBeUndefined();
    });

    it("revokes nothing the second time, because its own session is now revoked", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await service().logoutAll(token);
      const capture = createCapturingLogger();

      await service().logoutAll(token, capture.log);

      expect(capture.reasons()).toContain("already_revoked");
      expect(capture.events()).not.toContain("auth.logout_all.succeeded");
    });

    it("survives two concurrent calls", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await seedSession(user);

      await Promise.all([service().logoutAll(token), service().logoutAll(token)]);

      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(0);
    });
  });

  // ---- everything that revokes nothing still succeeds (ADR-014 §1) ----

  describe("calls with nothing to revoke", () => {
    it("succeeds with no cookie at all", async () => {
      const capture = createCapturingLogger();

      await expect(service().logoutAll(undefined, capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("missing_cookie");
    });

    it("succeeds with a malformed token", async () => {
      const capture = createCapturingLogger();

      await expect(service().logoutAll("garbage", capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("malformed_token");
    });

    // A CastError would turn a hand-typed cookie into a 500.
    it("succeeds with a session id that is not an ObjectId", async () => {
      await expect(service().logoutAll("zzzz.secret")).resolves.toBeUndefined();
    });

    it("succeeds when the session does not exist", async () => {
      const token = formatRefreshToken(new mongoose.Types.ObjectId().toString(), "secret");
      const capture = createCapturingLogger();

      await expect(service().logoutAll(token, capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("unknown_session");
    });

    it("succeeds against an already-revoked current session", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      await sessionRepository.revokeById(session._id);

      await expect(service().logoutAll(token)).resolves.toBeUndefined();
    });

    // ADR-004 §6: the TTL monitor is asynchronous, so validity is logical.
    it("succeeds against an expired session that is still present", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user, new Date(Date.now() - 1000));
      const capture = createCapturingLogger();

      await expect(service().logoutAll(token, capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("expired_session");
    });

    /*
      A revoked or expired cookie must not become a way to revoke the rest.
      Whoever holds it is not proving anything about the account any more.
    */
    it("revokes nothing else when its own session is no longer usable", async () => {
      const user = await seedUser();
      const dead = await seedSession(user);
      const healthy = await seedSession(user);
      await sessionRepository.revokeById(dead.session._id);

      await service().logoutAll(dead.token);

      expect((await reload(healthy.session))!.revokedAt).toBeNull();
    });
  });

  // ---- the secret is the credential (ADR-014 §3) ----

  describe("a session id presented without its secret", () => {
    it("revokes nothing when the secret is wrong", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const other = await seedSession(user);
      const forged = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);

      await service().logoutAll(forged);

      expect((await reload(session))!.revokedAt).toBeNull();
      expect((await reload(other.session))!.revokedAt).toBeNull();
    });

    it("still succeeds, so a wrong secret is not an oracle", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const forged = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);
      const capture = createCapturingLogger();

      await expect(service().logoutAll(forged, capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("secret_mismatch");
    });

    // ADR-014 §4: the punishment for reuse IS mass revocation, so wiring them
    // together would let a wrong secret accomplish what a right one does.
    it("does not let a rotated token trigger reuse detection", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      const other = await seedSession(user);
      const rotated = generateRefreshSecret();
      await sessionRepository.rotateRefreshToken(
        session._id,
        (await sessionRepository.findByIdWithRefreshTokenState(session._id))!.currentRefreshTokenHash,
        rotated.secretHash,
      );

      await service().logoutAll(token);

      expect((await reload(session))!.revokedAt).toBeNull();
      expect((await reload(other.session))!.revokedAt).toBeNull();
    });
  });

  // ---- logging (ADR-014 §2, §9) ----

  describe("logging", () => {
    it("records the revoked count for operators", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await seedSession(user);
      await seedSession(user);
      const capture = createCapturingLogger();

      await service().logoutAll(token, capture.log);

      const succeeded = capture.payloads().find((p) => p.event === "auth.logout_all.succeeded");
      expect(succeeded!.revokedCount).toBe(3);
      expect(succeeded!.userId).toBe(user._id.toString());
    });

    it("never logs the token or the secret", async () => {
      const user = await seedUser();
      const { token, secret } = await seedSession(user);
      const capture = createCapturingLogger();

      await service().logoutAll(token, capture.log);

      expect(capture.serialized()).not.toContain(secret);
      expect(capture.serialized()).not.toContain(token);
    });

    it("never logs a token even when it refuses", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const forgedSecret = generateRefreshSecret().secret;
      const forged = formatRefreshToken(session._id.toString(), forgedSecret);
      const capture = createCapturingLogger();

      await service().logoutAll(forged, capture.log);

      expect(capture.serialized()).not.toContain(forgedSecret);
    });

    it("never logs a stored hash", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      const stored = await sessionRepository.findByIdWithRefreshTokenState(session._id);
      const capture = createCapturingLogger();

      await service().logoutAll(token, capture.log);

      expect(capture.serialized()).not.toContain(stored!.currentRefreshTokenHash);
    });
  });
});
