import { MembershipModel } from "./membership.model";
import type { MembershipDocument, MembershipRole, MembershipStatus } from "./membership.model";
import type { Types } from "mongoose";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

export interface CreateMembershipInput {
  userId: ObjectIdLike;
  organizationId: ObjectIdLike;
  role: MembershipRole;
  status?: MembershipStatus;
  invitedByUserId?: ObjectIdLike | null;
}

/**
 * Minimal persistence surface for the User <-> Organization relationship.
 *
 * Tenant-safety note: authorization-related lookups go through
 * findByUserAndOrganization(userId, organizationId), which proves the
 * relationship against BOTH identities in a single indexed query.
 * `requireOrganization` depends on this method (ADR-017 §3).
 *
 * This file originally recorded that findByUser(userId) would deliberately
 * not exist, because a caller could follow it with in-memory filtering —
 * "fetch everything, then filter" being exactly how cross-tenant leaks
 * happen. It exists now, for `/me`'s membership list, and the prohibition it
 * was written for is unchanged: findByUser answers "which organizations does
 * this caller belong to" and MUST NOT be used to authorize a request that
 * already names one. ADR-017 §4 records why listing is safe where filtering
 * is not — see the method's own comment below.
 *
 * findByOrganization requires organizationId explicitly; there is no
 * unscoped findAllMemberships().
 *
 * Nothing is auto-populated — services request related User/Organization
 * data deliberately when they need it, so no query here can silently
 * become N+1.
 *
 * MongoDB's indexes are the authority for both invariants (one membership
 * per user per org, at most one owner per org); create() lets a duplicate
 * key error (code 11000) propagate untouched for a future service to
 * translate into an API Conflict response.
 */
export const membershipRepository = {
  async create(input: CreateMembershipInput): Promise<MembershipDocument> {
    // Passed straight through so Mongoose's required/enum validators
    // produce a clean ValidationError rather than a raw TypeError.
    return MembershipModel.create(input);
  },

  async findById(id: string): Promise<MembershipDocument | null> {
    return MembershipModel.findById(id);
  },

  /**
   * THE authorization lookup (ADR-017 §3).
   *
   * Proves the relationship against both identities in a single indexed
   * query, so the caller receives a document or `null` and has no comparison
   * left to write by hand. `requireOrganization` uses this and may not use
   * `findByUser` below — "fetch this user's memberships, then check in
   * JavaScript whether one matches" is a comparison whose failure modes are
   * all quiet: an ObjectId compared to a string, a `.find()` whose result is
   * never checked, or a `status` gate forgotten on the row that matched.
   */
  async findByUserAndOrganization(
    userId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOne({ userId, organizationId });
  },

  /**
   * The caller's own memberships, for listing them back to that caller
   * (ADR-017 §4).
   *
   * NEVER FOR AUTHORIZATION. Proving access to one organization goes through
   * `findByUserAndOrganization` above; this method exists so `/me` can answer
   * "which organizations do I belong to", and a request that already names an
   * organization must not be answered by fetching all of them and searching.
   *
   * This is the method the header of this file said would not exist, and the
   * prohibition it was written for still holds. What that warned against was
   * fetching broadly and filtering in memory. Here `userId` IS the complete
   * scope: it is the prefix of the `{ userId: 1, organizationId: 1 }` unique
   * index, the result set is by construction exactly the caller's own rows,
   * nothing is filtered afterwards, and the caller is the subject of every
   * document returned.
   *
   * Sorted by `organizationId` so the order is stable across calls — Mongo
   * makes no promise otherwise, and a switcher that reshuffles between loads
   * is a switcher people mis-click.
   */
  async findByUser(userId: ObjectIdLike): Promise<MembershipDocument[]> {
    return MembershipModel.find({ userId }).sort({ organizationId: 1 });
  },

  async findByOrganization(organizationId: ObjectIdLike): Promise<MembershipDocument[]> {
    return MembershipModel.find({ organizationId });
  },

  /**
   * THE tenant-scoped lookup by membership id (ADR-027 §1, §9).
   *
   * Two keys in one query, and that is the whole isolation mechanism for the
   * team-management surface. A membership belonging to another organization
   * returns `null` here IDENTICALLY to one that does not exist, so the 404 the
   * service raises is produced by the query missing rather than by a branch
   * comparing tenants — the same property `conversationRepository.
   * findByIdForOrganization` gives conversations (ADR-025 §10).
   *
   * Keyed by MEMBERSHIP id rather than user id on purpose. A `User` id is
   * global and carries no tenancy; a `Membership` id is tenant-scoped by
   * construction, which is what makes this pair sufficient.
   */
  async findByIdForOrganization(
    membershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOne({ _id: membershipId, organizationId });
  },

  /**
   * The organization's roster, in a stable order (ADR-027 §14).
   *
   * Distinct from `findByOrganization` above, which ADR-016 added for
   * onboarding's own use and which promises no order. This one sorts, because
   * a roster is rendered: Mongo makes no ordering promise, and a list that
   * reshuffles between loads is one people mis-click — the same reason
   * `findByUser` sorts and `currentUser.service.ts` re-sorts on top of it.
   *
   * Sorted by `createdAt` then `_id` here, with the ROLE-RANK ordering the UI
   * wants applied by the service. Persistence has no opinion about which role
   * belongs at the top of a page; it owns only determinism.
   *
   * `organizationId` is mandatory and there is no unscoped variant. Served by
   * index C.
   */
  async listForOrganization(organizationId: ObjectIdLike): Promise<MembershipDocument[]> {
    return MembershipModel.find({ organizationId }).sort({ createdAt: 1, _id: 1 });
  },

  /**
   * Changes one membership's role, scoped by both ids (ADR-027 §1).
   *
   * A single conditional update rather than a read followed by a save, so the
   * tenant scope is part of the write itself and not a check that preceded
   * it. `null` means no document matched, which — because both keys are in the
   * filter — is the same ambiguity `findByIdForOrganization` produces and is
   * resolved the same way: one refusal for every unreachable membership.
   *
   * Deliberately NOT a general `update(id, patch)`. The narrowness rule
   * `userRepository` follows, where `markEmailVerified` and
   * `clearLoginFailures` exist and a general updater does not: a method that
   * can write any field is a method that can write `status` or
   * `organizationId` by accident.
   *
   * MAY THROW a duplicate-key error if asked to write `role: "owner"` while an
   * owner exists — index B refusing a second owner. The route's schema does
   * not accept that value (ADR-027 §6), so the index is a backstop rather
   * than the error path.
   */
  async updateRoleForOrganization(
    membershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
    role: MembershipRole,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOneAndUpdate(
      { _id: membershipId, organizationId },
      { $set: { role } },
      { returnDocument: "after" },
    );
  },

  /**
   * Changes one membership's STATUS, scoped by both ids and guarded on the
   * status it expects to find (ADR-029 §6, §7).
   *
   * `status: from` IS IN THE FILTER, so the transition is a precondition of the
   * write rather than a check that preceded it. Two managers suspending the
   * same person simultaneously both find `active`; MongoDB applies each update
   * atomically to that one document, so exactly ONE matches and the other
   * matches nothing and is refused. The same property `demoteOwner` relies on
   * (ADR-028 §8b), applied to a different field.
   *
   * `role: { $ne: "owner" }` IS A BACKSTOP, never the error path. The service
   * checks the owner membership first and raises
   * `OrganizationOwnerProtectedError`, which is the answer a caller can act on
   * (ADR-029 §7); this filter exists so the WRITE cannot land on an owner
   * document even if a future branch reached it wrongly. A suspended owner is
   * a fourth route to ADR-016 §3's unrecoverable tenant, and one guard for it
   * is not enough.
   *
   * `null` means the membership is gone, belongs to another tenant, is the
   * owner, or is no longer in `from` — and the caller must not distinguish
   * them, because the service already established which of those it is before
   * calling. A `null` here is a lost race, not a diagnosis.
   *
   * Deliberately NOT a general `update(id, patch)`, and deliberately not a
   * `setStatus(id, status)` without `from`. The narrowness rule this file's
   * header states: a method that can write any field is a method that can
   * write `organizationId` by accident, and a method that can write any status
   * is one that can silently absorb a no-op.
   */
  async updateStatusForOrganization(
    membershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
    from: MembershipStatus,
    to: MembershipStatus,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOneAndUpdate(
      { _id: membershipId, organizationId, status: from, role: { $ne: "owner" } },
      { $set: { status: to } },
      { returnDocument: "after" },
    );
  },

  /**
   * STEP 1 OF OWNERSHIP TRANSFER: demotes the current owner (ADR-028 §8).
   *
   * `role: "owner"` IS IN THE FILTER, and that is the whole concurrency
   * design. Two simultaneous transfers both aim at the same single owner
   * document; MongoDB applies each update atomically to that one document, so
   * exactly ONE of them matches and the other matches nothing, writes nothing,
   * and is refused. The guard is part of the write rather than a read that
   * preceded it — a read-then-write here would be two requests both observing
   * an owner and both proceeding.
   *
   * Returns `null` for every reason the transfer must not continue: the
   * membership is gone, it belongs to another tenant, or its role is no longer
   * `owner` because a concurrent transfer already won. The caller cannot and
   * must not distinguish them — all three mean "ownership moved".
   *
   * `newRole` is `PREVIOUS_OWNER_ROLE` from the service (ADR-028 §7), passed
   * rather than hardcoded here for the reason every method in this file takes
   * its values from the caller: persistence owns the write, not the policy
   * about what the outgoing owner becomes.
   *
   * AFTER THIS RETURNS THE ORGANIZATION HAS NO OWNER, until `promoteToOwner`
   * below lands or `restoreOwner` compensates. ADR-028 §10 states what that
   * window is, why it is inert, and how an operator recovers if a process dies
   * inside it. Nothing else in the codebase may call this method.
   */
  async demoteOwner(
    ownerMembershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
    newRole: MembershipRole,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOneAndUpdate(
      { _id: ownerMembershipId, organizationId, role: "owner" },
      { $set: { role: newRole } },
      { returnDocument: "after" },
    );
  },

  /**
   * STEP 2 OF OWNERSHIP TRANSFER: promotes the target (ADR-028 §8).
   *
   * The only method in this codebase that writes `role: "owner"` to an
   * existing document. `updateRoleForOrganization` above cannot: ADR-027 §6's
   * schema refuses the value, so that path never reaches the index.
   *
   * Three keys in the filter, and each re-asserts one of the service's
   * pre-checks AS PART OF THE WRITE rather than trusting a read taken
   * microseconds earlier:
   *
   * - `organizationId` — the target cannot be outside the caller's tenant.
   * - `status: "active"` — a membership suspended since the pre-check is not
   *   promoted (ADR-028 §6.3).
   * - `role: { $ne: "owner" }` — this document is not already the owner, so a
   *   promotion can never report success for a row the demote failed to move
   *   off. It says nothing about OTHER documents; see below.
   *
   * `null` means one of those stopped being true. The caller compensates.
   *
   * MAY THROW a duplicate-key error, and the distinction matters enough to
   * state plainly: a filter constrains the document being MATCHED, not the
   * collection. If another membership in this organization still holds
   * `owner`, this filter matches the target happily and index B rejects the
   * WRITE. That is not a defect — index B is the final authority, exactly as
   * ADR-027 §8 has it for index A — and it is precisely why the service wraps
   * this call in a `try`: a throw and a `null` mean the same thing to the
   * caller ("the promotion did not land"), and both compensate.
   *
   * In the ordinary flow it cannot happen, because `demoteOwner` has already
   * vacated the owner slot and its own guard proved that it did.
   */
  async promoteToOwner(
    membershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOneAndUpdate(
      { _id: membershipId, organizationId, status: "active", role: { $ne: "owner" } },
      { $set: { role: "owner" } },
      { returnDocument: "after" },
    );
  },

  /**
   * COMPENSATION for a transfer whose promotion did not land (ADR-028 §8d).
   *
   * The same shape `deleteById` serves for onboarding (ADR-016 §4): a narrow
   * method whose sole permitted use is undoing a write the SAME request made
   * moments earlier, aimed at the document that request just touched.
   *
   * `role: expectedRole` in the filter is what keeps it from being a general
   * "make this membership the owner" primitive. It restores a document this
   * request demoted and left untouched; if anything changed that role since,
   * this matches nothing and the caller logs the failure rather than
   * overwriting a state it does not understand.
   *
   * Returns `null` when it could not compensate — the caller MUST treat that
   * as ADR-028 §10's window having been entered and not closed, and log the
   * one line an operator alerts on.
   */
  async restoreOwner(
    membershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
    expectedRole: MembershipRole,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOneAndUpdate(
      { _id: membershipId, organizationId, role: expectedRole },
      { $set: { role: "owner" } },
      { returnDocument: "after" },
    );
  },

  /**
   * How many owner memberships this organization has (ADR-028 §8e).
   *
   * Index B makes any answer above 1 impossible, so this is not a duplicate
   * check — it is the POST-CONDITION the transfer records. Logging the count
   * with the success line is what makes "exactly one owner" a fact an operator
   * can read afterwards rather than a property the code merely intends, and it
   * is what the integration suite reads to prove the invariant held across
   * concurrent attempts.
   *
   * Served by index B directly: the predicate `{ organizationId, role: "owner" }`
   * guarantees a subset of the indexed documents, which is the condition a
   * partial index needs to be usable.
   */
  async countOwners(organizationId: ObjectIdLike): Promise<number> {
    return MembershipModel.countDocuments({ organizationId, role: "owner" });
  },

  /**
   * Removes one membership from ONE organization (ADR-027 §1, §9).
   *
   * The revocation `deleteById` above explicitly refused to be: "it cannot
   * remove a person from an organization. Revoking access is a different
   * operation with different authorization, and it belongs to the
   * team-management slice." This is that operation, and the difference between
   * the two methods is the second key — this one cannot be aimed outside the
   * caller's tenant at all, while `deleteById` remains the compensation-only
   * method aimed by `_id` alone.
   *
   * Returns the removed document rather than a boolean, because the caller
   * needs the `userId` off it to release that person's conversation
   * assignments (ADR-027 §10) and reading it beforehand would be a second
   * query and a window in which it could change.
   */
  async deleteForOrganization(
    membershipId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOneAndDelete({ _id: membershipId, organizationId });
  },

  /**
   * Which of these users are ACTIVE members of this organization — one
   * batched, tenant-scoped query for a whole page (ADR-026 §11).
   *
   * The first half of resolving conversation assignees to names, and it is
   * not skippable: `Conversation.assignedTo` is a `User` id that carries no
   * tenancy of its own (ADR-026 §1), so this query is what turns "the
   * document says this user" into "the server proved this user works here".
   * Reading the `User` documents without it would let a stale assignment —
   * one whose membership was revoked — surface a name from outside the
   * tenant's current roster.
   *
   * `status: "active"` rather than any membership, matching
   * `requireOrganization`'s own gate: an `invited` membership has not been
   * accepted and a `suspended` one has been revoked, and neither describes
   * someone currently on the team.
   *
   * Batched rather than one lookup per row, mirroring
   * `customerRepository.findByIdsAndOrganization` — one query per row is the
   * N+1 a list endpoint must not have. Returns a `Map` for the same reason
   * that method does: the caller is joining, not iterating.
   */
  async findActiveByOrganizationAndUsers(
    organizationId: ObjectIdLike,
    userIds: ObjectIdLike[],
  ): Promise<Map<string, MembershipDocument>> {
    if (userIds.length === 0) return new Map();

    const memberships = await MembershipModel.find({
      organizationId,
      userId: { $in: userIds },
      status: "active",
    });

    return new Map(memberships.map((membership) => [membership.userId.toString(), membership]));
  },

  /**
   * Removes exactly one membership, by its own `_id`.
   *
   * SOLE PERMITTED USE: undoing a membership the SAME request created
   * moments earlier, when the write that was supposed to follow it failed
   * (ADR-016 §4). Onboarding writes the owner membership before the
   * organization so that a tenant can never exist unowned; this is what
   * cleans up when the organization write then fails.
   *
   * Deliberately not a general `delete(filter)` and deliberately keyed on
   * `_id` rather than `{ userId, organizationId }` — it cannot be aimed at a
   * membership the caller did not just create, and it cannot remove a person
   * from an organization. Revoking access is a different operation with
   * different authorization, and it belongs to the team-management slice.
   *
   * The same narrowness rule `userRepository` follows, where
   * `markEmailVerified` and `clearLoginFailures` exist and a general
   * `update(id, patch)` deliberately does not.
   *
   * Returns whether a document was removed, so a caller can tell a
   * successful compensation from one that found nothing to undo.
   */
  async deleteById(id: ObjectIdLike): Promise<boolean> {
    const { deletedCount } = await MembershipModel.deleteOne({ _id: id });
    return deletedCount === 1;
  },
};
