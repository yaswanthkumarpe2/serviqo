import { Schema, model } from "mongoose";
import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * A Customer is a website visitor one tenant serves — Serviqo's second
 * principal type, and the sibling of `User` rather than a variant of it
 * (ADR-010 §1, ADR-019 §2).
 *
 * It is deliberately NOT a `User`, NOT a `Membership`, NOT an RBAC role, and
 * NOT anything that owns a `Session` or an `AccountToken`. A customer
 * authenticates nothing, registers nothing, and holds no position inside the
 * organization — they are the counterparty it exists to serve. The credential
 * that says "this browser is that customer" is a stateless widget token
 * (`modules/widget/widgetToken.ts`) and is not stored here or anywhere.
 *
 * Six fields, and the absences are decisions:
 *
 * - No `status`. `User` and `Organization` have one because someone can
 *   disable or suspend them. Nothing suspends a customer; the tenant-level
 *   control is suspending the organization.
 * - No `ipAddress`, `userAgent`, or fingerprint. `Session` stores those so a
 *   staff member reviewing their own devices can recognise them. A customer
 *   has no such screen, so this would be visitor tracking data collected for
 *   no consumer.
 * - No `passwordHash`, `sessionId`, `role`, or `permissions` (ADR-010 §1–2).
 * - No device id or fingerprint. Continuity is carried by credentials the
 *   visitor's own browser holds: the widget token for a day, and — since
 *   ADR-038 — a `visitorKey` for longer, stored here only as a hash. Both
 *   answer "which visitor is this" the same way, by proving possession, and
 *   neither is derived from the device (ADR-019 §1, ADR-038 §3).
 * - No conversation pointer. That relationship is ADR-010 §7's, owned by a
 *   model that does not exist yet, and pointing at it from here would put the
 *   join on the wrong side.
 */
export interface CustomerAttrs {
  /**
   * The tenant this customer belongs to. Required, with no nullable state:
   * a customer who belongs to no organization is not something this system
   * can represent (ADR-010 §4, SECURITY.md §2).
   */
  organizationId: Types.ObjectId;
  /**
   * Optional, and the sharpest structural difference from `User`, whose
   * `name` is required (ADR-010 §4). An anonymous visitor has none and must
   * still be served.
   */
  name: string | null;
  /**
   * Optional, NOT unique in any form, and NEVER a lookup key (ADR-019 §5).
   *
   * If a supplied address were used to FIND an existing customer, email would
   * become the visitor credential — anyone who typed a known address would
   * inherit that person's identity and, once conversations exist, their
   * history. That is an account-takeover primitive reachable by guessing from
   * an unauthenticated public endpoint.
   *
   * It is written to the customer a request has already identified, and never
   * read to identify one. Because no lookup happens, no response can differ
   * based on whether an address is known — the enumeration oracle ADR-010 §5
   * warned about does not exist to be leaked.
   */
  email: string | null;
  /**
   * When this visitor was last present, as distinct from when this record was
   * last modified (ADR-019 §2).
   *
   * `updatedAt` is not a substitute. Today they hold the same value because
   * the widget session endpoint is this collection's only writer — but the
   * moment an agent edits a customer's name, `updatedAt` starts meaning
   * "someone changed this record" while the question still needing an answer
   * is "was this visitor here". Without it, an abandoned drive-by record is
   * indistinguishable from a live one and no retention policy can ever be
   * written against the collection that will grow fastest in the system.
   */
  lastSeenAt: Date;
  /**
   * Optional, like `name` and `email`, and never a lookup key for the reason
   * `email` gives: anyone can type a phone number (ADR-038 §5).
   */
  phone: string | null;
  /**
   * SHA-256 of the visitor's long-lived `visitorKey` (ADR-038 §3).
   *
   * The widget token is the visitor's credential for a day and cannot be
   * revoked, which is why it is short-lived (ADR-019 §14). A customer who comes
   * back next week must still find their conversation without logging in, so
   * the browser also holds a 256-bit key issued once, and this is the only
   * trace of it the server keeps.
   *
   * It IS a lookup key, and safe as one for the reason `email` is not: it
   * cannot be typed or guessed. Finding a customer by it proves the caller
   * holds the secret, and the lookup always carries `organizationId` too, so a
   * key from one organisation resumes nothing in another.
   *
   * `null` for customers created before ADR-038; their next session mints one.
   */
  visitorKeyHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerDocument = HydratedDocument<CustomerAttrs>;

/**
 * Canonicalizes an email the same way on write and on read, matching
 * `user.model.ts` exactly.
 *
 * Exported for symmetry with `normalizeEmail` there, and NOT because a lookup
 * needs it — no query filters on this field, by design (see `email` above).
 * One address stored two ways inside one tenant is a data defect regardless
 * of whether anything searches for it, and the platform should canonicalize
 * identically in both collections.
 */
export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

const customerSchema = new Schema<CustomerAttrs>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    name: {
      type: String,
      default: null,
      trim: true,
    },
    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      /*
        No `unique`, and no index at all. Nothing queries by email, and an
        index would be the first half of writing the query that must not
        exist (ADR-019 §3, §5).
      */
    },
    lastSeenAt: {
      type: Date,
      default: () => new Date(),
      required: true,
    },
    phone: {
      type: String,
      default: null,
      trim: true,
    },
    visitorKeyHash: {
      type: String,
      default: null,
      // Never returned by an ordinary query. Resuming matches BY the hash
      // inside the database, so nothing needs to read it back.
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * The tenant-boundary index.
 *
 * `organizationId` is a predicate on every query against this collection, by
 * SECURITY.md §2 and by `customer.repository.ts`'s design — so it is the one
 * prefix every present and future read shares.
 *
 * Created NOW rather than alongside the first listing query — the sequence
 * `membership.model.ts` index C followed — for a reason specific to this
 * collection: `Customer` is the only one whose row count grows with visitor
 * traffic rather than with staff headcount. An index added after that growth
 * is an index build on the largest collection in the system; added here it
 * costs one index on an empty one.
 *
 * There is deliberately NO unique constraint. ADR-010 §4 requires that any
 * uniqueness be "per-organization and compound — never global", and this
 * model honours that by construction rather than by care: no attribute of a
 * customer is required to be distinct. Two anonymous visitors are genuinely
 * two customers, and two visits by one person who typed the same address are
 * also two customers unless the widget token says otherwise (ADR-019 §6).
 *
 * The single-document lookup this slice performs is `{ _id, organizationId }`,
 * which the default `_id` index serves.
 */
customerSchema.index({ organizationId: 1 });

/**
 * The visitor-key lookup (ADR-038 §3), and the one uniqueness this collection
 * has.
 *
 * Compound with `organizationId`, as ADR-010 §4 requires of any uniqueness
 * here: "per-organization and compound — never global". Partial, restricted to
 * documents that carry a hash, so every customer created before ADR-038 (all
 * `null`) is untouched — a plain unique index would let exactly one of them
 * exist per organisation.
 *
 * Two anonymous visitors are still two customers. A 256-bit key colliding is
 * not an event this index exists to handle; it is here so the lookup is
 * served by an index and so a duplicate write fails loudly if it ever happened.
 */
customerSchema.index(
  { organizationId: 1, visitorKeyHash: 1 },
  { unique: true, partialFilterExpression: { visitorKeyHash: { $type: "string" } } },
);

/**
 * The same serialization boundary as User, Organization, and Membership:
 * internal Mongoose bookkeeping never survives serialization.
 *
 * There is no sensitive field to strip here — the model holds no credential,
 * no hash, and no token, which is itself the design (see the header). `__v`
 * has no API meaning.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.visitorKeyHash;
  delete ret.__v;
  return ret;
}
customerSchema.set("toJSON", { transform: stripInternalFields });
customerSchema.set("toObject", { transform: stripInternalFields });

export const CustomerModel: Model<CustomerAttrs> = model<CustomerAttrs>("Customer", customerSchema);
