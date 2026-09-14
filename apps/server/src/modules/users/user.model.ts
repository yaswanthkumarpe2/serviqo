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
 * WHICH PRODUCT this account signed up for (ADR-034 §1).
 *
 * A third axis, and the one that decides which front door an account came
 * through and which surface it may see:
 *
 * - `"customer"` — a person who buys from the tenant and talks to its support
 *   team. Created by public registration at `/signup`, which is the only way
 *   this value is ever written.
 * - `"agent"` — a person who ANSWERS those conversations. Created only by an
 *   admin from the operations console; public registration cannot produce one.
 *
 * This is deliberately NOT `platformRole` and NOT `MembershipRole`. Platform
 * standing says whether you operate Serviqo; a membership role says what you
 * may do inside one tenant; this says which kind of person you are at all, and
 * the three are independent — an agent holds a membership and no platform
 * standing, a customer holds neither.
 *
 * It also reverses ADR-010 §5's assumption in one specific way, which is worth
 * naming because that ADR is otherwise unchanged: customers could not
 * authenticate at all, and now a customer MAY hold an account. What has not
 * changed is that a customer still holds no `Membership`, still reaches no
 * tenant surface, and still cannot read anything but their own conversation —
 * the widget remains the anonymous path, and this is an additional, signed-in
 * one (ADR-034 §2).
 *
 * Defaults to `"customer"`, which makes the field safe to add to a collection
 * that already holds documents and safe by construction: the value that
 * appears when nobody stated one is the one with the least reach.
 */
export type UserKind = "customer" | "agent";

export interface UserAttrs {
  email: string;
  passwordHash: string;
  name: string;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  platformRole: PlatformRole;
  kind: UserKind;
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
      Defaults to the least-privileged value for the same reason `platformRole`
      does: every document written before this field existed reads back as a
      customer, which is the reading that grants nothing, and no migration is
      needed to make that true.
    */
    kind: {
      type: String,
      enum: ["customer", "agent"] satisfies UserKind[],
      default: "customer",
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
