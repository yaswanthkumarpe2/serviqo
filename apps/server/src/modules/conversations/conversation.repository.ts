import { ConversationModel } from "./conversation.model";

import type { ConversationDocument } from "./conversation.model";
import type { Types } from "mongoose";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

/**
 * Conversation persistence (ADR-022 §1, §3, §7).
 *
 * Every method takes `organizationId`; the customer-facing ones take
 * `customerId` too. There is no `findById(conversationId)` alone and no
 * `findAll` — the same discipline `customerRepository` established
 * (ADR-019 §4): "fetch broadly then compare in memory" is not a thing a
 * caller can express against this repository.
 */
export const conversationRepository = {
  /**
   * The one lookup a customer performs: their own open conversation, or
   * none. Served by the same partial index that enforces uniqueness
   * (ADR-022 §3) — the filter here matches that index's partial expression
   * exactly.
   */
  async findOpenByCustomer(
    organizationId: ObjectIdLike,
    customerId: ObjectIdLike,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOne({ organizationId, customerId, status: "open" });
  },

  /**
   * Creates a conversation. Callers that need "the customer's open
   * conversation, creating one if absent" use `conversationService.resolveOpen`
   * (ADR-022 §7), which is what catches this method's duplicate-key error on
   * a race — this method itself does not.
   */
  async create(organizationId: ObjectIdLike, customerId: ObjectIdLike): Promise<ConversationDocument> {
    return ConversationModel.create({ organizationId, customerId });
  },

  /**
   * THE tenant-and-customer-scoped lookup by id (ADR-022 §1). Three keys in
   * one query, exactly `customerRepository.findByIdAndOrganization`'s
   * pattern extended by one field: a conversation that exists but belongs to
   * a different organization or a different customer returns `null` here,
   * identically to one that does not exist at all — the enumeration
   * resistance ADR-022 §8 relies on starts at this query, not at the error
   * it produces.
   */
  async findByIdForCustomer(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    customerId: ObjectIdLike,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOne({ _id: conversationId, organizationId, customerId });
  },

  /**
   * Records that a message just landed, best-effort (ADR-022 §10 — no
   * transaction, and the trade-off that decision states). Scoped by both
   * ids, matching every other write in this repository.
   */
  async touchLastMessageAt(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    when: Date,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOneAndUpdate(
      { _id: conversationId, organizationId },
      { $set: { lastMessageAt: when } },
      { returnDocument: "after" },
    );
  },
};
