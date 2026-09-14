import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OrganizationNotAccessibleError } from "../lib/errors";
import { MembershipModel } from "../modules/memberships/membership.model";
import { OrganizationModel } from "../modules/organizations/organization.model";
import { UserModel } from "../modules/users/user.model";
import { requireOrganization } from "./requireOrganization";

import type { MembershipRole, MembershipStatus } from "../modules/memberships/membership.model";
import type { OrganizationStatus } from "../modules/organizations/organization.model";
import type { UserDocument } from "../modules/users/user.model";
import type { NextFunction, Request, Response } from "express";

const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$DO_NOT_LEAK$DO_NOT_LEAK";
const SESSION_ID = "507f191e810c19729de860ec";
/** Well-formed and belonging to nothing. */
const UNKNOWN_ORGANIZATION_ID = "507f1f77bcf86cd799439099";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A request as `requireAccessToken` would have left it, plus a path param. */
function fakeRequest(userId: string | undefined, organizationId: unknown) {
  const log = fakeLog();
  const req = {
    log,
    principal: userId === undefined ? undefined : { userId, sessionId: SESSION_ID },
    params: { organizationId },
  } as unknown as Request;

  return { req, log };
}

async function run(userId: string | undefined, organizationId: unknown) {
  const { req, log } = fakeRequest(userId, organizationId);
  const next = vi.fn() as unknown as NextFunction;

  await requireOrganization(req, {} as Response, next);

  return { req, log, next: next as unknown as ReturnType<typeof vi.fn> };
}

const errorFrom = (next: ReturnType<typeof vi.fn>): unknown => next.mock.calls[0]?.[0];

/** The `reason` recorded on a refusal — the one place the distinctions exist. */
function refusalReason(log: ReturnType<typeof fakeLog>): string {
  const [payload] = log.info.mock.calls[0] as [{ reason: string }];
  return payload.reason;
}

async function seedUser(email: string): Promise<UserDocument> {
  return UserModel.create({
    name: "Ada Lovelace",
    email,
    passwordHash: PASSWORD_HASH,
    emailVerifiedAt: new Date(),
    status: "active",
  });
}

async function seedOrganization(
  user: UserDocument,
  slug: string,
  overrides: {
    role?: MembershipRole;
    membershipStatus?: MembershipStatus;
    orgStatus?: OrganizationStatus;
  } = {},
) {
  const organization = await OrganizationModel.create({
    name: `Org ${slug}`,
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

describe("requireOrganization", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
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

  // ---- the ordinary case ----

  describe("an active membership in an active organization", () => {
    it("continues to the handler", async () => {
      const user = await seedUser("ada@example.com");
      const { organization } = await seedOrganization(user, "acme");

      const { next } = await run(user._id.toString(), organization._id.toString());

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith();
    });

    it("attaches the organization context", async () => {
      const user = await seedUser("ada@example.com");
      const { organization, membership } = await seedOrganization(user, "acme", { role: "admin" });

      const { req } = await run(user._id.toString(), organization._id.toString());

      expect(req.organizationContext).toEqual({
        organizationId: organization._id.toString(),
        role: "admin",
        membershipId: membership._id.toString(),
        viaPlatformAdmin: false,
      });
    });

    /*
      The role is read from the database on every request — not from the token
      (ADR-011 §2), not from the session (ADR-004 §8). This is what makes a
      revoked role take effect on the next request rather than at token expiry.
    */
    it.each<[MembershipRole]>([["owner"], ["admin"], ["supervisor"], ["agent"]])(
      "resolves the %s role from the database",
      async (role) => {
        const user = await seedUser("ada@example.com");
        const { organization } = await seedOrganization(user, "acme", { role });

        const { req } = await run(user._id.toString(), organization._id.toString());

        expect(req.organizationContext?.role).toBe(role);
      },
    );

    it("reflects a role changed after the token was issued", async () => {
      const user = await seedUser("ada@example.com");
      const { organization, membership } = await seedOrganization(user, "acme", { role: "owner" });

      await MembershipModel.updateOne({ _id: membership._id }, { $set: { role: "agent" } });
      const { req } = await run(user._id.toString(), organization._id.toString());

      expect(req.organizationContext?.role).toBe("agent");
    });
  });

  // ---- the four gates (ADR-017 §2) ----

  describe("refusals", () => {
    it("refuses a caller who is not a member", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");
      const { organization } = await seedOrganization(grace, "grace-org");

      const { next, log, req } = await run(ada._id.toString(), organization._id.toString());

      expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
      expect(refusalReason(log)).toBe("not_a_member");
      expect(req.organizationContext).toBeUndefined();
    });

    it.each<[MembershipStatus]>([["invited"], ["suspended"]])(
      "refuses a membership whose status is %s",
      async (membershipStatus) => {
        const user = await seedUser("ada@example.com");
        const { organization } = await seedOrganization(user, "acme", { membershipStatus });

        const { next, log } = await run(user._id.toString(), organization._id.toString());

        expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
        expect(refusalReason(log)).toBe("membership_not_active");
      },
    );

    it("refuses a suspended organization", async () => {
      const user = await seedUser("ada@example.com");
      const { organization } = await seedOrganization(user, "acme", { orgStatus: "suspended" });

      const { next, log } = await run(user._id.toString(), organization._id.toString());

      expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
      expect(refusalReason(log)).toBe("organization_not_active");
    });

    /*
      ADR-016 §3's binding requirement: "a membership is a claim about a
      tenant, not proof the tenant exists", and ADR-016 §3 records how an
      orphaned membership becomes reachable — a crash between onboarding's
      two writes.
    */
    it("refuses a membership pointing at an organization that does not exist", async () => {
      const user = await seedUser("ada@example.com");
      const { organization } = await seedOrganization(user, "doomed");
      await OrganizationModel.deleteOne({ _id: organization._id });

      const { next, log } = await run(user._id.toString(), organization._id.toString());

      expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
      expect(refusalReason(log)).toBe("unknown_organization");
    });

    it("refuses an organization id that belongs to nothing", async () => {
      const user = await seedUser("ada@example.com");

      const { next, log } = await run(user._id.toString(), UNKNOWN_ORGANIZATION_ID);

      expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
      // Not a member is proved before the organization is even looked up.
      expect(refusalReason(log)).toBe("not_a_member");
    });

    // A CastError reaching errorHandler would report a mistyped URL as a
    // server fault (ADR-017 §1).
    it.each([["not-an-object-id"], [""], ["12345"], ["zzzzzzzzzzzzzzzzzzzzzzzz"]])(
      "refuses the malformed id %j without a CastError",
      async (organizationId) => {
        const user = await seedUser("ada@example.com");

        const { next, log } = await run(user._id.toString(), organizationId);

        expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
        expect(refusalReason(log)).toBe("malformed_organization_id");
      },
    );

    it("refuses a missing organization id", async () => {
      const user = await seedUser("ada@example.com");

      const { next } = await run(user._id.toString(), undefined);

      expect(errorFrom(next)).toBeInstanceOf(OrganizationNotAccessibleError);
    });

    /*
      Every gate answers 404 indistinguishably (ADR-017 §6). A 403 for "not a
      member" would confirm the organization exists, turning any authenticated
      account into an oracle for which tenant ids are real.
    */
    it("answers every refusal with the same status, code, and message", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");
      const foreign = await seedOrganization(grace, "grace-org");
      const invited = await seedOrganization(ada, "invited-org", { membershipStatus: "invited" });
      const suspendedOrg = await seedOrganization(ada, "suspended-org", { orgStatus: "suspended" });

      const responses = await Promise.all([
        run(ada._id.toString(), foreign.organization._id.toString()),
        run(ada._id.toString(), invited.organization._id.toString()),
        run(ada._id.toString(), suspendedOrg.organization._id.toString()),
        run(ada._id.toString(), UNKNOWN_ORGANIZATION_ID),
        run(ada._id.toString(), "not-an-object-id"),
      ]);

      const described = responses.map(({ next }) => {
        const error = errorFrom(next) as OrganizationNotAccessibleError;
        return JSON.stringify({ status: error.httpStatus, code: error.code, message: error.message });
      });

      expect(new Set(described).size).toBe(1);
      expect(JSON.parse(described[0]!).status).toBe(404);
      expect(JSON.parse(described[0]!).code).toBe("NOT_FOUND");
    });

    it("distinguishes the reasons only in the log", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");
      const foreign = await seedOrganization(grace, "grace-org");
      const invited = await seedOrganization(ada, "invited-org", { membershipStatus: "invited" });

      const notMember = await run(ada._id.toString(), foreign.organization._id.toString());
      const notActive = await run(ada._id.toString(), invited.organization._id.toString());

      expect(refusalReason(notMember.log)).toBe("not_a_member");
      expect(refusalReason(notActive.log)).toBe("membership_not_active");
    });
  });

  // ---- tenant isolation ----

  describe("tenant isolation", () => {
    it("does not let one member of an organization reach another organization", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");
      const adaOrg = await seedOrganization(ada, "ada-org");
      const graceOrg = await seedOrganization(grace, "grace-org");

      const own = await run(ada._id.toString(), adaOrg.organization._id.toString());
      const foreign = await run(ada._id.toString(), graceOrg.organization._id.toString());

      expect(own.next).toHaveBeenCalledWith();
      expect(errorFrom(foreign.next)).toBeInstanceOf(OrganizationNotAccessibleError);
    });

    /*
      Two users in the SAME organization with different roles: the context must
      reflect the caller's own membership, not the other's.
    */
    it("resolves each member's own role in a shared organization", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");
      const { organization } = await seedOrganization(ada, "shared", { role: "owner" });
      await MembershipModel.create({
        userId: grace._id,
        organizationId: organization._id,
        role: "agent",
        status: "active",
      });

      const adaContext = await run(ada._id.toString(), organization._id.toString());
      const graceContext = await run(grace._id.toString(), organization._id.toString());

      expect(adaContext.req.organizationContext?.role).toBe("owner");
      expect(graceContext.req.organizationContext?.role).toBe("agent");
    });
  });

  /*
    Mounting this without requireAccessToken would be an unauthenticated route
    reading a tenant. Failing loudly is the only safe response.
  */
  describe("mounted without requireAccessToken", () => {
    it("raises rather than resolving a context", async () => {
      const { next, req } = await run(undefined, UNKNOWN_ORGANIZATION_ID);

      const error = errorFrom(next);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OrganizationNotAccessibleError);
      expect((error as Error).message).toContain("requireAccessToken");
      expect(req.organizationContext).toBeUndefined();
    });
  });

  // ---- logging ----

  describe("logging", () => {
    it("records the ids an operator correlates on", async () => {
      const ada = await seedUser("ada@example.com");
      const grace = await seedUser("grace@example.com");
      const { organization } = await seedOrganization(grace, "grace-org");

      const { log } = await run(ada._id.toString(), organization._id.toString());

      const [payload] = log.info.mock.calls[0] as [Record<string, unknown>];
      expect(payload.event).toBe("auth.organization.rejected");
      expect(payload.userId).toBe(ada._id.toString());
      expect(payload.organizationId).toBe(organization._id.toString());
    });

    it("logs nothing when it allows a request", async () => {
      const user = await seedUser("ada@example.com");
      const { organization } = await seedOrganization(user, "acme");

      const { log } = await run(user._id.toString(), organization._id.toString());

      expect(log.info).not.toHaveBeenCalled();
    });

    it("leaks no organization name or credential material", async () => {
      const user = await seedUser("ada@example.com");
      const { organization } = await seedOrganization(user, "confidential-slug");
      await OrganizationModel.updateOne({ _id: organization._id }, { $set: { status: "suspended" } });

      const { log } = await run(user._id.toString(), organization._id.toString());

      const serialized = JSON.stringify(log.info.mock.calls);
      expect(serialized).not.toContain("Org confidential-slug");
      expect(serialized).not.toContain(PASSWORD_HASH);
      expect(serialized).not.toContain("$argon2");
    });
  });
});
