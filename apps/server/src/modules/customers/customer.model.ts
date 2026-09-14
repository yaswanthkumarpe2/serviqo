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
 * - No `visitorId` or `deviceId`. Continuity across page loads is what the
 *   widget token is for; a stored device id would be a second, weaker answer
 *   to "which visitor is this", and two answers to one question is how they
 *   come to disagree (ADR-019 §1).
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
  },
  {
    timestamps: true,
  },
);

/**
 * The tenant-boundary index, and the only one this model declares.
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
 * The same serialization boundary as User, Organization, and Membership:
 * internal Mongoose bookkeeping never survives serialization.
 *
 * There is no sensitive field to strip here — the model holds no credential,
 * no hash, and no token, which is itself the design (see the header). `__v`
 * has no API meaning.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
customerSchema.set("toJSON", { transform: stripInternalFields });
customerSchema.set("toObject", { transform: stripInternalFields });

export const CustomerModel: Model<CustomerAttrs> = model<CustomerAttrs>("Customer", customerSchema);
