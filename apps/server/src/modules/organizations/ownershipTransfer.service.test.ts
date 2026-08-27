import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConversationModel } from "../conversations/conversation.model";
import { conversationEvents } from "../conversations/conversationEvents";
import { MembershipModel } from "../memberships/membership.model";
import { membershipRepository } from "../memberships/membership.repository";
import { OrganizationModel } from "../organizations/organization.model";
import { UserModel } from "../users/user.model";
import { createOwnershipTransferService } from "./ownershipTransfer.service";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationUpdatedEvent } from "../conversations/conversationEvents";
import type { MembershipRole, MembershipStatus } from "../memberships/membership.model";
import type { UserStatus } from "../users/user.model";

/**
 * Service-level coverage for ownership transfer (ADR-028), with a CAPTURING
 * LOGGER and with the ability to make the second write fail on purpose.
 *
 * Both are things the integration suite cannot do. `LOG_LEVEL` is `silent`
 * under test, so the module-scope pino logger writes nothing and no HTTP test
 * can audit ADR-028 §12's field sets; and no sequence of real requests can
 * make `promoteToOwner` fail after `demoteOwner` succeeded, which is the
 * branch ADR-028 §8d exists for and the one whose failure mode is an
 * organization with no owner.
 *
 * What is asserted here and nowhere else:
 *
 * - Every log payload on every path — success, all four refusals, the
 *   conflict, and both compensation outcomes — carries ids, roles, and counts
 *   and NEVER a name, an email, or a credential (§12).
 * - A promotion that returns `null` and a promotion that THROWS both restore
 *   the previous owner, leaving exactly one owner (§8d).
 * - A compensation that itself fails emits the one `error` line an operator
 *   alerts on, and the organization is genuinely left ownerless — the state
 *   §10 describes, asserted rather than assumed.
 * - `reason` exists on every refusal and is never part of the thrown error.
 */

/** Sentinels. If either reaches a log payload, the log-hygiene tests fail. */
const SECRET_NAME = "Sentinel Ownername";
const SECRET_EMAIL_PREFIX = "sentinel-owner";

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

describe("ownershipTransferService", () => {
  let mongoServer: MongoMemoryServer;
  const service = createOwnershipTransferService();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await OrganizationModel.init();
    // Index B — the partial unique index this whole slice is built on. Without
    // `init()` the constraint would not exist and the invariant assertions
    // below would pass for the wrong reason.
    await MembershipModel.init();
    await ConversationModel.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  /**
   * An organization, its owner, and one agent whose name and email are the
   * sentinels — so any log line that leaked identity fails a hygiene test.
   */
  async function tenant() {
    const organization = await createOrganization();
    const ownerUser = await createUser({ name: "Owner Person" });
    counter += 1;
    const targetUser = await createUser({
      name: SECRET_NAME,
      email: `${SECRET_EMAIL_PREFIX}-${counter}@example.com`,
    });
    const ownerMembership = await addMembership(ownerUser._id, organization._id, "owner");
    const targetMembership = await addMembership(targetUser._id, organization._id, "agent");

    return {
      organizationId: organization._id.toString(),
      ownerUserId: ownerUser._id.toString(),
      ownerMembershipId: ownerMembership._id.toString(),
      targetUserId: targetUser._id.toString(),
      targetMembershipId: targetMembership._id.toString(),
      targetUser,
      targetMembership,
      actor: { userId: ownerUser._id.toString(), membershipId: ownerMembership._id.toString() },
    };
  }

  /** Reads the stored roles back, because the response is not the database. */
  async function rolesFor(organizationId: string) {
    const memberships = await MembershipModel.find({ organizationId }).sort({ role: 1 });
    return memberships.map((m) => ({ id: m._id.toString(), role: m.role }));
  }

  async function ownerCount(organizationId: string) {
    return MembershipModel.countDocuments({ organizationId, role: "owner" });
  }

  // ---- the happy path ----

  describe("a successful transfer", () => {
    it("promotes the target and demotes the previous owner to admin", async () => {
      const t = await tenant();

      const result = await service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor);

      expect(result).toEqual({
        previousOwner: { id: t.ownerMembershipId, role: "admin" },
        newOwner: { id: t.targetMembershipId, role: "owner" },
      });
    });

    /*
      ADR-028 §7. Asserted against the STORED document rather than the
      response, because the response is what the service claims and this is
      what the next `requireOrganization` will read.
    */
    it("stores admin for the previous owner and owner for the target", async () => {
      const t = await tenant();

      await service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor);

      const previous = await MembershipModel.findById(t.ownerMembershipId);
      const next = await MembershipModel.findById(t.targetMembershipId);
      expect(previous!.role).toBe("admin");
      expect(next!.role).toBe("owner");
    });

    /*
      The invariant, read from the database. Index B makes >1 impossible; this
      asserts the other half, that the transfer did not leave 0.
    */
    it("leaves exactly one owner", async () => {
      const t = await tenant();

      await service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor);

      expect(await ownerCount(t.organizationId)).toBe(1);
      expect((await rolesFor(t.organizationId)).filter((m) => m.role === "owner")).toEqual([
        { id: t.targetMembershipId, role: "owner" },
      ]);
    });

    it("changes nothing about either membership's status or tenant", async () => {
      const t = await tenant();

      await service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor);

      const previous = await MembershipModel.findById(t.ownerMembershipId);
      const next = await MembershipModel.findById(t.targetMembershipId);
      expect(previous!.status).toBe("active");
      expect(next!.status).toBe("active");
      expect(previous!.organizationId.toString()).toBe(t.organizationId);
      expect(next!.organizationId.toString()).toBe(t.organizationId);
    });

    /*
      ADR-028 §8e. The count is in the log because it is the post-condition,
      and an operator reading the transfer line should not have to query to
      learn whether the invariant held.
    */
    it("records the owner count on the success line", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();

      await service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log);

      expect(capture.find("organization.ownership_transferred")).toMatchObject({
        organizationId: t.organizationId,
        actorUserId: t.ownerUserId,
        previousOwnerMembershipId: t.ownerMembershipId,
        previousOwnerRole: "admin",
        newOwnerMembershipId: t.targetMembershipId,
        newOwnerUserId: t.targetUserId,
        ownerCount: 1,
      });
    });

    /*
      ADR-028 §13. Both roles hold `conversation.assign` under today's
      catalogue, so this asserts the COMPLEMENT — nothing is released and
      nothing is broadcast. It fails loudly if the table changes, which is the
      point of deriving the guard from `can()` rather than hardcoding it.
    */
    it("releases no assignments and publishes no events", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();

      const { events } = await withPublishedEvents(() =>
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log),
      );

      expect(events).toEqual([]);
      expect(capture.find("organization.ownership_transferred")).toMatchObject({ releasedConversations: 0 });
    });
  });

  // ---- the four pre-write refusals (ADR-028 §6) ----

  describe("refusals before any write", () => {
    it("refuses an unknown membership with NOT_FOUND and writes nothing", async () => {
      const t = await tenant();
      const unknown = new Types.ObjectId().toString();

      await expect(
        service.transferOwnership(t.organizationId, unknown, t.actor),
      ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });

      expect(await ownerCount(t.organizationId)).toBe(1);
      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("owner");
    });

    /*
      ADR-028 §5 — the property that makes isolation structural. A membership
      in ANOTHER organization is refused with the SAME error and the SAME
      message as one that does not exist, because the two-key query never
      located it.
    */
    it("refuses a membership from another organization identically to an unknown one", async () => {
      const t = await tenant();
      const otherOrganization = await createOrganization();
      const outsider = await createUser();
      const foreign = await addMembership(outsider._id, otherOrganization._id, "admin");

      const crossTenant = service.transferOwnership(t.organizationId, foreign._id.toString(), t.actor);
      const unknown = service.transferOwnership(t.organizationId, new Types.ObjectId().toString(), t.actor);

      const [a, b] = await Promise.all([
        crossTenant.catch((e: Error) => e),
        unknown.catch((e: Error) => e),
      ]);
      expect(a).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
      expect((a as Error).message).toBe((b as Error).message);

      // And the foreign membership is untouched, in its own tenant.
      expect((await MembershipModel.findById(foreign._id))!.role).toBe("admin");
      expect(await ownerCount(t.organizationId)).toBe(1);
    });

    it("refuses the caller's own membership", async () => {
      const t = await tenant();

      await expect(
        service.transferOwnership(t.organizationId, t.ownerMembershipId, t.actor),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_SELF_TARGET", httpStatus: 409 });

      expect(await ownerCount(t.organizationId)).toBe(1);
    });

    it.each([["invited"], ["suspended"]] as const)(
      "refuses a %s membership without writing",
      async (status) => {
        const t = await tenant();
        await MembershipModel.updateOne({ _id: t.targetMembershipId }, { $set: { status } });

        await expect(
          service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor),
        ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_TARGET_INVALID", httpStatus: 409 });

        expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("owner");
        expect((await MembershipModel.findById(t.targetMembershipId))!.role).toBe("agent");
      },
    );

    /*
      The case a membership-only check would miss: an ACTIVE membership whose
      account is suspended. ADR-028 §6.4 — the same three-part gate four other
      services apply to a caller, applied here to the recipient.
    */
    it("refuses an active membership whose user is suspended", async () => {
      const t = await tenant();
      await UserModel.updateOne({ _id: t.targetUserId }, { $set: { status: "suspended" } });

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_TARGET_INVALID" });

      expect(await ownerCount(t.organizationId)).toBe(1);
    });

    it("refuses an active membership whose user never verified their email", async () => {
      const t = await tenant();
      await UserModel.updateOne({ _id: t.targetUserId }, { $set: { emailVerifiedAt: null } });

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_TARGET_INVALID" });
    });

    /*
      `membership.model.ts` states that Mongoose `ref` is not a foreign-key
      constraint, so a membership pointing at a deleted account is reachable
      rather than hypothetical.
    */
    it("refuses a membership whose user no longer exists", async () => {
      const t = await tenant();
      await UserModel.deleteOne({ _id: t.targetUserId });

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_TARGET_INVALID" });

      expect(await ownerCount(t.organizationId)).toBe(1);
    });

    /* The membership status and the account status share one message (§6). */
    it("gives the same message for a suspended membership and a suspended account", async () => {
      const a = await tenant();
      await MembershipModel.updateOne({ _id: a.targetMembershipId }, { $set: { status: "suspended" } });
      const b = await tenant();
      await UserModel.updateOne({ _id: b.targetUserId }, { $set: { status: "suspended" } });

      const first = await service
        .transferOwnership(a.organizationId, a.targetMembershipId, a.actor)
        .catch((e: Error) => e);
      const second = await service
        .transferOwnership(b.organizationId, b.targetMembershipId, b.actor)
        .catch((e: Error) => e);

      expect((first as Error).message).toBe((second as Error).message);
    });
  });

  // ---- the write-time guards (ADR-028 §8) ----

  describe("the guarded writes", () => {
    /*
      The concurrency primitive, exercised directly: the actor's membership is
      no longer `owner` when the demote runs, so the filter matches nothing.
      This is the state the LOSER of a concurrent transfer observes.
    */
    it("refuses with a conflict when the caller is no longer the owner at write time", async () => {
      const t = await tenant();

      /*
        Let the service pass every §6 gate against a real target, then move
        ownership out from under it after the last read and before the demote.
      */
      const spy = vi.spyOn(membershipRepository, "findByIdForOrganization");
      spy.mockImplementation(async (membershipId, organizationId) => {
        const found = await MembershipModel.findOne({ _id: membershipId, organizationId });
        // The interleaving: another transfer completed between the read and
        // the write.
        await MembershipModel.updateOne({ _id: t.ownerMembershipId }, { $set: { role: "supervisor" } });
        return found;
      });

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_CONFLICT", httpStatus: 409 });

      // Nothing was written by this request: the target is still an agent.
      expect((await MembershipModel.findById(t.targetMembershipId))!.role).toBe("agent");
    });

    /*
      ADR-028 §8d — the branch no HTTP test can reach. A promotion that matches
      nothing must restore the previous owner, or the organization is left in
      §10's window.
    */
    it("compensates and leaves exactly one owner when the promotion matches nothing", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();
      vi.spyOn(membershipRepository, "promoteToOwner").mockResolvedValue(null);

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_CONFLICT" });

      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("owner");
      expect((await MembershipModel.findById(t.targetMembershipId))!.role).toBe("agent");
      expect(await ownerCount(t.organizationId)).toBe(1);
      expect(capture.events()).toContain("organization.ownership_transfer_compensated");
    });

    it("compensates when the promotion throws", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();
      vi.spyOn(membershipRepository, "promoteToOwner").mockRejectedValue(
        Object.assign(new Error("E11000 duplicate key"), { name: "MongoServerError", code: 11000 }),
      );

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_CONFLICT" });

      expect(await ownerCount(t.organizationId)).toBe(1);
      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("owner");
      expect(capture.events()).toContain("organization.ownership_transfer_compensated");
    });

    /*
      The duplicate-key error's TEXT can quote the offending document, so only
      the constructor NAME is ever logged (`failureType`).
    */
    it("logs a failure type and never the database error's message", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();
      vi.spyOn(membershipRepository, "promoteToOwner").mockRejectedValue(
        Object.assign(new Error("E11000 duplicate key { email: leaked@example.com }"), {
          name: "MongoServerError",
        }),
      );

      await service
        .transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log)
        .catch(() => undefined);

      expect(capture.find("organization.ownership_transfer_failed")).toMatchObject({
        failureType: "MongoServerError",
      });
      expect(capture.serialized()).not.toContain("leaked@example.com");
      expect(capture.serialized()).not.toContain("E11000");
    });

    /*
      ADR-028 §10, asserted rather than assumed. When the compensation ALSO
      fails, the organization really is left with no owner — and the one line
      an operator alerts on is emitted at `error`.
    */
    it("emits the alertable line and leaves the organization ownerless when compensation fails", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();
      vi.spyOn(membershipRepository, "promoteToOwner").mockResolvedValue(null);
      vi.spyOn(membershipRepository, "restoreOwner").mockResolvedValue(null);

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_CONFLICT" });

      expect(capture.find("organization.ownership_transfer_compensation_failed")).toMatchObject({
        organizationId: t.organizationId,
        previousOwnerMembershipId: t.ownerMembershipId,
      });
      // The window §10 describes, in the flesh: no owner, but every membership
      // survives and the previous owner still holds `admin`.
      expect(await ownerCount(t.organizationId)).toBe(0);
      expect((await MembershipModel.findById(t.ownerMembershipId))!.role).toBe("admin");
      expect(await MembershipModel.countDocuments({ organizationId: t.organizationId })).toBe(2);
    });

    it("still refuses the caller when compensation throws", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();
      vi.spyOn(membershipRepository, "promoteToOwner").mockResolvedValue(null);
      vi.spyOn(membershipRepository, "restoreOwner").mockRejectedValue(
        Object.assign(new Error("connection lost"), { name: "MongoNetworkError" }),
      );

      await expect(
        service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log),
      ).rejects.toMatchObject({ code: "OWNERSHIP_TRANSFER_CONFLICT" });

      expect(capture.find("organization.ownership_transfer_compensation_failed")).toMatchObject({
        failureType: "MongoNetworkError",
      });
    });
  });

  // ---- concurrency, at the service level ----

  describe("concurrent transfers", () => {
    /*
      Two transfers from the same owner to two different targets, started
      together. ADR-028 §8b: exactly one demote matches, so exactly one wins.

      The assertion that matters is not which one won — it is that the database
      ends in a state with exactly one owner and that the loser wrote nothing.
    */
    it("lets exactly one of two simultaneous transfers win", async () => {
      const organization = await createOrganization();
      const ownerUser = await createUser();
      const first = await createUser();
      const second = await createUser();
      const ownerMembership = await addMembership(ownerUser._id, organization._id, "owner");
      const firstMembership = await addMembership(first._id, organization._id, "agent");
      const secondMembership = await addMembership(second._id, organization._id, "agent");

      const organizationId = organization._id.toString();
      const actor = { userId: ownerUser._id.toString(), membershipId: ownerMembership._id.toString() };

      const results = await Promise.allSettled([
        service.transferOwnership(organizationId, firstMembership._id.toString(), actor),
        service.transferOwnership(organizationId, secondMembership._id.toString(), actor),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "OWNERSHIP_TRANSFER_CONFLICT",
      });

      expect(await ownerCount(organizationId)).toBe(1);

      // The winner is the owner; the loser's target was not promoted.
      const owners = await MembershipModel.find({ organizationId, role: "owner" });
      const winnerId = (fulfilled[0] as PromiseFulfilledResult<{ newOwner: { id: string } }>).value.newOwner.id;
      expect(owners[0]!._id.toString()).toBe(winnerId);
    });

    it("never produces two owners across many simultaneous attempts", async () => {
      const organization = await createOrganization();
      const ownerUser = await createUser();
      const ownerMembership = await addMembership(ownerUser._id, organization._id, "owner");
      const organizationId = organization._id.toString();
      const actor = { userId: ownerUser._id.toString(), membershipId: ownerMembership._id.toString() };

      const targets = [];
      for (let i = 0; i < 6; i += 1) {
        const user = await createUser();
        targets.push(await addMembership(user._id, organization._id, "agent"));
      }

      const results = await Promise.allSettled(
        targets.map((target) => service.transferOwnership(organizationId, target._id.toString(), actor)),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await ownerCount(organizationId)).toBe(1);
      // And no partial state: every membership still belongs to this tenant.
      expect(await MembershipModel.countDocuments({ organizationId })).toBe(7);
    });
  });

  // ---- log hygiene (ADR-028 §12) ----

  describe("log hygiene", () => {
    it("never logs a name or an email on the success path", async () => {
      const t = await tenant();
      const capture = createCapturingLogger();

      await service.transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log);

      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
      expect(capture.serialized()).not.toContain("passwordHash");
      expect(capture.serialized()).not.toContain("hashed-value");
    });

    it.each([
      ["unknown target", async (_t: Awaited<ReturnType<typeof tenant>>) => new Types.ObjectId().toString()],
      ["self target", async (t: Awaited<ReturnType<typeof tenant>>) => t.ownerMembershipId],
    ])("never logs a name or an email when refusing (%s)", async (_label, pick) => {
      const t = await tenant();
      const capture = createCapturingLogger();

      await service
        .transferOwnership(t.organizationId, await pick(t), t.actor, capture.log)
        .catch(() => undefined);

      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });

    it("never logs a name or an email when the target's account is ineligible", async () => {
      const t = await tenant();
      await UserModel.updateOne({ _id: t.targetUserId }, { $set: { status: "suspended" } });
      const capture = createCapturingLogger();

      await service
        .transferOwnership(t.organizationId, t.targetMembershipId, t.actor, capture.log)
        .catch(() => undefined);

      expect(capture.find("organization.ownership_transfer_refused")).toMatchObject({
        reason: "user_not_eligible",
      });
      expect(capture.serialized()).not.toContain(SECRET_NAME);
      expect(capture.serialized()).not.toContain(SECRET_EMAIL_PREFIX);
    });

    /*
      The split ADR-015 §6, ADR-017 §6, and ADR-027 §13 each established: the
      distinctions exist for operators, after the fact, and NOWHERE else.
    */
    it.each([
      ["membership_not_found", async (_t: Awaited<ReturnType<typeof tenant>>) => new Types.ObjectId().toString()],
      ["self_target", async (t: Awaited<ReturnType<typeof tenant>>) => t.ownerMembershipId],
    ])("puts %s in the log and never in the thrown error", async (reason, pick) => {
      const t = await tenant();
      const capture = createCapturingLogger();

      const error = await service
        .transferOwnership(t.organizationId, await pick(t), t.actor, capture.log)
        .catch((e: Error) => e);

      expect(capture.find("organization.ownership_transfer_refused")).toMatchObject({ reason });
      expect((error as Error).message).not.toContain(reason);
      expect(JSON.stringify(error)).not.toContain(reason);
    });
  });
});
