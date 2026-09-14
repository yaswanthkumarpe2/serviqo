import { CustomerModel } from "./customer.model";

import type { CustomerDocument } from "./customer.model";
import type { Types } from "mongoose";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

export interface CreateCustomerInput {
  organizationId: ObjectIdLike;
  /** Optional. An anonymous visitor supplies none of these (ADR-019 §7, ADR-038 §5). */
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /** SHA-256 of the visitor key minted for this customer (ADR-038 §3). Never the key itself. */
  visitorKeyHash?: string | null;
}

/** Details a visitor may supply or update. `undefined` and `null` both mean "no change". */
export interface VisitorDetails {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

function detailsUpdate(details: VisitorDetails): Record<string, unknown> {
  const update: Record<string, unknown> = { lastSeenAt: new Date() };
  if (typeof details.name === "string") update.name = details.name;
  if (typeof details.email === "string") update.email = details.email;
  if (typeof details.phone === "string") update.phone = details.phone;
  return update;
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
   * The tenant-scoped BULK lookup, for the agent inbox's list (ADR-025 §7).
   *
   * Exists so rendering a page of conversations costs one customer query
   * rather than one per row — the N+1 this repository's header notes nothing
   * here can silently become, kept true by giving the caller a batched read
   * instead of leaving them to loop over `findByIdAndOrganization`.
   *
   * Scoped by `organizationId` like every other read here, so a caller who
   * somehow assembled ids from another tenant receives none of them back
   * rather than a partially-filtered list (ADR-019 §4). There is deliberately
   * no unscoped `findByIds`.
   *
   * Returns a `Map` rather than an array: the caller's next act is always
   * "look up the customer for this conversation", and handing back an array
   * would make every caller build this same index by hand.
   */
  async findByIdsAndOrganization(
    customerIds: ObjectIdLike[],
    organizationId: ObjectIdLike,
  ): Promise<Map<string, CustomerDocument>> {
    if (customerIds.length === 0) return new Map();

    const customers = await CustomerModel.find({ _id: { $in: customerIds }, organizationId });

    return new Map(customers.map((customer) => [customer._id.toString(), customer]));
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
    details: VisitorDetails = {},
  ): Promise<CustomerDocument | null> {
    return CustomerModel.findOneAndUpdate(
      { _id: customerId, organizationId },
      { $set: detailsUpdate(details) },
      // The updated document, so the caller reports what was actually stored
      // rather than what it hoped was.
      { returnDocument: "after" },
    );
  },

  /**
   * Resumes a visitor by the hash of their visitor key, recording the visit
   * (ADR-038 §3).
   *
   * The key's owner AND the organisation are both in the predicate. A key from
   * organisation A presented through organisation B's widget matches nothing,
   * and the caller creates a new anonymous customer in B — never a refusal that
   * would tell anybody the key was real somewhere.
   */
  async recordVisitByVisitorKey(
    visitorKeyHash: string,
    organizationId: ObjectIdLike,
    details: VisitorDetails = {},
  ): Promise<CustomerDocument | null> {
    return CustomerModel.findOneAndUpdate(
      { organizationId, visitorKeyHash },
      { $set: detailsUpdate(details) },
      { returnDocument: "after" },
    );
  },

  /**
   * Gives a customer created before ADR-038 its first visitor key.
   *
   * Set-once by predicate (`visitorKeyHash: null`), the same instrument
   * `markEmailVerified` uses: of two tabs resuming the same old customer at
   * once, one key wins, and the loser's `null` result tells the caller not to
   * hand out a key the database never stored.
   */
  async attachVisitorKey(
    customerId: ObjectIdLike,
    organizationId: ObjectIdLike,
    visitorKeyHash: string,
  ): Promise<boolean> {
    const result = await CustomerModel.updateOne(
      { _id: customerId, organizationId, visitorKeyHash: null },
      { $set: { visitorKeyHash } },
    );
    return result.modifiedCount === 1;
  },
};
