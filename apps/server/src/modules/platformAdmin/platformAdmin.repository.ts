import { ConversationModel } from "../conversations/conversation.model";
import { CustomerModel } from "../customers/customer.model";
import { MembershipModel } from "../memberships/membership.model";
import { MessageModel } from "../messages/message.model";
import { OrganizationModel } from "../organizations/organization.model";
import { UserModel } from "../users/user.model";

import type { OrganizationDocument } from "../organizations/organization.model";
import type { UserDocument } from "../users/user.model";
import type { Types } from "mongoose";

/**
 * The ONE place in Serviqo that reads across tenants (ADR-032 §7).
 *
 * Every other repository takes `organizationId` as a mandatory key, and
 * CONTRIBUTING.md states the rule these methods deliberately stand outside
 * of: no unscoped read. That rule exists because one tenant's data must never
 * reach another tenant's request, and none of these methods could be called
 * on a tenant's behalf without breaking it.
 *
 * What makes the exception safe is not this file — it is that every caller
 * sits behind `requirePlatformAdmin`, which re-reads the grant from the
 * database on each request. The narrowness here is the second line of
 * defence: these methods return COUNTS and administrative summaries, never
 * message bodies, never customer identities, and never anything a support
 * conversation actually said. An operator needs to know that a tenant holds
 * 412 conversations; they have no business reading them, and the way to keep
 * that true is for the capability not to exist.
 *
 * Its own repository rather than methods added to the tenant-scoped ones, so
 * that "does this codebase contain an unscoped read?" is answered by reading
 * one file. A `countAll` quietly added to `conversation.repository.ts` would
 * be the same capability with none of the visibility.
 */

/** Platform-wide totals. Counts only — see the note above. */
export interface PlatformTotals {
  organizations: number;
  users: number;
  customers: number;
  conversations: number;
  messages: number;
}

/** How the user base breaks down, for the account-health panel. */
export interface PlatformUserBreakdown {
  verified: number;
  unverified: number;
  disabled: number;
  platformAdmins: number;
}

/** How conversation volume breaks down, platform-wide. */
export interface PlatformConversationBreakdown {
  open: number;
  closed: number;
  unassigned: number;
}

export const platformAdminRepository = {
  /**
   * Every total in one round of queries.
   *
   * `estimatedDocumentCount` is deliberately NOT used, despite being the
   * cheaper call: it reads collection metadata, which can lag reality, and an
   * operations console whose numbers are approximately right is one nobody can
   * use to answer "did that tenant's conversations actually save". At
   * Serviqo's scale an exact count is a millisecond; when it stops being one,
   * the fix is a maintained counter, not a number that is quietly wrong.
   */
  async countTotals(): Promise<PlatformTotals> {
    const [organizations, users, customers, conversations, messages] = await Promise.all([
      OrganizationModel.countDocuments({}),
      UserModel.countDocuments({}),
      CustomerModel.countDocuments({}),
      ConversationModel.countDocuments({}),
      MessageModel.countDocuments({}),
    ]);

    return { organizations, users, customers, conversations, messages };
  },

  async countUserBreakdown(): Promise<PlatformUserBreakdown> {
    const [verified, unverified, disabled, platformAdmins] = await Promise.all([
      UserModel.countDocuments({ emailVerifiedAt: { $ne: null } }),
      UserModel.countDocuments({ emailVerifiedAt: null }),
      UserModel.countDocuments({ status: "disabled" }),
      UserModel.countDocuments({ platformRole: "admin" }),
    ]);

    return { verified, unverified, disabled, platformAdmins };
  },

  async countConversationBreakdown(): Promise<PlatformConversationBreakdown> {
    const [open, closed, unassigned] = await Promise.all([
      ConversationModel.countDocuments({ status: "open" }),
      ConversationModel.countDocuments({ status: "closed" }),
      ConversationModel.countDocuments({ status: "open", assignedTo: null }),
    ]);

    return { open, closed, unassigned };
  },

  /**
   * The most recently created organizations, newest first.
   *
   * Sorted by `_id` descending rather than `createdAt`. ObjectIds embed their
   * creation timestamp and are already indexed as the primary key, so this
   * sort is free where `createdAt` would need an index of its own to avoid a
   * collection scan — and the two orders agree to the second.
   */
  async listRecentOrganizations(limit: number): Promise<OrganizationDocument[]> {
    return OrganizationModel.find({}).sort({ _id: -1 }).limit(limit);
  },

  /** The most recently created users, newest first. Same sort reasoning. */
  async listRecentUsers(limit: number): Promise<UserDocument[]> {
    return UserModel.find({}).sort({ _id: -1 }).limit(limit);
  },

  /**
   * Active member counts for several organizations, in one query.
   *
   * Grouped server-side rather than one `countDocuments` per row: a page of
   * organizations is exactly the N+1 shape that makes a list endpoint slow,
   * and `membershipRepository` has no bulk counterpart to borrow.
   */
  async countActiveMembersByOrganization(organizationIds: Types.ObjectId[]): Promise<Map<string, number>> {
    if (organizationIds.length === 0) return new Map();

    const rows = await MembershipModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { organizationId: { $in: organizationIds }, status: "active" } },
      { $group: { _id: "$organizationId", count: { $sum: 1 } } },
    ]);

    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  },

  /** Conversation counts for several organizations, in one query. Same shape. */
  async countConversationsByOrganization(organizationIds: Types.ObjectId[]): Promise<Map<string, number>> {
    if (organizationIds.length === 0) return new Map();

    const rows = await ConversationModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { organizationId: { $in: organizationIds } } },
      { $group: { _id: "$organizationId", count: { $sum: 1 } } },
    ]);

    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  },

  /**
   * The owning user of each of several organizations, in one query.
   *
   * Ownership lives on `Membership` (`role: "owner"`) and never on
   * `Organization` — the invariant ADR-010 §3 fixed and ADR-028 relies on — so
   * this is the only way to answer "whose tenant is this".
   */
  async findOwnerUserIdsByOrganization(organizationIds: Types.ObjectId[]): Promise<Map<string, Types.ObjectId>> {
    if (organizationIds.length === 0) return new Map();

    const owners = await MembershipModel.find({
      organizationId: { $in: organizationIds },
      role: "owner",
      status: "active",
    });

    return new Map(owners.map((membership) => [membership.organizationId.toString(), membership.userId]));
  },

  /** Active membership counts for several users, in one query. Same shape. */
  async countActiveMembershipsByUser(userIds: Types.ObjectId[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();

    const rows = await MembershipModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { userId: { $in: userIds }, status: "active" } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]);

    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  },
};
