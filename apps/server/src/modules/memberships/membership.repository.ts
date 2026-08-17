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
