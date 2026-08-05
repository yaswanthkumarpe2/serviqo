import { Schema, model } from "mongoose";
import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * A short-lived, single-use credential emailed to a user so they can
 * perform one account action (ADR-005).
 *
 * Distinct from Session's refresh-token state by design. A refresh token is
 * rotated repeatedly and routed by a non-secret session id; an account
 * action token is issued once, used at most once, and the recipient
 * presents nothing but the secret itself.
 *
 * Only the SHA-256 hash of the secret is stored — never the raw value,
 * which exists solely in memory, in the outgoing email URL, and in the
 * incoming request. Hashing and generation belong to `lib/crypto/tokens.ts`
 * and the future account service; this layer receives a hash and stores it.
 *
 * `purpose` is a validation input, not metadata: a password-reset token
 * must never be usable as an email-verification token, so it is part of the
 * consumption predicate rather than something a caller checks afterwards.
 */
export type AccountTokenPurpose = "email_verification" | "password_reset";

export interface AccountTokenAttrs {
  userId: Types.ObjectId;
  purpose: AccountTokenPurpose;
  tokenHash: string;
  expiresAt: Date;
  /** Set exactly once, when the recipient successfully uses the link. */
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AccountTokenDocument = HydratedDocument<AccountTokenAttrs>;

const accountTokenSchema = new Schema<AccountTokenAttrs>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // Deliberately not `index: true` — the { userId, purpose } compound
      // index below already provides the userId prefix, so a standalone
      // index would be redundant.
    },
    purpose: {
      type: String,
      enum: ["email_verification", "password_reset"] satisfies AccountTokenPurpose[],
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      // Never returned by ordinary queries. Nothing in the production API
      // needs to read it back: consumption matches *by* the hash inside the
      // database, so unlike Session there is no security-sensitive read path
      // at all.
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * A. Consumption lookup key. Unique because the email link carries only the
 *    secret — there is no separate routing component — so the hash must
 *    resolve to exactly one document, and a duplicate insert must fail loudly.
 */
accountTokenSchema.index({ tokenHash: 1 }, { unique: true });

/**
 * B. Backs invalidateOutstandingForUser and user-scoped queries. Its userId
 *    prefix is why no standalone { userId: 1 } index exists.
 */
accountTokenSchema.index({ userId: 1, purpose: 1 });

/**
 * C. Storage cleanup only — NOT a security control. MongoDB's TTL monitor
 *    runs periodically, so an expired document routinely still exists; every
 *    consumption therefore enforces `expiresAt > now` in its predicate
 *    (ADR-005 §5).
 */
accountTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Defense in depth: the hash never survives serialization, even if some
 * future query explicitly selects it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripSensitiveFields(_doc: any, ret: any) {
  delete ret.tokenHash;
  delete ret.__v;
  return ret;
}
accountTokenSchema.set("toJSON", { transform: stripSensitiveFields });
accountTokenSchema.set("toObject", { transform: stripSensitiveFields });

export const AccountTokenModel: Model<AccountTokenAttrs> = model<AccountTokenAttrs>(
  "AccountToken",
  accountTokenSchema,
);
