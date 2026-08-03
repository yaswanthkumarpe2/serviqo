import { UserModel, normalizeEmail } from "./user.model";
import type { UserDocument } from "./user.model";

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  name: string;
}

/**
 * Minimal persistence surface for this slice — create/findById/findByEmail
 * only. No listAll/delete/update/search: nothing in the codebase needs
 * them yet, and speculative CRUD here is exactly the kind of unused
 * surface that rots.
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
};
