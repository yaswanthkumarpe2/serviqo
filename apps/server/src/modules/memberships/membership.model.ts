import { Schema, model } from "mongoose";
import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * Membership is the authoritative relationship between a User and an
 * Organization — the join model in User -> Membership -> Organization.
 * It is the single source of truth for tenant access, role, and
 * organization ownership. Neither User (no organizationId/role) nor
 * Organization (no ownerUserId/members[]) duplicates any of it.
 *
 * Role is stored; permissions are NOT. Future authorization maps
 * role -> ROLE_PERMISSIONS -> permission at request time, so a
 * permission-model change never requires rewriting stored documents.
 *
 * Referential integrity: Mongoose `ref` does not create a foreign-key
 * constraint, and this schema deliberately does not add async validators
 * that query User/Organization on every save to imitate one — that would
 * put two extra round-trips on every write to approximate a guarantee
 * MongoDB still wouldn't enforce. Verifying that the referenced User and
 * Organization exist is the future business/service layer's job, before
 * it asks persistence to create the relationship.
 */
export type MembershipRole = "owner" | "admin" | "supervisor" | "agent";
export type MembershipStatus = "active" | "invited" | "suspended";

export interface MembershipAttrs {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  role: MembershipRole;
  status: MembershipStatus;
  invitedByUserId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MembershipDocument = HydratedDocument<MembershipAttrs>;

const membershipSchema = new Schema<MembershipAttrs>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "supervisor", "agent"] satisfies MembershipRole[],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "invited", "suspended"] satisfies MembershipStatus[],
      default: "active",
    },
    // Optional: present only when this membership originated from an
    // invitation. Owner memberships and directly-created ones leave it
    // null. No invitation workflow exists yet — this is the field that
    // lets one be added later without a schema migration.
    invitedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * A. One membership per user per organization. A role change updates this
 *    document; it never creates a second one. Also serves userId-prefixed
 *    lookups ("which organizations does this user belong to").
 */
membershipSchema.index({ userId: 1, organizationId: 1 }, { unique: true });

/**
 * B. At most one owner per organization, enforced by the database rather
 *    than by application code. Partial, so it constrains ONLY owner
 *    documents — any number of admins/supervisors/agents remain valid,
 *    and one user may own several different organizations.
 *
 *    Note this index cannot serve general "list this org's members"
 *    queries: a partial index is only usable when the query predicate
 *    guarantees a subset of the indexed documents, and
 *    { organizationId } alone does not imply role === "owner".
 *    Hence index C.
 */
membershipSchema.index(
  { organizationId: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: "owner" } },
);

/**
 * C. Supports findByOrganization(organizationId). Not redundant with A
 *    (whose prefix is userId, so it cannot serve an organizationId-only
 *    query) nor with B (partial — owner documents only).
 */
membershipSchema.index({ organizationId: 1 });

// Same serialization boundary as User/Organization: internal Mongoose
// bookkeeping never survives serialization.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
membershipSchema.set("toJSON", { transform: stripInternalFields });
membershipSchema.set("toObject", { transform: stripInternalFields });

export const MembershipModel: Model<MembershipAttrs> = model<MembershipAttrs>("Membership", membershipSchema);
