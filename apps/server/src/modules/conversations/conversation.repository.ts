import { Types } from "mongoose";

import { ConversationModel } from "./conversation.model";

import type { ConversationDocument, ConversationStatus } from "./conversation.model";

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

/**
 * Which conversations a listing is asking for, beyond the tenant
 * (ADR-026 §5).
 *
 * `assignee` is a RELATION, never a user id: `"me"` is resolved to the
 * verified caller before it reaches this repository, and `"unassigned"` names
 * no one at all. There is deliberately no `assignedTo: string` option here,
 * because an option of that shape is one a controller could fill from a query
 * string, and "which agent's queue may I read?" is a disclosure question this
 * slice does not answer (ADR-026 §11).
 */
export interface ConversationListFilter {
  status?: ConversationStatus;
  assignee?: { kind: "user"; userId: ObjectIdLike } | { kind: "unassigned" };
}

export interface ListConversationsOptions {
  /** Exclusive upper bound in sort order — return conversations strictly after this one. */
  cursor?: ConversationListCursor;
  /** Row count to return. The caller (the service) decides the default/max. */
  limit: number;
  /** Absent means "everything in this tenant" — ADR-025 §5's behaviour, unchanged. */
  filter?: ConversationListFilter;
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
    { cursor, limit, filter: listFilter }: ListConversationsOptions,
  ): Promise<ConversationDocument[]> {
    const filter: Record<string, unknown> = { organizationId };

    /*
      Applied to the QUERY, never to the page after it comes back
      (ADR-026 §5). Keyset pagination over a filtered set is only correct if
      the filter is part of the query the cursor pages through: trimming rows
      afterwards would return short pages and eventually an empty page with a
      non-null `nextCursor`, which is a bug that only shows up under volume.
    */
    if (listFilter?.status !== undefined) {
      filter.status = listFilter.status;
    }

    if (listFilter?.assignee !== undefined) {
      // `null` matches the explicit null `conversation.model.ts` defaults to.
      filter.assignedTo = listFilter.assignee.kind === "unassigned" ? null : listFilter.assignee.userId;
    }

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

  /**
   * Claims a conversation for `userId` — ONE conditional update, never a read
   * followed by a write (ADR-026 §4).
   *
   * The precondition lives in the FILTER: `assignedTo` is null (nobody has it)
   * or is already this user (idempotent re-claim). Two agents clicking
   * *Claim* on the same unassigned row in the same instant is the ordinary
   * contention an inbox exists to arbitrate, and a check-then-write would let
   * both succeed with the second silently overwriting the first — so the
   * losing agent's UI would show them as the owner while the database
   * disagreed. This filter makes MongoDB the arbiter: exactly one update
   * matches.
   *
   * `null` means the update did not apply, and it is deliberately AMBIGUOUS
   * between "unreachable conversation" and "someone else has it". The service
   * disambiguates with one further tenant-scoped read on the failure path
   * only — putting that branch here would mean this method reporting a
   * distinction its own query cannot make.
   *
   * Scoped by `organizationId` like every other write in this repository, so
   * a conversation in another tenant is not merely refused but never located.
   */
  async claimForUser(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    userId: ObjectIdLike,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOneAndUpdate(
      { _id: conversationId, organizationId, $or: [{ assignedTo: null }, { assignedTo: userId }] },
      { $set: { assignedTo: userId } },
      { returnDocument: "after" },
    );
  },

  /**
   * Releases a conversation `userId` holds (ADR-026 §4).
   *
   * The SAME precondition as `claimForUser` — `assignedTo` is null or is me —
   * which is what makes the pair symmetric rather than two rules that drift.
   * Releasing an already-unassigned conversation succeeds as a no-op;
   * releasing one another agent holds does not apply, because taking a
   * conversation from a colleague is not a thing this slice permits.
   */
  async releaseForUser(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    userId: ObjectIdLike,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOneAndUpdate(
      { _id: conversationId, organizationId, $or: [{ assignedTo: null }, { assignedTo: userId }] },
      { $set: { assignedTo: null } },
      { returnDocument: "after" },
    );
  },

  /**
   * Opens or closes a conversation (ADR-026 §7).
   *
   * Tenant-scoped and otherwise unconditional: both transitions are
   * idempotent, so there is no "only if currently open" precondition to
   * express — the caller's intent is already satisfied when the value
   * matches.
   *
   * MAY THROW a duplicate-key error, and that is by design rather than an
   * oversight this method should absorb: reopening collides with ADR-022 §3's
   * partial unique index whenever the customer has since opened a newer
   * conversation. The service catches `11000` and translates it, exactly as
   * `conversationService.resolveOpen` already does for its own race — here
   * because the refusal is correct and the alternative would be closing a
   * thread the customer is actively using.
   */
  async setStatus(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    status: ConversationStatus,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOneAndUpdate(
      { _id: conversationId, organizationId },
      { $set: { status } },
      { returnDocument: "after" },
    );
  },
};
