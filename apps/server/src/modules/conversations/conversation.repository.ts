import { Types } from "mongoose";

import { ConversationModel } from "./conversation.model";

import type { ConversationDocument } from "./conversation.model";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

/**
 * The composite keyset cursor `listByOrganization` pages on (ADR-025 §5).
 *
 * Both halves are required because the sort key is a pair — see that method
 * for why the `_id` tiebreak cannot be dropped.
 */
export interface ConversationListCursor {
  lastMessageAt: Date;
  id: string;
}

export interface ListConversationsOptions {
  /** Exclusive upper bound in sort order — return conversations strictly after this one. */
  cursor?: ConversationListCursor;
  /** Row count to return. The caller (the service) decides the default/max. */
  limit: number;
}

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
   * THE tenant-scoped lookup by id, for staff (ADR-025 §5).
   *
   * Two keys rather than `findByIdForCustomer`'s three, and that difference
   * IS the agent/customer authorization distinction: an agent is legitimately
   * entitled to every conversation in their own tenant and to none outside
   * it, so `customerId` is not a key they must match.
   *
   * Expressed as a separate method rather than an optional third argument on
   * one shared method, so "may this caller reach conversations they are not
   * the customer of?" is answered by which function they can call, never by a
   * flag someone could pass wrongly.
   *
   * A conversation under another organization returns `null` here, identically
   * to one that does not exist — the indistinguishability ADR-025 §10 relies
   * on starts at this query, not at the error it produces.
   */
  async findByIdForOrganization(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOne({ _id: conversationId, organizationId });
  },

  /**
   * One tenant's conversations, most recently active first, keyset-paginated
   * (ADR-025 §5) — the agent inbox's central query, and the read
   * `conversation.model.ts` stored `lastMessageAt` for rather than deriving
   * it per row.
   *
   * Sorted by `lastMessageAt` descending with `_id` descending as tiebreak.
   * `lastMessageAt` is NOT unique, so the tiebreak is load-bearing: a cursor
   * over a non-unique sort key that ignored it would skip or repeat rows
   * whenever two conversations shared a millisecond, which is common the
   * moment a tenant is busy.
   *
   * Requests `limit + 1` rows so the caller can tell whether a further page
   * exists without a separate `count()`, exactly as `messageRepository.list`
   * does.
   */
  async listByOrganization(
    organizationId: ObjectIdLike,
    { cursor, limit }: ListConversationsOptions,
  ): Promise<ConversationDocument[]> {
    const filter: Record<string, unknown> = { organizationId };

    if (cursor !== undefined) {
      /*
        The standard lexicographic-tuple range predicate for a composite
        sort key: strictly older, or equally old but a lower `_id`. Written
        as an explicit `$or` rather than a clever single comparison because
        MongoDB has no tuple comparison and a hand-rolled approximation here
        would fail exactly in the tie case this exists to handle.
      */
      filter.$or = [
        { lastMessageAt: { $lt: cursor.lastMessageAt } },
        { lastMessageAt: cursor.lastMessageAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }

    return ConversationModel.find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(limit + 1);
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
