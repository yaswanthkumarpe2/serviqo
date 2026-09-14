import { LOGIN_LOCK_DURATION_MS, LOGIN_MAX_FAILED_ATTEMPTS } from "../../config/constants";
import { UserModel, normalizeEmail } from "./user.model";
import type { UserDocument } from "./user.model";
import type { Types } from "mongoose";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  name: string;
}

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

/**
 * Minimal persistence surface — create/findById/findByEmail, plus the one
 * intentionally narrow write below. Still no listAll/delete/generic update:
 * speculative CRUD here is exactly the kind of unused surface that rots,
 * and on an unauthenticated code path it is a liability rather than
 * convenience.
 *
 * MongoDB's unique index on email is the actual authority against
 * duplicate identities, not this repository — create() lets a duplicate
 * key (Mongo error code 11000) propagate untouched. Translating that
 * into the standard API Conflict error belongs to the future
 * registration service, which is the first caller that needs to turn it
 * into an HTTP response.
 *
 * Returns Mongoose documents directly, typed via UserAttrs, rather than
 * a hand-mapped DTO — the smallest boundary that's still type-safe.
 * Only this module touches Mongoose directly; if that stops being true,
 * introduce a mapping function then, not preemptively now.
 */
export const userRepository = {
  async create(input: CreateUserInput): Promise<UserDocument> {
    // Passed straight through — the schema's own trim/lowercase transforms
    // normalize on save, and its required validators reject missing
    // fields cleanly. Pre-normalizing here (e.g. input.email.trim()) would
    // throw a raw TypeError on a missing field instead of a ValidationError.
    return UserModel.create(input);
  },

  async findById(id: string): Promise<UserDocument | null> {
    return UserModel.findById(id);
  },

  async findByEmail(email: string): Promise<UserDocument | null> {
    return UserModel.findOne({ email: normalizeEmail(email) });
  },

  /**
   * Several users by id, in one query (ADR-026 §11).
   *
   * NOT a `findAll` and not a general list: it answers only about ids the
   * caller already holds, and its sole caller has already proved every one of
   * them is an active member of the tenant being read
   * (`membershipRepository.findActiveByOrganizationAndUsers`). This repository
   * carries no `organizationId` because `User` carries no tenancy — a user
   * belongs to as many organizations as they hold memberships in
   * (ADR-010 §1) — so the tenant proof MUST happen before this call rather
   * than inside it, and the ordering is the security property.
   *
   * Batched for the reason `customerRepository.findByIdsAndOrganization` is:
   * one query per row is the N+1 that makes a list endpoint slow, and
   * resolving a page of assignees is exactly that shape.
   */
  async findByIds(ids: ObjectIdLike[]): Promise<Map<string, UserDocument>> {
    if (ids.length === 0) return new Map();

    const users = await UserModel.find({ _id: { $in: ids } });

    return new Map(users.map((user) => [user._id.toString(), user]));
  },

  /**
   * SECURITY-SENSITIVE: returns the user including `passwordHash`, which
   * `select: false` keeps out of every ordinary query.
   *
   * Named for what it does, so its significance is visible at the call site —
   * the same convention as `sessionRepository.findByIdWithRefreshTokenState`.
   * Intended solely for credential verification during login. The returned
   * document must never be serialized into a response; `toJSON`/`toObject`
   * strip the hash as a second line of defense if it is.
   */
  async findByEmailWithPasswordHash(email: string): Promise<UserDocument | null> {
    return UserModel.findOne({ email: normalizeEmail(email) }).select("+passwordHash");
  },

  /**
   * Marks an address verified, exactly once (ADR-009 §3).
   *
   * Returns the updated document, or `null` when the user does not exist OR
   * was already verified — the caller cannot tell those apart from the
   * return value alone, and does not need to.
   *
   * The `emailVerifiedAt: null` predicate is what makes this set-once: of
   * two concurrent verifications, the second matches nothing and changes
   * nothing, so the first timestamp is the one that survives. That is also
   * why this is a single atomic update rather than a read-then-save, which
   * would reintroduce the race.
   *
   * Deliberately not a general `update(id, patch)`. This can set one field
   * and cannot reach `email`, `passwordHash`, `status`, or the lockout
   * fields — the guarantee that matters when the only caller is an
   * unauthenticated endpoint. It also cannot *un*-verify an account, which
   * a `$set` keyed on `_id` alone would allow.
   */
  async markEmailVerified(id: ObjectIdLike, verifiedAt: Date): Promise<UserDocument | null> {
    return UserModel.findOneAndUpdate(
      { _id: id, emailVerifiedAt: null },
      { $set: { emailVerifiedAt: verifiedAt } },
      { returnDocument: "after" },
    );
  },

  /**
   * Records one failed login attempt and locks the account when the attempt
   * crosses `LOGIN_MAX_FAILED_ATTEMPTS` (ADR-011 §7).
   *
   * A single aggregation-pipeline update rather than read-modify-write, so
   * two concurrent failures cannot both read the same count and lose one —
   * the same technique and the same reason as
   * `sessionRepository.rotateRefreshToken`. Two stages are required because
   * the second must see the incremented value the first produced.
   *
   * Crossing the threshold ALSO resets the counter to zero. If it stayed at
   * its maximum, the first failure after the lock expired would immediately
   * re-lock, and a user who simply forgot their password would be locked out
   * permanently by a mechanism whose stated requirement is that it always
   * auto-expires.
   *
   * This repository owns that invariant, so no caller can implement the
   * threshold differently or forget the reset.
   */
  async registerFailedLogin(id: ObjectIdLike): Promise<UserDocument | null> {
    // Computed once in Node rather than inside the pipeline: $$NOW would be
    // the server's clock, and every other expiry in this codebase is derived
    // from the application's.
    const lockedUntil = new Date(Date.now() + LOGIN_LOCK_DURATION_MS);

    return UserModel.findByIdAndUpdate(
      id,
      [
        { $set: { failedLoginAttempts: { $add: ["$failedLoginAttempts", 1] } } },
        {
          $set: {
            lockedUntil: {
              $cond: [{ $gte: ["$failedLoginAttempts", LOGIN_MAX_FAILED_ATTEMPTS] }, lockedUntil, "$lockedUntil"],
            },
            failedLoginAttempts: {
              $cond: [{ $gte: ["$failedLoginAttempts", LOGIN_MAX_FAILED_ATTEMPTS] }, 0, "$failedLoginAttempts"],
            },
          },
        },
      ],
      // updatePipeline: Mongoose requires an explicit opt-in before it will
      // send an aggregation pipeline rather than a plain update document.
      { returnDocument: "after", updatePipeline: true },
    );
  },

  /**
   * Clears lockout state after a successful authentication.
   *
   * Deliberately narrow, like `markEmailVerified`: it reaches the two lockout
   * fields and nothing else, and cannot touch `email`, `passwordHash`,
   * `status`, or `emailVerifiedAt`. `userRepository` still has no general
   * `update(id, patch)`, which is the guarantee that matters when these
   * methods sit on an unauthenticated code path.
   */
  async clearLoginFailures(id: ObjectIdLike): Promise<void> {
    await UserModel.updateOne({ _id: id }, { $set: { failedLoginAttempts: 0, lockedUntil: null } });
  },

  /**
   * Replaces a password after a redeemed reset code, and lifts any lockout in
   * the same write (ADR-036 §4). Returns whether an account was updated.
   *
   * Narrow in the way the two methods above are, and for the same reason: its
   * only caller is an unauthenticated endpoint, so it reaches the password and
   * the lockout pair and cannot touch `email`, `status`, `kind` or
   * `platformRole`. It takes a HASH — Argon2id belongs to the crypto boundary,
   * and a repository that accepted plaintext would be one more place a
   * password could be logged from.
   *
   * The lockout is cleared in the same update rather than by a second call,
   * because a reset exists for the person who is locked out: a password that
   * changed while the account stayed locked would look to them like a reset
   * that did not work.
   *
   * A plain `$set`, never an aggregation pipeline. An Argon2id hash begins
   * with `$argon2id$`, and inside a pipeline a string starting with `$` is
   * read as a FIELD PATH — the stored "hash" would silently become whatever
   * that path resolves to, which is nothing, and the account would be
   * unrecoverable.
   */
  async replacePasswordAfterReset(id: ObjectIdLike, passwordHash: string): Promise<boolean> {
    const result = await UserModel.updateOne(
      { _id: id },
      { $set: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } },
    );
    return result.matchedCount === 1;
  },
};
