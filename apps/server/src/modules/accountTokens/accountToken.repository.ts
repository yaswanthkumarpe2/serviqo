import { AccountTokenModel } from "./accountToken.model";
import type { AccountTokenDocument, AccountTokenPurpose } from "./accountToken.model";
import type { Types } from "mongoose";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

export interface CreateAccountTokenInput {
  userId: ObjectIdLike;
  purpose: AccountTokenPurpose;
  /** SHA-256 hash of the secret — never the raw secret itself. */
  tokenHash: string;
  expiresAt: Date;
}

export interface ConsumeAccountTokenInput {
  tokenHash: string;
  purpose: AccountTokenPurpose;
  now: Date;
}

export interface InvalidateAccountTokensInput {
  userId: ObjectIdLike;
  purpose: AccountTokenPurpose;
}

/**
 * Persistence for single-use account action credentials (ADR-005).
 *
 * Three operations, no generic CRUD. In particular there is no
 * `findByHash` / `findValidByHashAndPurpose`: a read that merely *checks*
 * validity invites check-then-act, which is exactly the race atomic
 * consumption exists to eliminate. Consumption is the only authoritative
 * path.
 *
 * Every input is an object rather than positional strings, so a caller
 * cannot silently transpose `tokenHash` and `purpose`, and no shape exists
 * through which `purpose` can be omitted.
 */
export const accountTokenRepository = {
  async create(input: CreateAccountTokenInput): Promise<AccountTokenDocument> {
    // Passed straight through so Mongoose's required/enum validators produce
    // a clean ValidationError rather than a raw TypeError.
    return AccountTokenModel.create(input);
  },

  /**
   * Atomically consumes a token, returning the consumed document or null.
   *
   * The predicate carries all four conditions — hash, purpose, not already
   * consumed, not expired — so validation and the state change happen in one
   * indivisible operation. Of N concurrent callers presenting the same valid
   * token, exactly one matches `consumedAt: null` and flips it; the rest no
   * longer match and receive null.
   *
   * `expiresAt: { $gt: now }` is mandatory: the TTL index is storage cleanup,
   * and an expired document routinely still exists.
   *
   * The returned document does not include `tokenHash` (`select: false`), so
   * it is safe to pass onward.
   */
  async consumeValidByHashAndPurpose(input: ConsumeAccountTokenInput): Promise<AccountTokenDocument | null> {
    return AccountTokenModel.findOneAndUpdate(
      {
        tokenHash: input.tokenHash,
        purpose: input.purpose,
        consumedAt: null,
        expiresAt: { $gt: input.now },
      },
      { $set: { consumedAt: input.now } },
      { returnDocument: "after" },
    );
  },

  /**
   * Deletes a user's outstanding UNUSED tokens for one purpose, so a newly
   * issued token can supersede them. Returns how many were removed.
   *
   * Consumed tokens are deliberately preserved (`consumedAt: null` in the
   * predicate): they record that the user actually completed an action, and
   * keeping them until TTL is what allows a replayed already-used token to
   * be distinguished from a fabricated one. Superseded tokens are deleted
   * rather than marked consumed, because they were never used and saying
   * otherwise would corrupt that distinction (ADR-005 §6).
   *
   * Scoped to one user and one purpose, so invalidating password resets
   * never touches another user's tokens or the same user's pending email
   * verification.
   */
  async invalidateOutstandingForUser(input: InvalidateAccountTokensInput): Promise<number> {
    const result = await AccountTokenModel.deleteMany({
      userId: input.userId,
      purpose: input.purpose,
      consumedAt: null,
    });
    return result.deletedCount;
  },
};
