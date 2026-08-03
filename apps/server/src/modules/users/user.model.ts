import { Schema, model } from "mongoose";
import type { HydratedDocument, Model } from "mongoose";

/**
 * A User is a person's global Serviqo identity. It deliberately carries
 * no organizationId/role/permissions — those belong to Membership
 * (User -> Membership -> Organization). A user may belong to zero, one,
 * or many organizations; nothing about that relationship lives here.
 */
export type UserStatus = "active" | "disabled";

export interface UserAttrs {
  email: string;
  passwordHash: string;
  name: string;
  emailVerifiedAt: Date | null;
  status: UserStatus;
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
