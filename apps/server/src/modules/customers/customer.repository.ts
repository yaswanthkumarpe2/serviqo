import { CustomerModel } from "./customer.model";

import type { CustomerDocument } from "./customer.model";
import type { Types } from "mongoose";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

export interface CreateCustomerInput {
  organizationId: ObjectIdLike;
  /** Optional. An anonymous visitor supplies neither of these (ADR-019 §7). */
  name?: string | null;
  email?: string | null;
}

/**
 * Serviqo's first tenant-OWNED resource repository, and the pattern
 * `Conversation` and `Ticket` will inherit (SECURITY.md §2).
 *
 * `organizationRepository` is the tenant root and is deliberately unscoped.
 * This one is the opposite: every read takes `organizationId` as a mandatory
 * argument, so "fetch all customers then filter in memory" is not something a
 * caller can express against this repository, rather than something they are
 * asked not to do.
 *
 * There is no `findAll`, no unscoped `find`, and no `findByEmail` — the last
 * of those most deliberately of all. A lookup by email would make email the
 * visitor credential, and anyone who typed a known address would inherit that
 * person's identity (ADR-019 §5). The method's absence is the control.
 *
 * Nothing is auto-populated, so no query here can silently become N+1.
 */
export const customerRepository = {
  /**
   * Creates a customer inside one organization.
   *
   * Passed straight through so the schema's own trim/lowercase transforms
   * normalize on save and its `required` validator rejects a missing
   * `organizationId` cleanly — the convention every repository here follows
   * (see `userRepository.create`, which stopped pre-normalizing for this
   * reason).
   */
  async create(input: CreateCustomerInput): Promise<CustomerDocument> {
    return CustomerModel.create(input);
  },

  /**
   * THE tenant-scoped lookup (ADR-019 §4).
   *
   * Both keys in ONE query. Deliberately not `findById` followed by
   * `customer.organizationId === expected`: that comparison is written by hand
   * and its failure modes are all quiet — an `ObjectId` compared to a `string`
   * with `===` is always false, and a comparison someone forgets is always
   * true.
   *
   * The same instrument `membershipRepository.findByUserAndOrganization`
   * uses, and for the same reason: the caller receives a document or `null`
   * and has no comparison left to get wrong.
   *
   * This is what makes a widget token from tenant A inert in tenant B. The
   * token's customer id is looked up under B's `organizationId`, finds
   * nothing, and the request proceeds as a new anonymous visitor
   * (ADR-019 §6).
   */
  async findByIdAndOrganization(
    customerId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<CustomerDocument | null> {
    return CustomerModel.findOne({ _id: customerId, organizationId });
  },

  /**
   * Records that a visitor was present, and updates the details they supplied.
   *
   * `lastSeenAt` is always written — that is what this method is for. `name`
   * and `email` are written only when supplied, so a widget that forgot to
   * send a field cannot erase what the visitor typed a minute earlier
   * (ADR-019 §5). Passing `null` or an absent value means "no change", never
   * "clear it"; there is deliberately no way to clear a stored value through
   * this repository.
   *
   * Scoped by BOTH ids for the same reason the read above is: a write that
   * located its target by `_id` alone would be a cross-tenant write waiting
   * for a caller to pass the wrong organization.
   *
   * Narrow rather than a general `update(id, patch)`, following the rule
   * `userRepository` set with `markEmailVerified` and `clearLoginFailures`.
   */
  async recordVisit(
    customerId: ObjectIdLike,
    organizationId: ObjectIdLike,
    details: { name?: string | null; email?: string | null } = {},
  ): Promise<CustomerDocument | null> {
    const update: Record<string, unknown> = { lastSeenAt: new Date() };
    if (typeof details.name === "string") update.name = details.name;
    if (typeof details.email === "string") update.email = details.email;

    return CustomerModel.findOneAndUpdate(
      { _id: customerId, organizationId },
      { $set: update },
      // The updated document, so the caller reports what was actually stored
      // rather than what it hoped was.
      { returnDocument: "after" },
    );
  },
};
