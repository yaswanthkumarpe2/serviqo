import { Schema, model } from "mongoose";
import type { HydratedDocument, Model } from "mongoose";

/**
 * A User is a person's global Serviqo identity. It deliberately carries
 * no organizationId/role/permissions — those belong to Membership
 * (User -> Membership -> Organization). A user may belong to zero, one,
 * or many organizations; nothing about that relationship lives here.
 */
export type UserStatus = "active" | "disabled";

/**
 * Standing on the Serviqo PLATFORM, which is a different axis from standing
 * inside any tenant (ADR-032 §1).
 *
 * `MembershipRole` answers "what may this person do inside that
 * organization". This answers "does this person operate Serviqo itself" —
 * the people who run the service, not the people who buy it. The two never
 * substitute for one another: an organization owner is the most powerful
 * principal inside their own tenant and has no platform standing whatsoever,
 * which is why this lives on `User` rather than becoming a fifth
 * `MembershipRole`. A role on Membership is scoped to one organization by
 * construction, and "operates the platform" is scoped to none.
 *
 * `"none"` is the default and the overwhelming majority. It is a stored value
 * rather than an absent field so that "this account has no platform standing"
 * is something the database states rather than something code infers from
 * `undefined` — the distinction that matters when the alternative reading of
 * a missing field is "unknown".
 *
 * Nothing in the product can WRITE this. Registration cannot set it, no
 * endpoint updates it, and the sign-up path has no code that reaches it. The
 * only way an account acquires it is `scripts/grantPlatformAdmin.ts`, run by
 * someone holding the database credentials — which is deliberate, because
 * self-service escalation to platform admin is precisely the hole an
 * unauthenticated registration endpoint must not have.
 */
export type PlatformRole = "none" | "admin";

/**
 * Which kind of STAFF member this account is (ADR-034 §1, narrowed by ADR-037).
 *
 * - `"agent"` — somebody who answers an organisation's conversations, or
 *   administers one. Created only by invitation. Which organisation, and what
 *   they may do in it, is their `Membership`'s business, not this field's: an
 *   organisation admin is an agent-kind account holding an `owner` or `admin`
 *   membership.
 * - `"admin"` — somebody who OPERATES the deployment: the super admin. Created
 *   only by `reset:platform`, and reaches the operations console rather than
 *   the agent workspace (ADR-035 §4).
 *
 * There is no customer kind. Customers never hold accounts (ADR-037): they are
 * anonymous visitors of one organisation's widget, represented by `Customer`,
 * which is not a `User` and never was one before ADR-034 briefly made it so.
 *
 * This is deliberately NOT `platformRole` and NOT `MembershipRole`. Platform
 * standing says whether you may operate Serviqo; a membership role says what
 * you may do inside one tenant; this says which staff surface you belong on.
 */
export type UserKind = "agent" | "admin";

/**
 * What the `kind` field may hold IN THE DATABASE, which is one value wider than
 * what the application writes.
 *
 * ADR-034 created `"customer"` accounts and ADR-037 removed them. Documents
 * written in between still say `"customer"`, and a type that pretended they
 * could not would let the gate that refuses them be deleted as dead code.
 * `isStaffKind` is that gate; every place that admits a user to a session
 * calls it.
 */
export type StoredUserKind = UserKind | "customer";

/** Whether an account is staff at all. Legacy customer accounts are not (ADR-037). */
export function isStaffKind(kind: StoredUserKind): kind is UserKind {
  return kind === "agent" || kind === "admin";
}

export interface UserAttrs {
  email: string;
  passwordHash: string;
  name: string;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  platformRole: PlatformRole;
  kind: StoredUserKind;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<UserAttrs>;

/**
 * Canonicalizes an email the same way on write and on read. Mongoose's
 * schema-level `lowercase`/`trim` only transform values assigned to a
 * document — they do NOT transform query filter objects — so callers
 * building a filter (see user.repository.ts) must normalize explicitly.
 * This is the one place that rule lives.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const userSchema = new Schema<UserAttrs>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
      // Never returned by ordinary queries (findById/findByEmail below).
      // A future authentication-specific query can opt in explicitly
      // with .select('+passwordHash') when the login slice needs it.
      select: false,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "disabled"] satisfies UserStatus[],
      default: "active",
    },
    /*
      Defaults to "none", which is what makes this field safe to add to a
      collection that already holds documents: every existing account reads
      back as having no platform standing, and no migration is required to
      make that true. `default` applies on read for documents that predate
      the field, not only on write.
    */
    platformRole: {
      type: String,
      enum: ["none", "admin"] satisfies PlatformRole[],
      default: "none",
    },
    /*
      Defaults to "agent": the only way an account is created now is an
      invitation, and an invitation is always for staff (ADR-037). The enum
      still admits "customer" so the documents ADR-034 wrote stay loadable —
      they are refused at sign-in by `isStaffKind`, not by failing to parse.
    */
    kind: {
      type: String,
      enum: ["agent", "admin", "customer"] satisfies StoredUserKind[],
      default: "agent",
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Defense in depth: even if a query explicitly re-selects passwordHash,
 * it never survives serialization (JSON.stringify / res.json / toJSON).
 * __v (Mongoose's internal version key) has no API meaning either.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripSensitiveFields(_doc: any, ret: any) {
  delete ret.passwordHash;
  delete ret.__v;
  return ret;
}
userSchema.set("toJSON", { transform: stripSensitiveFields });
userSchema.set("toObject", { transform: stripSensitiveFields });

export const UserModel: Model<UserAttrs> = model<UserAttrs>("User", userSchema);
