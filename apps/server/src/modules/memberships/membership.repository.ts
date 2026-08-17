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
 * relationship against BOTH identities in a single indexed query. There
 * is deliberately no findByUser(userId) here that a caller could follow
 * with in-memory filtering — that shape invites "fetch everything, then
 * filter", which is exactly how cross-tenant leaks happen. The future
 * requireOrganization middleware depends on this method.
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

  async findByUserAndOrganization(
    userId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<MembershipDocument | null> {
    return MembershipModel.findOne({ userId, organizationId });
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
