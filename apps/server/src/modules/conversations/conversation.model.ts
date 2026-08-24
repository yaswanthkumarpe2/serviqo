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
   * When this conversation last received a message. Stored rather than
   * derived, so a future "most recently active first" listing (the agent
   * inbox's central query) sorts on one indexed field instead of joining
   * against `Message` per row (ADR-022 §2).
   *
   * Defaults to creation time so a conversation with no messages yet still
   * sorts correctly rather than requiring a null-handling special case.
   */
  lastMessageAt: Date;
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
