import { Schema, model } from "mongoose";
import type { HydratedDocument, Model, Types } from "mongoose";

import { MAX_USER_AGENT_LENGTH } from "../../config/constants";

/**
 * A Session represents one authenticated login on one device. Its _id is
 * stable for the session's entire life — rotation changes which refresh
 * token the session accepts, it never creates a new Session — so session
 * listing and revocation always address a durable identifier.
 *
 * See ADR-004 for the full design. The essentials enforced here:
 *
 * - Only HASHES of refresh secrets are stored, never raw tokens.
 * - `currentRefreshTokenHash` plus a bounded history of previously
 *   rotated hashes is what makes reuse detection possible: a presented
 *   token matching a *previous* hash is a replay of a rotated token
 *   (suspected theft), which an overwrite-only design could not
 *   distinguish from a fabricated token.
 * - Both hash fields are `select: false` AND stripped in
 *   toJSON/toObject, so exposure through an ordinary query or an API
 *   response is structurally prevented rather than left to reviewer
 *   vigilance. Reading them requires the deliberately-named
 *   security-sensitive repository method.
 * - No organizationId/role/permissions. A Session authenticates the
 *   global User identity; organization access is resolved per request
 *   through Membership, so switching organizations never requires
 *   re-authenticating and a role change takes effect immediately.
 *
 * Referential integrity: as with Membership, no async validator queries
 * User on every save to imitate a foreign key. The future login service
 * creates a Session only after authenticating a real User.
 */

/** Maximum retained previously-rotated hashes. Enforced atomically by sessionRepository.rotateRefreshToken. */
export const MAX_PREVIOUS_REFRESH_TOKEN_HASHES = 5;

/** Fits the longest IPv6 textual form, including IPv4-mapped (e.g. "::ffff:255.255.255.255"). */
export const MAX_IP_LENGTH = 45;

export interface SessionAttrs {
  userId: Types.ObjectId;
  currentRefreshTokenHash: string;
  previousRefreshTokenHashes: string[];
  userAgent?: string;
  ip?: string;
  lastUsedAt: Date;
  lastRotatedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionDocument = HydratedDocument<SessionAttrs>;

const sessionSchema = new Schema<SessionAttrs>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    currentRefreshTokenHash: {
      type: String,
      required: true,
      select: false,
    },
    previousRefreshTokenHashes: {
      type: [String],
      default: [],
      select: false,
    },
    userAgent: {
      type: String,
      maxlength: MAX_USER_AGENT_LENGTH,
    },
    ip: {
      type: String,
      maxlength: MAX_IP_LENGTH,
    },
    lastUsedAt: {
      type: Date,
      default: () => new Date(),
    },
    /**
     * When this session's refresh token was last rotated — null until the
     * first rotation.
     *
     * Exists solely so refresh classification can distinguish a benign
     * concurrent double-submit (the immediately-previous token, presented
     * within the grace window) from a genuine replay of a stolen token. It
     * deliberately does NOT reuse `lastUsedAt`: that field's meaning is
     * broader, and basing a revoke-everything security decision on a value
     * some future non-rotation code path might also write would be a silent
     * failure waiting to happen.
     */
    lastRotatedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * TTL cleanup only — NOT a security control. MongoDB's TTL monitor runs
 * roughly every 60 seconds, so an expired Session can physically remain
 * in the collection after expiresAt. Validity must always be evaluated
 * logically (expiresAt > now AND revokedAt == null); see
 * sessionRepository.findActiveByUser and ADR-004 §6.
 */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Deliberately NOT indexed:
 * - previousRefreshTokenHashes — nothing queries by it; the refresh flow
 *   routes via the token's sessionId component and loads one document.
 * - currentRefreshTokenHash — same reason. Uniqueness is not needed for
 *   routing, and hash collision between cryptographically random secrets
 *   is negligible, so a unique index would only add an index over
 *   sensitive material for no benefit.
 *
 * { userId: 1 } is declared on the path above and serves session listing
 * and logout-all.
 */

/**
 * Defense in depth: token state never survives serialization, even when a
 * query explicitly selected it for refresh validation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripSensitiveFields(_doc: any, ret: any) {
  delete ret.currentRefreshTokenHash;
  delete ret.previousRefreshTokenHashes;
  delete ret.__v;
  return ret;
}
sessionSchema.set("toJSON", { transform: stripSensitiveFields });
sessionSchema.set("toObject", { transform: stripSensitiveFields });

export const SessionModel: Model<SessionAttrs> = model<SessionAttrs>("Session", sessionSchema);
