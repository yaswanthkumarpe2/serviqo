import { MAX_PREVIOUS_REFRESH_TOKEN_HASHES, SessionModel } from "./session.model";
import type { SessionDocument } from "./session.model";
import type { Types } from "mongoose";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

export interface CreateSessionInput {
  userId: ObjectIdLike;
  /** Hash of the refresh secret — never the raw secret. Hashing belongs to the future auth/token service. */
  currentRefreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
}

/** Fields safe to expose. Token state is deliberately absent — see findByIdWithRefreshTokenState. */
const SENSITIVE_FIELDS = "+currentRefreshTokenHash +previousRefreshTokenHashes";

/**
 * Session persistence. Accepts token *hashes* at its boundary — it never
 * generates, parses, or hashes tokens; that is the future auth/token
 * service's job (ADR-004 §2-3).
 *
 * Two retrieval tiers, deliberately distinguished by name:
 *
 *   findById()                      — ordinary. Token state absent.
 *   findByIdWithRefreshTokenState() — security-sensitive. Opts into the
 *                                     hashes for refresh validation.
 *
 * Because both hash fields are `select: false`, the ordinary path cannot
 * leak them by accident; only the explicitly-named method can reach them,
 * making its security significance obvious at the call site.
 */
export const sessionRepository = {
  async create(input: CreateSessionInput): Promise<SessionDocument> {
    // Passed straight through so Mongoose's required/maxlength validators
    // produce a clean ValidationError rather than a raw TypeError.
    return SessionModel.create(input);
  },

  /** Ordinary retrieval. Never returns refresh-token state. */
  async findById(id: ObjectIdLike): Promise<SessionDocument | null> {
    return SessionModel.findById(id);
  },

  /**
   * SECURITY-SENSITIVE: returns the session including its current and
   * previously-rotated refresh-token hashes. Intended solely for refresh
   * validation and reuse detection. The returned document must never be
   * serialized into a response — toJSON/toObject strip the hashes as a
   * second line of defense if it is.
   */
  async findByIdWithRefreshTokenState(id: ObjectIdLike): Promise<SessionDocument | null> {
    return SessionModel.findById(id).select(SENSITIVE_FIELDS);
  },

  /**
   * Sessions usable right now, newest first — backs future session/device
   * listing and logout-all.
   *
   * Expiry is filtered LOGICALLY rather than trusting the TTL index to
   * have removed the document: MongoDB's TTL monitor is asynchronous, so
   * an expired session can still be present (ADR-004 §6).
   */
  async findActiveByUser(userId: ObjectIdLike): Promise<SessionDocument[]> {
    return SessionModel.find({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ lastUsedAt: -1 });
  },

  /**
   * Atomically rotates the refresh token: the outgoing hash is appended to
   * history, the history is trimmed to its bound, the new hash becomes
   * current, and lastUsedAt advances.
   *
   * Done as a single aggregation-pipeline update rather than
   * read-modify-write so two concurrent rotations cannot interleave and
   * lose a history entry or exceed the bound. This repository — not the
   * future auth service — owns the bounded-history invariant, so no
   * caller can violate it (ADR-004 §4).
   *
   * Returns the updated session *with* token state, since the caller is
   * by definition in the middle of refresh validation. Returns null if no
   * session matched.
   */
  async rotateRefreshToken(id: ObjectIdLike, newRefreshTokenHash: string): Promise<SessionDocument | null> {
    return SessionModel.findByIdAndUpdate(
      id,
      [
        {
          $set: {
            previousRefreshTokenHashes: {
              $slice: [
                { $concatArrays: ["$previousRefreshTokenHashes", ["$currentRefreshTokenHash"]] },
                -MAX_PREVIOUS_REFRESH_TOKEN_HASHES,
              ],
            },
            currentRefreshTokenHash: newRefreshTokenHash,
            lastUsedAt: new Date(),
          },
        },
      ],
      // updatePipeline: Mongoose requires an explicit opt-in before it will
      // send an aggregation pipeline (rather than a plain update document)
      // to the server.
      { returnDocument: "after", updatePipeline: true },
    ).select(SENSITIVE_FIELDS);
  },

  /** Revokes one session (future logout). Already-revoked sessions keep their original timestamp. */
  async revokeById(id: ObjectIdLike): Promise<SessionDocument | null> {
    return SessionModel.findOneAndUpdate(
      { _id: id, revokedAt: null },
      { revokedAt: new Date() },
      { returnDocument: "after" },
    );
  },

  /**
   * Revokes every currently-active session for a user (future logout-all,
   * and the response to detected refresh-token reuse). Returns the number
   * revoked. Only touches sessions that are not already revoked, so
   * earlier revocation timestamps are preserved.
   */
  async revokeAllForUser(userId: ObjectIdLike): Promise<number> {
    const result = await SessionModel.updateMany(
      { userId, revokedAt: null },
      { revokedAt: new Date() },
    );
    return result.modifiedCount;
  },
};
