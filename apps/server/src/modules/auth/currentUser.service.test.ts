import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InvalidAccessTokenError } from "../../lib/errors";
import { MembershipModel } from "../memberships/membership.model";
import { OrganizationModel } from "../organizations/organization.model";
import { UserModel } from "../users/user.model";
import { createCurrentUserService } from "./currentUser.service";

import type { MembershipRole, MembershipStatus } from "../memberships/membership.model";
import type { OrganizationStatus } from "../organizations/organization.model";
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
    // The membership tests below rely on real index behaviour (one membership
    // per user per organization, one owner per organization).
    await OrganizationModel.init();
    await MembershipModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  describe("an entitled account", () => {
    it("returns the user the principal names", async () => {
      const user = await seedUser();

      const { user: current } = await service.getCurrentUser(principalFor(user));

      expect(current.id).toBe(user._id.toString());
      expect(current.name).toBe("Ada Lovelace");
      expect(current.email).toBe(EMAIL);
    });

    it("returns the account's state and timestamps", async () => {
      const user = await seedUser();

      const { user: current } = await service.getCurrentUser(principalFor(user));

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

      const { user: current } = await service.getCurrentUser(principalFor(user));

      expect(current.name).toBe("Ada King");
    });

    // The DTO is built field by field so it cannot silently gain whatever the
    // schema gains next. This is the assertion that notices.
    it("returns exactly the approved fields and nothing else", async () => {
      const user = await seedUser();

      const { user: current } = await service.getCurrentUser(principalFor(user));

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

      const { user: current } = await service.getCurrentUser(principalFor(user));
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

    /*
      Memberships are a SIBLING of the user in the response, not fields on it
      (ADR-017 §9): a membership is a fact about a relationship rather than an
      attribute of the person, the same reason `User` carries no
      `organizationId` (ADR-010 §3).
    */
    it("carries no organization or role on the user itself", async () => {
      const user = await seedUser();

      const { user: current } = await service.getCurrentUser(principalFor(user));

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
    ).resolves.toMatchObject({ user: { email: EMAIL } });
  });

  // ---- memberships (ADR-017 §9) ----

  describe("memberships", () => {
    /** Creates an organization and puts `user` in it. */
    async function joinOrganization(
      user: UserDocument,
      name: string,
      slug: string,
      overrides: { role?: MembershipRole; membershipStatus?: MembershipStatus; orgStatus?: OrganizationStatus } = {},
    ) {
      const organization = await OrganizationModel.create({
        name,
        slug,
        status: overrides.orgStatus ?? "active",
      });
      const membership = await MembershipModel.create({
        userId: user._id,
        organizationId: organization._id,
        role: overrides.role ?? "owner",
        status: overrides.membershipStatus ?? "active",
      });
      return { organization, membership };
    }

    it("returns an empty list for a user who belongs to nothing", async () => {
      const user = await seedUser();

      const { memberships } = await service.getCurrentUser(principalFor(user));

      // Empty, never a fabricated organization and never null dressed as one.
      expect(memberships).toEqual([]);
    });

    it("returns the one organization a user belongs to", async () => {
      const user = await seedUser();
      const { organization, membership } = await joinOrganization(user, "Acme Corp", "acme-corp");

      const { memberships } = await service.getCurrentUser(principalFor(user));

      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toEqual({
        membershipId: membership._id.toString(),
        role: "owner",
        organization: {
          id: organization._id.toString(),
          name: "Acme Corp",
          slug: "acme-corp",
          status: "active",
        },
      });
    });

    it("returns every organization a user belongs to", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Acme", "acme", { role: "owner" });
      await joinOrganization(user, "Globex", "globex", { role: "agent" });
      await joinOrganization(user, "Initech", "initech", { role: "supervisor" });

      const { memberships } = await service.getCurrentUser(principalFor(user));

      expect(memberships).toHaveLength(3);
      expect(memberships.map((m) => m.organization.name)).toEqual(["Acme", "Globex", "Initech"]);
      expect(memberships.map((m) => m.role)).toEqual(["owner", "agent", "supervisor"]);
    });

    /*
      The isolation property, stated directly: one user's list must contain
      nothing belonging to another.
    */
    it("returns only the caller's own memberships", async () => {
      const ada = await seedUser({ email: "ada@example.com" });
      const grace = await seedUser({ email: "grace@example.com" });
      await joinOrganization(ada, "Ada Org", "ada-org");
      await joinOrganization(grace, "Grace Org", "grace-org");

      const adaResult = await service.getCurrentUser(principalFor(ada));
      const graceResult = await service.getCurrentUser(principalFor(grace));

      expect(adaResult.memberships.map((m) => m.organization.slug)).toEqual(["ada-org"]);
      expect(graceResult.memberships.map((m) => m.organization.slug)).toEqual(["grace-org"]);
    });

    it("does not list an organization a different user owns", async () => {
      const ada = await seedUser({ email: "ada@example.com" });
      const grace = await seedUser({ email: "grace@example.com" });
      await joinOrganization(grace, "Grace Only", "grace-only");

      const { memberships } = await service.getCurrentUser(principalFor(ada));

      expect(memberships).toEqual([]);
    });

    // The same gates requireOrganization applies, so no entry can 404 when
    // the switcher selects it (ADR-017 §9).
    it.each([
      ["an invited membership", { membershipStatus: "invited" as MembershipStatus }],
      ["a suspended membership", { membershipStatus: "suspended" as MembershipStatus }],
      ["a suspended organization", { orgStatus: "suspended" as OrganizationStatus }],
    ])("omits %s", async (_label, overrides) => {
      const user = await seedUser();
      await joinOrganization(user, "Hidden", "hidden", overrides);

      const { memberships } = await service.getCurrentUser(principalFor(user));

      expect(memberships).toEqual([]);
    });

    it("lists the reachable organizations and omits the unreachable ones together", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Reachable", "reachable");
      await joinOrganization(user, "Suspended Org", "suspended-org", { orgStatus: "suspended" });
      await joinOrganization(user, "Invited", "invited", { membershipStatus: "invited" });

      const { memberships } = await service.getCurrentUser(principalFor(user));

      expect(memberships.map((m) => m.organization.slug)).toEqual(["reachable"]);
    });

    /*
      ADR-016 §3 accepts an inert membership pointing at an organization whose
      write failed. It must be skipped rather than crash the payload.
    */
    it("skips a membership whose organization does not exist", async () => {
      const user = await seedUser();
      const { organization } = await joinOrganization(user, "Doomed", "doomed");
      await OrganizationModel.deleteOne({ _id: organization._id });

      const { memberships } = await service.getCurrentUser(principalFor(user));

      expect(memberships).toEqual([]);
    });

    // Mongo promises no order; a switcher that reshuffles is one people
    // mis-click (ADR-017 §9).
    it("orders deterministically by organization name", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Zebra", "zebra");
      await joinOrganization(user, "Alpha", "alpha");
      await joinOrganization(user, "Mango", "mango");

      const first = await service.getCurrentUser(principalFor(user));
      const second = await service.getCurrentUser(principalFor(user));

      expect(first.memberships.map((m) => m.organization.name)).toEqual(["Alpha", "Mango", "Zebra"]);
      expect(second.memberships.map((m) => m.organization.name)).toEqual(
        first.memberships.map((m) => m.organization.name),
      );
    });

    it("exposes only the approved organization fields", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Acme", "acme");

      const { memberships } = await service.getCurrentUser(principalFor(user));

      expect(Object.keys(memberships[0]!).sort()).toEqual(["membershipId", "organization", "role"]);
      expect(Object.keys(memberships[0]!.organization).sort()).toEqual(["id", "name", "slug", "status"]);
    });

    it("exposes no permission list", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Acme", "acme");

      const { memberships } = await service.getCurrentUser(principalFor(user));

      // A permission list in a payload invites a client to authorize itself
      // from it (ADR-017 §10).
      expect(memberships[0]).not.toHaveProperty("permissions");
      expect(JSON.stringify(memberships)).not.toContain("organization.read");
    });

    it("reports no current or active organization", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Acme", "acme");

      const result = await service.getCurrentUser(principalFor(user));

      // The server has no notion of "current"; the client chooses and the
      // server re-proves that choice per request (ADR-017 §1).
      expect(result).not.toHaveProperty("currentOrganizationId");
      expect(result).not.toHaveProperty("activeOrganizationId");
      expect(Object.keys(result).sort()).toEqual(["memberships", "user"]);
    });

    it("logs the membership count and not the organizations", async () => {
      const user = await seedUser();
      await joinOrganization(user, "Zzyzx Confidential", "zzyzx");
      const logger = createCapturingLogger();

      await service.getCurrentUser(principalFor(user), logger.log);

      expect(logger.serialized()).toContain("membershipCount");
      expect(logger.serialized()).not.toContain("Zzyzx Confidential");
      expect(logger.serialized()).not.toContain("zzyzx");
    });
  });
});
