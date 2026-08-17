import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InvalidAccessTokenError } from "../../lib/errors";
import { UserModel } from "../users/user.model";
import { createCurrentUserService } from "./currentUser.service";

import type { UserDocument } from "../users/user.model";
import type { AccessTokenPrincipal } from "./accessToken";
import type { AuthLogger } from "./authLogging";

const EMAIL = "ada@example.com";
/** An obvious sentinel — if it reaches a log or a return value, the test fails. */
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$DO_NOT_LEAK$DO_NOT_LEAK";
const SESSION_ID = "507f191e810c19729de860ea";
/** Well-formed and belonging to nobody. */
const UNKNOWN_USER_ID = "507f1f77bcf86cd799439099";

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

async function seedUser(overrides: Partial<Record<string, unknown>> = {}): Promise<UserDocument> {
  return UserModel.create({
    name: "Ada Lovelace",
    email: EMAIL,
    passwordHash: PASSWORD_HASH,
    emailVerifiedAt: new Date(),
    status: "active",
    ...overrides,
  });
}

const principalFor = (user: UserDocument): AccessTokenPrincipal => ({
  userId: user._id.toString(),
  sessionId: SESSION_ID,
});

describe("currentUserService", () => {
  let mongoServer: MongoMemoryServer;
  const service = createCurrentUserService();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
  });

  afterEach(async () => {
    await UserModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe("an entitled account", () => {
    it("returns the user the principal names", async () => {
      const user = await seedUser();

      const current = await service.getCurrentUser(principalFor(user));

      expect(current.id).toBe(user._id.toString());
      expect(current.name).toBe("Ada Lovelace");
      expect(current.email).toBe(EMAIL);
    });

    it("returns the account's state and timestamps", async () => {
      const user = await seedUser();

      const current = await service.getCurrentUser(principalFor(user));

      expect(current.status).toBe("active");
      expect(current.emailVerifiedAt).toBeInstanceOf(Date);
      expect(current.createdAt).toBeInstanceOf(Date);
    });

    /*
      Built from the loaded document rather than the token, so a name changed
      after sign-in is current on the next request (ADR-015 §11). Nothing
      updates a name yet; this asserts the source, not a feature.
    */
    it("reads the database, not the credential", async () => {
      const user = await seedUser();
      await UserModel.updateOne({ _id: user._id }, { $set: { name: "Ada King" } });

      const current = await service.getCurrentUser(principalFor(user));

      expect(current.name).toBe("Ada King");
    });

    // The DTO is built field by field so it cannot silently gain whatever the
    // schema gains next. This is the assertion that notices.
    it("returns exactly the approved fields and nothing else", async () => {
      const user = await seedUser();

      const current = await service.getCurrentUser(principalFor(user));

      expect(Object.keys(current).sort()).toEqual([
        "createdAt",
        "email",
        "emailVerifiedAt",
        "id",
        "name",
        "status",
      ]);
    });

    it("exposes no credential, lockout, or internal persistence field", async () => {
      const user = await seedUser({ failedLoginAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) });

      const current = await service.getCurrentUser(principalFor(user));
      const serialized = JSON.stringify(current);

      for (const field of [
        "passwordHash",
        "failedLoginAttempts",
        "lockedUntil",
        "loginFailureCount",
        "currentRefreshTokenHash",
        "previousRefreshTokenHashes",
        "sessions",
        "__v",
        "_id",
      ]) {
        expect(current).not.toHaveProperty(field);
      }
      expect(serialized).not.toContain(PASSWORD_HASH);
      expect(serialized).not.toContain("$argon2");
    });

    // ADR-015 §9: nothing creates a Membership, so an organization field would
    // be null for every caller — and "current organization" is not a concept
    // this architecture has.
    it("carries no organization or role", async () => {
      const user = await seedUser();

      const current = await service.getCurrentUser(principalFor(user));

      expect(current).not.toHaveProperty("organizationId");
      expect(current).not.toHaveProperty("organization");
      expect(current).not.toHaveProperty("role");
      expect(current).not.toHaveProperty("memberships");
      expect(current).not.toHaveProperty("permissions");
    });

    it("logs the success with the ids an operator correlates on", async () => {
      const user = await seedUser();
      const logger = createCapturingLogger();

      await service.getCurrentUser(principalFor(user), logger.log);

      expect(logger.events()).toEqual(["auth.me.succeeded"]);
      expect(logger.serialized()).toContain(user._id.toString());
      expect(logger.serialized()).toContain(SESSION_ID);
    });
  });

  /*
    A valid signature identifies a user; it does not entitle them (ADR-015 §7).
    The same three-part gate refresh.service.ts applies, deliberately identical
    so the two cannot drift about who may hold a session.
  */
  describe("an account that may no longer be served", () => {
    it("refuses a user that no longer exists", async () => {
      await expect(
        service.getCurrentUser({ userId: UNKNOWN_USER_ID, sessionId: SESSION_ID }),
      ).rejects.toBeInstanceOf(InvalidAccessTokenError);
    });

    it("refuses a disabled account", async () => {
      const user = await seedUser({ status: "disabled" });

      await expect(service.getCurrentUser(principalFor(user))).rejects.toBeInstanceOf(InvalidAccessTokenError);
    });

    /*
      Expected to be unreachable — nothing un-verifies an address — and checked
      anyway, so a future email-change flow cannot walk around this gate in
      silence. The same reasoning refresh.service.ts records.
    */
    it("refuses an account whose address is not verified", async () => {
      const user = await seedUser({ emailVerifiedAt: null });

      await expect(service.getCurrentUser(principalFor(user))).rejects.toBeInstanceOf(InvalidAccessTokenError);
    });

    it("refuses a deleted account even mid-session", async () => {
      const user = await seedUser();
      const principal = principalFor(user);
      await UserModel.deleteMany({});

      await expect(service.getCurrentUser(principal)).rejects.toBeInstanceOf(InvalidAccessTokenError);
    });

    // Distinguishing them would turn a bearer token into a probe for account
    // state (ADR-015 §6).
    it("answers unknown and disabled with the same error and message", async () => {
      const disabled = await seedUser({ status: "disabled" });

      /** Resolves with whatever was thrown, so both refusals can be compared side by side. */
      const refusalFor = async (principal: AccessTokenPrincipal): Promise<InvalidAccessTokenError> => {
        try {
          await service.getCurrentUser(principal);
        } catch (err) {
          return err as InvalidAccessTokenError;
        }
        throw new Error("expected the request to be refused");
      };

      const failures = await Promise.all([
        refusalFor(principalFor(disabled)),
        refusalFor({ userId: UNKNOWN_USER_ID, sessionId: SESSION_ID }),
      ]);

      expect(failures.map((e) => e.code)).toEqual(["INVALID_ACCESS_TOKEN", "INVALID_ACCESS_TOKEN"]);
      expect(failures.map((e) => e.httpStatus)).toEqual([401, 401]);
      expect(new Set(failures.map((e) => e.message)).size).toBe(1);
    });

    // The distinction exists for operators, on the server, and nowhere else.
    it("distinguishes them in the log", async () => {
      const disabled = await seedUser({ status: "disabled" });
      const disabledLog = createCapturingLogger();
      const unknownLog = createCapturingLogger();

      await service.getCurrentUser(principalFor(disabled), disabledLog.log).catch(() => undefined);
      await service
        .getCurrentUser({ userId: UNKNOWN_USER_ID, sessionId: SESSION_ID }, unknownLog.log)
        .catch(() => undefined);

      expect(disabledLog.events()).toEqual(["auth.me.failed"]);
      expect(disabledLog.reasons()).toEqual(["user_not_entitled"]);
      expect(unknownLog.reasons()).toEqual(["unknown_user"]);
    });

    it("returns no user data alongside the refusal", async () => {
      const user = await seedUser({ status: "disabled" });
      const logger = createCapturingLogger();

      await service.getCurrentUser(principalFor(user), logger.log).catch(() => undefined);

      // The refusal names the account for an operator but carries none of it.
      expect(logger.serialized()).not.toContain(EMAIL);
      expect(logger.serialized()).not.toContain("Ada Lovelace");
      expect(logger.serialized()).not.toContain(PASSWORD_HASH);
    });
  });

  /*
    ADR-015 §8: the session is verified as part of the token and deliberately
    not looked up. No session document exists in this suite at all, and every
    entitled case above still resolves — which is that decision, asserted.
  */
  it("does not require the session to exist", async () => {
    const user = await seedUser();

    await expect(
      service.getCurrentUser({ userId: user._id.toString(), sessionId: SESSION_ID }),
    ).resolves.toMatchObject({ email: EMAIL });
  });
});
