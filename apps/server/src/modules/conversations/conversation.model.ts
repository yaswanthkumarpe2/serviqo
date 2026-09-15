import { Schema, model } from "mongoose";

import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * A Conversation is one customer's ongoing exchange with one organization
 * (ADR-022 §2). Serviqo's second tenant-owned resource model after
 * `Customer` (ADR-019 §4), and it inherits that model's pattern exactly:
 * every repository method scoped by `organizationId`, no unscoped read.
 *
 * `status` is deliberately a two-value enum, not `Ticket`'s eventual
 * multi-state lifecycle (`OPEN`, `IN_PROGRESS`, `WAITING_CUSTOMER`, …,
 * PROJECT_CONTEXT.md §18) — a conversation is being talked in or it is not;
 * a richer workflow belongs to the different model that owns it.
 */
export type ConversationStatus = "open" | "closed";

export interface ConversationAttrs {
  organizationId: Types.ObjectId;
  customerId: Types.ObjectId;
  status: ConversationStatus;
  /**
   * The staff member handling this conversation, or `null` when nobody has
   * picked it up (ADR-026 §1).
   *
   * References `User` rather than `Membership`: what is recorded is WHICH
   * PERSON is handling this, and a person outlives any particular membership
   * document — one deleted and re-created for the same user in the same
   * tenant is the same human being, and an assignment that dangled across
   * that operation would be a bug with no upside.
   *
   * Carries no tenancy of its own and needs none: the conversation is already
   * tenant-scoped, and every read and write of this field goes through a
   * repository method taking `organizationId` as a mandatory key (ADR-022 §1).
   *
   * Nullable rather than optional, so "nobody has claimed this" and "written
   * by an older version of the code" are not the same storage state, and so
   * `{ assignedTo: null }` is a filter the unassigned-queue query can express
   * directly (ADR-026 §5).
   *
   * Deliberately NOT accompanied by `assignedAt`, `assignedBy`, or any
   * history: each is an audit-trail concern ROADMAP Phase 18 owns, and a
   * half-audit is the kind of field that gets trusted for exactly the
   * question it cannot answer (ADR-026 §1).
   */
  assignedTo: Types.ObjectId | null;
  /**
   * When this conversation last received a message. Stored rather than
   * derived, so a future "most recently active first" listing (the agent
   * inbox's central query) sorts on one indexed field instead of joining
   * against `Message` per row (ADR-022 §2).
   *
   * Defaults to creation time so a conversation with no messages yet still
   * sorts correctly rather than requiring a null-handling special case.
   */
  lastMessageAt: Date;
  /**
   * Customer messages no agent has read yet (ADR-040 §4). Shared by the team:
   * the inbox is one queue, so "read" means someone on the team opened it.
   */
  unreadByAgents: number;
  /** Agent messages the customer has not seen yet (ADR-040 §4). */
  unreadByCustomer: number;
  /** When the team last read this conversation. Drives "Seen" in the customer's chat. */
  agentLastReadAt: Date | null;
  /** When the customer last read this conversation. Drives "Seen" in the inbox. */
  customerLastReadAt: Date | null;
  /** Labels the team puts on a conversation, lowercase (ADR-042 §3). Never shown to the customer. */
  tags: string[];
  createdAt: Date;
  /**
   * When THIS document's own state last changed (its `status`), distinct
   * from `lastMessageAt` — the two are expected to diverge the moment a
   * conversation is closed without a new message (ADR-022 §2).
   */
  updatedAt: Date;
}

export type ConversationDocument = HydratedDocument<ConversationAttrs>;

const conversationSchema = new Schema<ConversationAttrs>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      immutable: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ["open", "closed"] satisfies ConversationStatus[],
      default: "open",
      required: true,
    },
    lastMessageAt: {
      type: Date,
      default: () => new Date(),
      required: true,
    },
    /*
      `default: null` rather than no default, so an unclaimed conversation
      stores an explicit null that `{ assignedTo: null }` matches — an absent
      field would match that filter too under MongoDB's equality semantics,
      but only by accident, and a document written before this field existed
      would then be indistinguishable from one deliberately released.

      Not `immutable`, unlike `organizationId` and `customerId` above: this is
      the one field on this model that exists to be changed, and §4's claim
      and release are the two writes that change it.
    */
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    unreadByAgents: { type: Number, default: 0, min: 0 },
    unreadByCustomer: { type: Number, default: 0, min: 0 },
    agentLastReadAt: { type: Date, default: null },
    customerLastReadAt: { type: Date, default: null },
    tags: { type: [String], default: [] },
  },
  {
    timestamps: true,
  },
);

/**
 * At most one OPEN conversation per customer, enforced by the database
 * rather than by a check-then-create in application code (ADR-022 §3).
 *
 * Partial — constrains only `status: "open"` documents, the identical
 * instrument `membership.model.ts` index B uses for "at most one owner per
 * organization" — so any number of `closed` conversations may accumulate
 * for one customer without ever colliding with this index.
 *
 * Also serves `conversationRepository.findOpenByCustomer`: the query
 * `{ organizationId, customerId, status: "open" }` matches this index's own
 * partial filter exactly, so it is usable for that read as well as for the
 * uniqueness guarantee.
 */
conversationSchema.index(
  { organizationId: 1, customerId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);

/**
 * Serves the agent inbox's central query (ADR-025 §5):
 * `conversationRepository.listByOrganization` — one tenant's conversations,
 * most recently active first, keyset-paginated.
 *
 * The key order matches that query exactly: the equality filter
 * (`organizationId`), then the sort key (`lastMessageAt` descending), then
 * the `_id` tiebreak the cursor's range predicate needs. One covering index
 * for the filter, the sort, and the pagination scan together, which is the
 * whole reason `lastMessageAt` is stored on this document rather than
 * derived from `Message` per row.
 */
conversationSchema.index({ organizationId: 1, lastMessageAt: -1, _id: -1 });

/**
 * Serves the assigned-queue reads ADR-026 §5 adds: "conversations assigned to
 * me" and "conversations nobody has claimed", both most recently active first
 * and both keyset-paginated through the identical cursor.
 *
 * Key order matches those queries exactly, the same discipline the index
 * above follows: equality on the tenant, equality on the assignee, then the
 * sort key and the cursor's `_id` tiebreak.
 *
 * `status` is deliberately absent from every index and is filtered rather
 * than sought (ADR-026 §1). It is two-valued, so an index key on it roughly
 * halves the candidate set — less than it costs on every write — and a
 * status-only filter is already served by the sort index above.
 */
conversationSchema.index({ organizationId: 1, assignedTo: 1, lastMessageAt: -1, _id: -1 });

// The tag filter (ADR-042 §3): multikey on `tags`, same sort as the list.
conversationSchema.index({ organizationId: 1, tags: 1, lastMessageAt: -1, _id: -1 });

// Same serialization boundary as every tenant-owned model: internal
// Mongoose bookkeeping never survives serialization.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
conversationSchema.set("toJSON", { transform: stripInternalFields });
conversationSchema.set("toObject", { transform: stripInternalFields });

export const ConversationModel: Model<ConversationAttrs> = model<ConversationAttrs>(
  "Conversation",
  conversationSchema,
);
