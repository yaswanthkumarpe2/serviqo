import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConversationModel } from "../conversations/conversation.model";
import { conversationEvents } from "../conversations/conversationEvents";
import { conversationRepository } from "../conversations/conversation.repository";
import { MembershipModel } from "../memberships/membership.model";
import { membershipEvents } from "../memberships/membershipEvents";
import { can } from "../memberships/permissions";
import { OrganizationModel } from "../organizations/organization.model";
import { UserModel } from "../users/user.model";
import { createMemberService } from "./member.service";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationUpdatedEvent } from "../conversations/conversationEvents";
import type { MembershipRole, MembershipStatus } from "../memberships/membership.model";
import type { UserStatus } from "../users/user.model";

/**
 * Service-level coverage for team management (ADR-027), with a CAPTURING
 * LOGGER — which is the only way to audit ADR-027 §13's field sets.
 *
 * The integration suite drives the same operations through real HTTP and can
 * assert what reaches a RESPONSE. It cannot assert what reaches a LOG, because
 * `LOG_LEVEL` is `silent` under test and the module-scope pino logger writes
 * nothing. Passing an `AuthLogger` in — the seam `authLogging.ts` declared for
 * exactly this — makes every field of every event line assertable.
 *
 * What is asserted here and nowhere else:
 *
 * - No email, name, or password ever appears in a log payload, on any path,
 *   including the refusal paths where the submitted address is the thing an
 *   operator would most like to see (§13).
 * - `reason` exists on the refusals and never leaves the log.
 * - The domain events published by a removal carry the narrow projection and
 *   no roster data.
 */

/**
 * Sentinels that must never appear in a log line or an event payload.
 *
 * The email is made unique per tenant, because `User.email` is uniquely
 * indexed and several cases build two tenants — but every variant still
 * contains this prefix, so the absence assertions match on the shared part
 * and the fixture returns the exact value where a positive match is wanted.
 */
const SECRET_NAME = "Sentinel Personname";
const SECRET_EMAIL_PREFIX = "sentinel-person";

function createCapturingLogger() {
  const entries: { payload: Record<string, unknown>; message: string }[] = [];
  const record = (payload: Record<string, unknown>, message: string) => {
    entries.push({ payload, message });
  };
  return {
    log: { info: record, error: record } satisfies AuthLogger,
    entries,
    events: () => entries.map((entry) => entry.payload.event),
    find: (event: string) => entries.find((entry) => entry.payload.event === event)?.payload,
    serialized: () => entries.map((e) => `${JSON.stringify(e.payload)} ${e.message}`).join("\n"),
  };
}

/** Collects every conversation event published while a block runs. */
async function withPublishedEvents<T>(fn: () => Promise<T>): Promise<{ result: T; events: ConversationUpdatedEvent[] }> {
  const events: ConversationUpdatedEvent[] = [];
  const unsubscribe = conversationEvents.subscribe((event) => events.push(event));
  try {
    return { result: await fn(), events };
  } finally {
    unsubscribe();
  }
}

describe("memberService", () => {
  let mongoServer: MongoMemoryServer;
  const service = createMemberService();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await OrganizationModel.init();
    await MembershipModel.init();
    await ConversationModel.init();
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      OrganizationModel.deleteMany({}),
      MembershipModel.deleteMany({}),
      ConversationModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  let counter = 0;

  async function createUser(
    overrides: { name?: string; email?: string; status?: UserStatus; verified?: boolean } = {},
  ) {
    counter += 1;
    return UserModel.create({
      name: overrides.name ?? `Person ${counter}`,
      email: overrides.email ?? `person-${counter}@example.com`,
      passwordHash: "hashed-value",
      status: overrides.status ?? "active",
      emailVerifiedAt: (overrides.verified ?? true) ? new Date() : null,
    });
  }

  async function createOrganization(slug = `org-${(counter += 1)}`) {
    return OrganizationModel.create({ name: "Test Org", slug });
  }

  function addMembership(
    userId: mongoose.Types.ObjectId,
    organizationId: mongoose.Types.ObjectId,
    role: MembershipRole,
    status: MembershipStatus = "active",
  ) {
    return MembershipModel.create({ userId, organizationId, role, status });
  }

  /** An organization with an owner and one agent — the shape most cases need. */
  async function tenant() {
    const organization = await createOrganization();
    const ownerUser = await createUser({ name: "Owner Person" });
    counter += 1;
    const agentEmail = `${SECRET_EMAIL_PREFIX}-${counter}@example.com`;
    const agentUser = await createUser({ name: SECRET_NAME, email: agentEmail });
    const ownerMembership = await addMembership(ownerUser._id, organization._id, "owner");
    const agentMembership = await addMembership(agentUser._id, organization._id, "agent");

    return {
      organizationId: organization._id.toString(),
      actor: { userId: ownerUser._id.toString() },
      ownerMembershipId: ownerMembership._id.toString(),
      agentUser,
      agentEmail,
      agentMembershipId: agentMembership._id.toString(),
    };
  }

  // ---- listing ----

  describe("listMembers", () => {
    it("logs a count and never the roster itself", async () => {
      const { organizationId, actor } = await tenant();
      const capture = createCapturingLogger();

      await service.listMembers(organizationId, actor, capture.log);

      expect(capture.find("member.listed")).toEqual({
        event: "member.listed",
        organizationId,
        actorUserId: actor.userId,
        count: 2,
      });
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });

    it("returns an empty roster for an organization with no memberships", async () => {
      expect(
        await service.listMembers(new Types.ObjectId().toString(), { userId: new Types.ObjectId().toString() }),
      ).toEqual([]);
    });

    it("resolves a membership whose user no longer exists to a null user rather than throwing", async () => {
      const { organizationId, actor, agentUser } = await tenant();
      await UserModel.deleteOne({ _id: agentUser._id });

      const members = await service.listMembers(organizationId, actor);

      expect(members).toHaveLength(2);
      expect(members.find((m) => m.role === "agent")!.user).toBeNull();
    });
  });

  // ---- adding ----

  describe("addMember", () => {
    it("logs ids and the role, and never the submitted email", async () => {
      const { organizationId, actor } = await tenant();
      const newcomer = await createUser({ name: "Newcomer", email: "newcomer@example.com" });
      const capture = createCapturingLogger();

      await service.addMember(organizationId, { email: "newcomer@example.com", role: "agent" }, actor, capture.log);

      const line = capture.find("member.added")!;
      expect(line).toEqual({
        event: "member.added",
        organizationId,
        actorUserId: actor.userId,
        membershipId: expect.any(String),
        targetUserId: newcomer._id.toString(),
        role: "agent",
      });
      expect(capture.serialized()).not.toContain("newcomer@example.com");
      expect(capture.serialized()).not.toContain("Newcomer");
    });

    it("logs a refusal reason and NOT the probed email", async () => {
      const { organizationId, actor } = await tenant();
      const capture = createCapturingLogger();

      await expect(
        service.addMember(organizationId, { email: "probe@example.com", role: "agent" }, actor, capture.log),
      ).rejects.toMatchObject({ code: "MEMBER_NOT_INVITABLE" });

      expect(capture.find("member.add_refused")).toEqual({
        event: "member.add_refused",
        reason: "unknown_or_unverified_user",
        organizationId,
        actorUserId: actor.userId,
      });
      // The enumeration channel §5 bounds with a rate limit class must not be
      // re-opened in the log, which operators read without member.manage.
      expect(capture.serialized()).not.toContain("probe@example.com");
    });

    it("refuses an unverified account and a disabled one with the same reason string", async () => {
      const { organizationId, actor } = await tenant();
      await createUser({ email: "unverified@example.com", verified: false });
      await createUser({ email: "disabled@example.com", status: "disabled" });

      for (const email of ["unverified@example.com", "disabled@example.com"]) {
        const capture = createCapturingLogger();
        await expect(
          service.addMember(organizationId, { email, role: "agent" }, actor, capture.log),
        ).rejects.toMatchObject({ code: "MEMBER_NOT_INVITABLE" });
        expect(capture.find("member.add_refused")!.reason).toBe("unknown_or_unverified_user");
      }
    });

    it("records the acting user as invitedByUserId", async () => {
      const { organizationId, actor } = await tenant();
      const newcomer = await createUser({ email: "invited@example.com" });

      await service.addMember(organizationId, { email: "invited@example.com", role: "admin" }, actor);

      const stored = await MembershipModel.findOne({ userId: newcomer._id, organizationId });
      expect(stored!.invitedByUserId!.toString()).toBe(actor.userId);
      expect(stored!.status).toBe("active");
    });

    it("refuses a duplicate for every membership status", async () => {
      for (const status of ["active", "invited", "suspended"] as const) {
        const organization = await createOrganization();
        const owner = await createUser();
        await addMembership(owner._id, organization._id, "owner");
        const existing = await createUser({ email: `dup-${status}@example.com` });
        await addMembership(existing._id, organization._id, "agent", status);

        await expect(
          service.addMember(
            organization._id.toString(),
            { email: `dup-${status}@example.com`, role: "admin" },
            { userId: owner._id.toString() },
          ),
        ).rejects.toMatchObject({ code: "MEMBER_ALREADY_EXISTS" });

        expect(await MembershipModel.countDocuments({ userId: existing._id, organizationId: organization._id })).toBe(1);
      }
    });

    it("lets the unique index arbitrate two concurrent adds — one succeeds, one conflicts", async () => {
      const { organizationId, actor } = await tenant();
      await createUser({ email: "racer@example.com" });

      const outcomes = await Promise.allSettled([
        service.addMember(organizationId, { email: "racer@example.com", role: "agent" }, actor),
        service.addMember(organizationId, { email: "racer@example.com", role: "admin" }, actor),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === "rejected");
      expect(rejected).toBeDefined();
      // A 409, not the raw duplicate-key 500 the index would otherwise produce.
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "MEMBER_ALREADY_EXISTS" });
      expect(await MembershipModel.countDocuments({ organizationId })).toBe(3);
    });
  });

  // ---- role changes ----

  describe("changeRole", () => {
    it("logs the previous and new role, and no identity beyond ids", async () => {
      const { organizationId, actor, agentMembershipId, agentUser } = await tenant();
      const capture = createCapturingLogger();

      await service.changeRole(organizationId, agentMembershipId, "supervisor", actor, capture.log);

      expect(capture.find("member.role_changed")).toEqual({
        event: "member.role_changed",
        organizationId,
        actorUserId: actor.userId,
        membershipId: agentMembershipId,
        targetUserId: agentUser._id.toString(),
        previousRole: "agent",
        role: "supervisor",
        releasedConversations: 0,
      });
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });

    it("refuses the owner and logs owner_protected", async () => {
      const { organizationId, actor, ownerMembershipId } = await tenant();
      const capture = createCapturingLogger();

      await expect(
        service.changeRole(organizationId, ownerMembershipId, "admin", actor, capture.log),
      ).rejects.toMatchObject({ code: "ORGANIZATION_OWNER_PROTECTED" });

      expect(capture.find("member.role_change_refused")!.reason).toBe("owner_protected");
    });

    it("refuses self-modification and logs self_modification", async () => {
      const organization = await createOrganization();
      const admin = await createUser();
      const membership = await addMembership(admin._id, organization._id, "admin");
      const capture = createCapturingLogger();

      await expect(
        service.changeRole(
          organization._id.toString(),
          membership._id.toString(),
          "agent",
          { userId: admin._id.toString() },
          capture.log,
        ),
      ).rejects.toMatchObject({ code: "MEMBER_SELF_MODIFICATION" });

      expect(capture.find("member.role_change_refused")!.reason).toBe("self_modification");
    });

    it("refuses an unreachable membership and logs membership_not_found", async () => {
      const { organizationId, actor } = await tenant();
      const capture = createCapturingLogger();

      await expect(
        service.changeRole(organizationId, new Types.ObjectId().toString(), "admin", actor, capture.log),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect(capture.find("member.role_change_refused")!.reason).toBe("membership_not_found");
    });

    it("leaves assignments alone, because every current role holds conversation.assign", async () => {
      const { organizationId, actor, agentMembershipId, agentUser } = await tenant();
      const conversation = await conversationRepository.create(organizationId, new Types.ObjectId());
      await conversationRepository.claimForUser(conversation._id, organizationId, agentUser._id);

      const { events } = await withPublishedEvents(() =>
        service.changeRole(organizationId, agentMembershipId, "supervisor", actor),
      );

      expect(events).toEqual([]);
      expect((await ConversationModel.findById(conversation._id))!.assignedTo!.toString()).toBe(
        agentUser._id.toString(),
      );
    });
  });

  // ---- removal and assignment cleanup ----

  describe("removeMember", () => {
    it("logs the release count and no identity beyond ids", async () => {
      const { organizationId, actor, agentMembershipId, agentUser } = await tenant();
      const conversation = await conversationRepository.create(organizationId, new Types.ObjectId());
      await conversationRepository.claimForUser(conversation._id, organizationId, agentUser._id);
      const capture = createCapturingLogger();

      await service.removeMember(organizationId, agentMembershipId, actor, capture.log);

      expect(capture.find("member.removed")).toEqual({
        event: "member.removed",
        organizationId,
        actorUserId: actor.userId,
        membershipId: agentMembershipId,
        targetUserId: agentUser._id.toString(),
        role: "agent",
        releasedConversations: 1,
      });
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });

    it("publishes one conversation event per released conversation", async () => {
      const { organizationId, actor, agentMembershipId, agentUser } = await tenant();
      const first = await conversationRepository.create(organizationId, new Types.ObjectId());
      const second = await conversationRepository.create(organizationId, new Types.ObjectId());
      for (const conversation of [first, second]) {
        await conversationRepository.claimForUser(conversation._id, organizationId, agentUser._id);
      }

      const { result, events } = await withPublishedEvents(() =>
        service.removeMember(organizationId, agentMembershipId, actor),
      );

      expect(result.releasedConversations).toBe(2);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.conversationId).sort()).toEqual(
        [first._id.toString(), second._id.toString()].sort(),
      );
      for (const event of events) {
        expect(event.organizationId).toBe(organizationId);
        expect(event.conversation.assignedTo).toBeNull();
      }
    });

    it("publishes a payload carrying no roster data", async () => {
      const { organizationId, actor, agentMembershipId, agentUser } = await tenant();
      const conversation = await conversationRepository.create(organizationId, new Types.ObjectId());
      await conversationRepository.claimForUser(conversation._id, organizationId, agentUser._id);

      const { events } = await withPublishedEvents(() =>
        service.removeMember(organizationId, agentMembershipId, actor),
      );

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(SECRET_NAME);
      expect(serialized).not.toContain(SECRET_EMAIL_PREFIX);
      expect(serialized).not.toContain("customer");
    });

    it("returns the removed member's identity for the response, read before the delete", async () => {
      const { organizationId, actor, agentMembershipId, agentUser, agentEmail } = await tenant();

      const { removed } = await service.removeMember(organizationId, agentMembershipId, actor);

      expect(removed.user).toEqual({
        id: agentUser._id.toString(),
        name: SECRET_NAME,
        email: agentEmail,
      });
    });

    it("refuses the owner and logs owner_protected", async () => {
      const { organizationId, actor, ownerMembershipId } = await tenant();
      const capture = createCapturingLogger();

      await expect(
        service.removeMember(organizationId, ownerMembershipId, actor, capture.log),
      ).rejects.toMatchObject({ code: "ORGANIZATION_OWNER_PROTECTED" });

      expect(capture.find("member.remove_refused")!.reason).toBe("owner_protected");
      expect(await MembershipModel.findById(ownerMembershipId)).not.toBeNull();
    });

    it("refuses self-removal", async () => {
      const organization = await createOrganization();
      const admin = await createUser();
      const membership = await addMembership(admin._id, organization._id, "admin");

      await expect(
        service.removeMember(organization._id.toString(), membership._id.toString(), {
          userId: admin._id.toString(),
        }),
      ).rejects.toMatchObject({ code: "MEMBER_SELF_MODIFICATION" });
    });

    it("cannot be aimed at another organization's membership", async () => {
      const a = await tenant();
      const b = await tenant();

      await expect(
        service.removeMember(a.organizationId, b.agentMembershipId, a.actor),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect(await MembershipModel.findById(b.agentMembershipId)).not.toBeNull();
    });

    it("releases nothing and publishes nothing when the member held no conversations", async () => {
      const { organizationId, actor, agentMembershipId } = await tenant();
      await conversationRepository.create(organizationId, new Types.ObjectId());

      const { result, events } = await withPublishedEvents(() =>
        service.removeMember(organizationId, agentMembershipId, actor),
      );

      expect(result.releasedConversations).toBe(0);
      expect(events).toEqual([]);
    });
  });

  // ---- the complete log audit ----

  describe("log field audit (ADR-027 §13)", () => {
    it("emits only the documented events, with no email, name, or credential in any of them", async () => {
      const { organizationId, actor, agentMembershipId, ownerMembershipId } = await tenant();
      const newcomer = await createUser({ name: "Grace Hopper", email: "grace@example.com" });
      const capture = createCapturingLogger();

      await service.listMembers(organizationId, actor, capture.log);
      await service.addMember(organizationId, { email: "grace@example.com", role: "agent" }, actor, capture.log);
      await service
        .addMember(organizationId, { email: "grace@example.com", role: "admin" }, actor, capture.log)
        .catch(() => undefined);
      await service
        .addMember(organizationId, { email: "ghost@example.com", role: "admin" }, actor, capture.log)
        .catch(() => undefined);
      await service.changeRole(organizationId, agentMembershipId, "supervisor", actor, capture.log);
      await service.changeRole(organizationId, ownerMembershipId, "admin", actor, capture.log).catch(() => undefined);
      await service.removeMember(organizationId, agentMembershipId, actor, capture.log);
      await service.removeMember(organizationId, ownerMembershipId, actor, capture.log).catch(() => undefined);

      expect(capture.events()).toEqual([
        "member.listed",
        "member.added",
        "member.add_refused",
        "member.add_refused",
        "member.role_changed",
        "member.role_change_refused",
        "member.removed",
        "member.remove_refused",
      ]);

      const output = capture.serialized();
      for (const forbidden of [
        SECRET_NAME,
        SECRET_EMAIL_PREFIX,
        "Grace Hopper",
        "grace@example.com",
        "ghost@example.com",
        "hashed-value",
        "passwordHash",
        "Bearer ",
        "Owner Person",
      ]) {
        expect(output).not.toContain(forbidden);
      }

      // The ids ARE present — an operator needs them to answer "who did what".
      expect(output).toContain(actor.userId);
      expect(output).toContain(newcomer._id.toString());
    });
  });

  // ==================== suspension / reactivation (ADR-029) ====================

  describe("changeStatus", () => {
    /** One conversation in this tenant, claimed by the given user. */
    async function assignedConversation(organizationId: string, userId: string) {
      const conversation = await conversationRepository.create(organizationId, new Types.ObjectId());
      await conversationRepository.claimForUser(conversation._id, organizationId, userId);
      return conversation;
    }

    /** Collects every membership-revoked event published while a block runs. */
    async function withRevocations<T>(fn: () => Promise<T>) {
      const events: { organizationId: string; userId: string; reason: string }[] = [];
      const unsubscribe = membershipEvents.subscribe((event) => events.push(event));
      try {
        return { result: await fn(), events };
      } finally {
        unsubscribe();
      }
    }

    // ---- the two transitions that exist ----

    it("suspends an active member", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();

      const { member } = await service.changeStatus(
        t.organizationId,
        t.agentMembershipId,
        "suspended",
        t.actor,
        capture.log,
      );

      expect(member.status).toBe("suspended");
      expect((await MembershipModel.findById(t.agentMembershipId))!.status).toBe("suspended");
    });

    it("reactivates a suspended member", async () => {
      const t = await tenant();
      await MembershipModel.updateOne({ _id: t.agentMembershipId }, { $set: { status: "suspended" } });

      const { member } = await service.changeStatus(t.organizationId, t.agentMembershipId, "active", {
        userId: t.actor.userId,
      });

      expect(member.status).toBe("active");
      expect((await MembershipModel.findById(t.agentMembershipId))!.status).toBe("active");
    });

    it("writes no field other than status", async () => {
      const t = await tenant();

      await service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor);

      const stored = await MembershipModel.findById(t.agentMembershipId);
      expect(stored!.role).toBe("agent");
      expect(stored!.organizationId.toString()).toBe(t.organizationId);
    });

    // ---- the transitions that do not (ADR-029 §6) ----

    it.each([
      ["active", "active"],
      ["suspended", "suspended"],
    ] as const)("refuses the no-op %s → %s rather than absorbing it", async (from, to) => {
      const t = await tenant();
      await MembershipModel.updateOne({ _id: t.agentMembershipId }, { $set: { status: from } });

      await expect(
        service.changeStatus(t.organizationId, t.agentMembershipId, to, t.actor),
      ).rejects.toMatchObject({ code: "MEMBER_STATUS_TRANSITION_INVALID", httpStatus: 409 });

      expect((await MembershipModel.findById(t.agentMembershipId))!.status).toBe(from);
    });

    it.each([["active"], ["suspended"]] as const)(
      "refuses an invited membership going to %s",
      async (to) => {
        const t = await tenant();
        await MembershipModel.updateOne({ _id: t.agentMembershipId }, { $set: { status: "invited" } });

        await expect(
          service.changeStatus(t.organizationId, t.agentMembershipId, to, t.actor),
        ).rejects.toMatchObject({ code: "MEMBER_STATUS_TRANSITION_INVALID" });

        expect((await MembershipModel.findById(t.agentMembershipId))!.status).toBe("invited");
      },
    );

    // ---- the structural refusals (ADR-029 §7) ----

    /*
      A SUSPENDED OWNER is a fourth route to ADR-016 §3's unrecoverable tenant:
      an owner who cannot sign in, nobody able to administer the organization,
      and nobody able to transfer it out because `organization.transfer_ownership`
      is owner-only (ADR-028 §2).
    */
    it("refuses to suspend the owner", async () => {
      const t = await tenant();
      const ownerMembership = await MembershipModel.findOne({
        organizationId: t.organizationId,
        role: "owner",
      });

      await expect(
        service.changeStatus(t.organizationId, ownerMembership!._id.toString(), "suspended", {
          userId: t.agentUser._id.toString(),
        }),
      ).rejects.toMatchObject({ code: "ORGANIZATION_OWNER_PROTECTED", httpStatus: 409 });

      expect((await MembershipModel.findById(ownerMembership!._id))!.status).toBe("active");
    });

    it("leaves exactly one active owner after an owner suspension is refused", async () => {
      const t = await tenant();
      const ownerMembership = await MembershipModel.findOne({
        organizationId: t.organizationId,
        role: "owner",
      });

      await service
        .changeStatus(t.organizationId, ownerMembership!._id.toString(), "suspended", { userId: t.agentUser._id.toString() })
        .catch(() => undefined);

      const owners = await MembershipModel.find({ organizationId: t.organizationId, role: "owner" });
      expect(owners).toHaveLength(1);
      expect(owners[0]!.status).toBe("active");
    });

    it("refuses the caller's own membership", async () => {
      const t = await tenant();

      await expect(
        service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", { userId: t.agentUser._id.toString() }),
      ).rejects.toMatchObject({ code: "MEMBER_SELF_MODIFICATION" });
    });

    it("refuses an unknown membership with the generic not-found error", async () => {
      const t = await tenant();

      await expect(
        service.changeStatus(t.organizationId, new Types.ObjectId().toString(), "suspended", {
          userId: t.actor.userId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    });

    /*
      ADR-029 §5 — isolation produced by the query. Another tenant's membership
      is refused IDENTICALLY to one that does not exist.
    */
    it("refuses another organization's membership identically to an unknown one", async () => {
      const t = await tenant();
      const other = await tenant();

      const crossTenant = await service
        .changeStatus(t.organizationId, other.agentMembershipId, "suspended", t.actor)
        .catch((e: Error) => e);
      const unknown = await service
        .changeStatus(t.organizationId, new Types.ObjectId().toString(), "suspended", t.actor)
        .catch((e: Error) => e);

      expect(crossTenant).toMatchObject({ code: "NOT_FOUND" });
      expect((crossTenant as Error).message).toBe((unknown as Error).message);
      expect((await MembershipModel.findById(other.agentMembershipId))!.status).toBe("active");
    });

    // ---- assignment cleanup (ADR-029 §10) ----

    it("releases the suspended member's conversations and publishes each one", async () => {
      const t = await tenant();
      const first = await assignedConversation(t.organizationId, t.agentUser._id.toString());
      const second = await assignedConversation(t.organizationId, t.agentUser._id.toString());

      const { result, events } = await withPublishedEvents(() =>
        service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor),
      );

      expect(result.releasedConversations).toBe(2);
      expect(events).toHaveLength(2);
      expect((await ConversationModel.findById(first._id))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(second._id))!.assignedTo).toBeNull();
    });

    /* The conversations themselves survive — only the assignment is cleared. */
    it("preserves the conversations it releases", async () => {
      const t = await tenant();
      const conversation = await assignedConversation(t.organizationId, t.agentUser._id.toString());

      await service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor);

      const stored = await ConversationModel.findById(conversation._id);
      expect(stored).not.toBeNull();
      expect(stored!.organizationId.toString()).toBe(t.organizationId);
      expect(stored!.status).toBe(conversation.status);
    });

    it("does not touch another member's assignments", async () => {
      const t = await tenant();
      const theirs = await assignedConversation(t.organizationId, t.agentUser._id.toString());
      const ownersOwn = await assignedConversation(t.organizationId, t.actor.userId);

      await service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor);

      expect((await ConversationModel.findById(theirs._id))!.assignedTo).toBeNull();
      expect((await ConversationModel.findById(ownersOwn._id))!.assignedTo!.toString()).toBe(t.actor.userId);
    });

    /*
      UNCONDITIONAL, not `can()`-derived (ADR-029 §10). Under today's catalogue
      `agent` holds `conversation.assign`, so a `can()`-gated release would
      release NOTHING and strand the conversations on someone locked out —
      exactly ADR-026 §15's hole reopened. This asserts the premise directly.
    */
    it("releases even though the suspended member's role still holds conversation.assign", async () => {
      const t = await tenant();
      await assignedConversation(t.organizationId, t.agentUser._id.toString());

      const { releasedConversations } = await service.changeStatus(
        t.organizationId,
        t.agentMembershipId,
        "suspended",
        t.actor,
      );

      expect(can("agent", "conversation.assign")).toBe(true);
      expect(releasedConversations).toBe(1);
    });

    /* ADR-029 §10: reactivation restores access and NOTHING else. */
    it("does not restore assignments on reactivation", async () => {
      const t = await tenant();
      const conversation = await assignedConversation(t.organizationId, t.agentUser._id.toString());

      await service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor);
      const { result, events } = await withPublishedEvents(() =>
        service.changeStatus(t.organizationId, t.agentMembershipId, "active", t.actor),
      );

      expect(result.releasedConversations).toBe(0);
      expect(events).toEqual([]);
      expect((await ConversationModel.findById(conversation._id))!.assignedTo).toBeNull();
    });

    // ---- the revocation seam (ADR-029 §9) ----

    it("publishes a revocation when suspending", async () => {
      const t = await tenant();

      const { events } = await withRevocations(() =>
        service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor),
      );

      expect(events).toEqual([
        { organizationId: t.organizationId, userId: t.agentUser._id.toString(), reason: "suspended" },
      ]);
    });

    /* Reactivation is not a revocation — a "reconnect now" push would be a
       client instruction, which this seam is not. */
    it("publishes nothing when reactivating", async () => {
      const t = await tenant();
      await MembershipModel.updateOne({ _id: t.agentMembershipId }, { $set: { status: "suspended" } });

      const { events } = await withRevocations(() =>
        service.changeStatus(t.organizationId, t.agentMembershipId, "active", t.actor),
      );

      expect(events).toEqual([]);
    });

    it("publishes nothing when the transition is refused", async () => {
      const t = await tenant();

      const { events } = await withRevocations(async () =>
        service
          .changeStatus(t.organizationId, t.agentMembershipId, "active", t.actor)
          .catch(() => undefined),
      );

      expect(events).toEqual([]);
    });

    /*
      ADR-029 §9's second writer. Removal produces the identical revoked state
      and had the identical live-socket hole; one subscriber, two writers.
    */
    it("publishes a revocation when a member is removed", async () => {
      const t = await tenant();

      const { events } = await withRevocations(() =>
        service.removeMember(t.organizationId, t.agentMembershipId, t.actor),
      );

      expect(events).toEqual([{ organizationId: t.organizationId, userId: t.agentUser._id.toString(), reason: "removed" }]);
    });

    it("carries only two ids and a reason — never a name, an email, or a role", () => {
      const seen: Record<string, unknown>[] = [];
      const unsubscribe = membershipEvents.subscribe((event) => seen.push(event as unknown as Record<string, unknown>));
      membershipEvents.publish({ organizationId: "org", userId: "user", reason: "suspended" });
      unsubscribe();

      expect(Object.keys(seen[0]!).sort()).toEqual(["organizationId", "reason", "userId"]);
    });

    // ---- log hygiene (ADR-029 §12) ----

    it("logs ids, statuses, and a count — never a name or an email", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();

      await service.changeStatus(t.organizationId, t.agentMembershipId, "suspended", t.actor, capture.log);

      expect(capture.find("member.status_changed")).toMatchObject({
        organizationId: t.organizationId,
        actorUserId: t.actor.userId,
        membershipId: t.agentMembershipId,
        targetUserId: t.agentUser._id.toString(),
        previousStatus: "active",
        status: "suspended",
        role: "agent",
        releasedConversations: 0,
      });
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
      expect(capture.serialized()).not.toContain("hashed-value");
    });

    it.each([
      ["invalid_transition", "active" as const],
    ])("puts %s in the log and never in the thrown error", async (reason, to) => {
      const t = await tenant();
      const capture = createCapturingLogger();

      const error = await service
        .changeStatus(t.organizationId, t.agentMembershipId, to, t.actor, capture.log)
        .catch((e: Error) => e);

      expect(capture.find("member.status_change_refused")).toMatchObject({ reason });
      expect((error as Error).message).not.toContain(reason);
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });

    it("never logs a name or an email when refusing the owner", async () => {
      const t = await tenant();
      const ownerMembership = await MembershipModel.findOne({
        organizationId: t.organizationId,
        role: "owner",
      });
      const capture = createCapturingLogger();

      await service
        .changeStatus(t.organizationId, ownerMembership!._id.toString(), "suspended", { userId: t.agentUser._id.toString() }, capture.log)
        .catch(() => undefined);

      expect(capture.find("member.status_change_refused")).toMatchObject({ reason: "owner_protected" });
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });
  });
});
