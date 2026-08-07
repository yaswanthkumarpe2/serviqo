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
};
