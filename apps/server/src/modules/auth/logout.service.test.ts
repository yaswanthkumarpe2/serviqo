import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SESSION_TTL_MS } from "../../config/constants";
import { sha256 } from "../../lib/crypto/tokens";
import { SessionModel } from "../sessions/session.model";
import { sessionRepository } from "../sessions/session.repository";
import { UserModel } from "../users/user.model";
import { createLogoutService } from "./logout.service";
import { formatRefreshToken, generateRefreshSecret } from "./refreshToken";

import type { SessionDocument } from "../sessions/session.model";
import type { UserDocument } from "../users/user.model";
import type { AuthLogger } from "./authLogging";

const EMAIL = "ada@example.com";
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

/** Creates a session and returns the raw token a browser would hold for it. */
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
const service = () => createLogoutService();

describe("Logout service", () => {
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
    it("revokes the session", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      await service().logout(token);

      expect((await reload(session))!.revokedAt).not.toBeNull();
    });

    it("resolves rather than returning anything a caller could branch on", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      await expect(service().logout(token)).resolves.toBeUndefined();
    });

    it("logs the revocation without the token or the secret", async () => {
      const user = await seedUser();
      const { session, token, secret } = await seedSession(user);
      const capture = createCapturingLogger();

      await service().logout(token, capture.log);

      expect(capture.events()).toContain("auth.logout.succeeded");
      expect(capture.serialized()).toContain(session._id.toString());
      expect(capture.serialized()).not.toContain(secret);
      expect(capture.serialized()).not.toContain(token);
    });

    it("leaves the stored token hashes alone — revocation is not rotation", async () => {
      const user = await seedUser();
      const { session, secret, token } = await seedSession(user);

      await service().logout(token);

      const stored = await sessionRepository.findByIdWithRefreshTokenState(session._id);
      expect(stored!.previousRefreshTokenHashes).toHaveLength(0);
      expect(stored!.currentRefreshTokenHash).toBe(sha256(secret));
    });
  });

  // ---- idempotency (ADR-013 §1, §6) ----

  describe("logging out twice", () => {
    it("succeeds both times", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);

      await expect(service().logout(token)).resolves.toBeUndefined();
      await expect(service().logout(token)).resolves.toBeUndefined();
    });

    it("keeps the first revocation timestamp", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      await service().logout(token);
      const firstRevokedAt = (await reload(session))!.revokedAt!.getTime();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await service().logout(token);

      expect((await reload(session))!.revokedAt!.getTime()).toBe(firstRevokedAt);
    });

    it("records the second call as revoking nothing", async () => {
      const user = await seedUser();
      const { token } = await seedSession(user);
      await service().logout(token);
      const capture = createCapturingLogger();

      await service().logout(token, capture.log);

      expect(capture.events()).toContain("auth.logout.noop");
      expect(capture.reasons()).toContain("already_revoked");
      expect(capture.events()).not.toContain("auth.logout.succeeded");
    });

    // Two logouts arriving together must still leave exactly one revocation.
    it("survives two concurrent logouts of the same session", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);

      await Promise.all([service().logout(token), service().logout(token)]);

      expect((await reload(session))!.revokedAt).not.toBeNull();
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(0);
    });
  });

  // ---- everything that revokes nothing still succeeds (ADR-013 §1) ----

  describe("calls with nothing to revoke", () => {
    it("succeeds with no cookie at all", async () => {
      await expect(service().logout(undefined)).resolves.toBeUndefined();
    });

    it("succeeds with a malformed token, before touching the database", async () => {
      const capture = createCapturingLogger();

      await expect(service().logout("garbage", capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("malformed_token");
    });

    // A CastError would turn a hand-typed cookie into a 500.
    it("succeeds with a session id that is not an ObjectId", async () => {
      await expect(service().logout("zzzz.secret")).resolves.toBeUndefined();
    });

    it("succeeds when the session does not exist", async () => {
      const token = formatRefreshToken(new mongoose.Types.ObjectId().toString(), "secret");
      const capture = createCapturingLogger();

      await expect(service().logout(token, capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("unknown_session");
    });

    it("succeeds against an already-revoked session", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      await sessionRepository.revokeById(session._id);

      await expect(service().logout(token)).resolves.toBeUndefined();
    });

    // ADR-004 §6: the TTL monitor is asynchronous, so validity is logical.
    it("succeeds against an expired session that is still present", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user, new Date(Date.now() - 1000));
      const capture = createCapturingLogger();

      await expect(service().logout(token, capture.log)).resolves.toBeUndefined();

      await expect(SessionModel.countDocuments({ _id: session._id })).resolves.toBe(1);
      expect(capture.reasons()).toContain("expired_session");
    });
  });

  // ---- the secret is the credential (ADR-013 §3) ----

  describe("a session id presented without the right secret", () => {
    it("revokes nothing when the secret is wrong", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const forged = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);

      await service().logout(forged);

      expect((await reload(session))!.revokedAt).toBeNull();
    });

    it("still succeeds, so a wrong secret is not an oracle", async () => {
      const user = await seedUser();
      const { session } = await seedSession(user);
      const forged = formatRefreshToken(session._id.toString(), generateRefreshSecret().secret);
      const capture = createCapturingLogger();

      await expect(service().logout(forged, capture.log)).resolves.toBeUndefined();

      expect(capture.reasons()).toContain("secret_mismatch");
    });

    // ADR-013 §4: only the CURRENT hash revokes.
    it("revokes nothing for a previously rotated secret", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      const rotated = generateRefreshSecret();
      await sessionRepository.rotateRefreshToken(
        session._id,
        (await sessionRepository.findByIdWithRefreshTokenState(session._id))!.currentRefreshTokenHash,
        rotated.secretHash,
      );

      await service().logout(token);

      expect((await reload(session))!.revokedAt).toBeNull();
    });

    /*
      ADR-013 §5: presenting a rotated token here must NOT trigger ADR-004 §4's
      revoke-everything response. That would let an unauthenticated caller
      destroy every session a user has from an endpoint that grants nothing.
    */
    it("does not trigger reuse detection", async () => {
      const user = await seedUser();
      const { session, token } = await seedSession(user);
      const other = await seedSession(user);
      const rotated = generateRefreshSecret();
      await sessionRepository.rotateRefreshToken(
        session._id,
        (await sessionRepository.findByIdWithRefreshTokenState(session._id))!.currentRefreshTokenHash,
        rotated.secretHash,
      );

      await service().logout(token);

      expect((await reload(other.session))!.revokedAt).toBeNull();
      await expect(SessionModel.countDocuments({ revokedAt: null })).resolves.toBe(2);
    });
  });

  // ---- isolation (ADR-013 §6) ----

  describe("other sessions", () => {
    it("revokes only the session the token addresses", async () => {
      const user = await seedUser();
      const laptop = await seedSession(user);
      const phone = await seedSession(user);
      const tablet = await seedSession(user);

      await service().logout(laptop.token);

      expect((await reload(laptop.session))!.revokedAt).not.toBeNull();
      expect((await reload(phone.session))!.revokedAt).toBeNull();
      expect((await reload(tablet.session))!.revokedAt).toBeNull();
    });

    it("leaves the other device able to keep working", async () => {
      const user = await seedUser();
      const laptop = await seedSession(user);
      const phone = await seedSession(user);

      await service().logout(laptop.token);

      const active = await sessionRepository.findActiveByUser(user._id);
      expect(active).toHaveLength(1);
      expect(active[0]!._id.toString()).toBe(phone.session._id.toString());
    });

    it("never touches another user's sessions", async () => {
      const user = await seedUser();
      const bystander = await seedUser("grace@example.com");
      const mine = await seedSession(user);
      const theirs = await seedSession(bystander);

      await service().logout(mine.token);

      expect((await reload(theirs.session))!.revokedAt).toBeNull();
    });
  });
});
