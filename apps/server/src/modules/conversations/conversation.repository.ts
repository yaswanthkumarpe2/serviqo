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
   * One customer's own conversations, newest activity first (ADR-034 §5).
   *
   * Scoped by BOTH ids in the query, like every other read here. That is what
   * makes it impossible for this method to return a conversation belonging to
   * somebody else even if a caller passed an id it had no business holding —
   * the isolation is produced by the filter rather than checked afterwards.
   *
   * No cursor and no filter options, unlike `listByOrganization`. A customer
   * has at most one OPEN conversation per tenant — the unique partial index on
   * this collection guarantees it — so their list is a short history, and
   * paging a screen that fits on a screen would be inventing a contract with
   * no reader.
   */
  async listByCustomer(
    organizationId: ObjectIdLike,
    customerId: ObjectIdLike,
    limit: number,
  ): Promise<ConversationDocument[]> {
    return ConversationModel.find({ organizationId, customerId }).sort({ lastMessageAt: -1, _id: -1 }).limit(limit);
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
    senderType?: "customer" | "agent",
  ): Promise<ConversationDocument | null> {
    /*
      A message is unread by the OTHER side, and the sender has evidently read
      everything before writing (ADR-040 §4): replying marks the thread read for
      the replier and adds one to the counter the recipient sees.
    */
    const update =
      senderType === "customer"
        ? { $set: { lastMessageAt: when, unreadByCustomer: 0, customerLastReadAt: when }, $inc: { unreadByAgents: 1 } }
        : senderType === "agent"
          ? { $set: { lastMessageAt: when, unreadByAgents: 0, agentLastReadAt: when }, $inc: { unreadByCustomer: 1 } }
          : { $set: { lastMessageAt: when } };

    return ConversationModel.findOneAndUpdate({ _id: conversationId, organizationId }, update, { returnDocument: "after" });
  },

  /** The team read this conversation (ADR-040 §4). Scoped by organisation like every write here. */
  async markReadByAgents(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    when: Date,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOneAndUpdate(
      { _id: conversationId, organizationId },
      { $set: { unreadByAgents: 0, agentLastReadAt: when } },
      { returnDocument: "after" },
    );
  },

  /** The customer read their own conversation (ADR-040 §4). Scoped by organisation AND customer. */
  async markReadByCustomer(
    conversationId: ObjectIdLike,
    organizationId: ObjectIdLike,
    customerId: ObjectIdLike,
    when: Date,
  ): Promise<ConversationDocument | null> {
    return ConversationModel.findOneAndUpdate(
      { _id: conversationId, organizationId, customerId },
      { $set: { unreadByCustomer: 0, customerLastReadAt: when } },
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
   * Clears `assignedTo` on every conversation in ONE tenant assigned to
   * `userId`, and returns the documents it changed (ADR-027 §10).
   *
   * This is the sweep ADR-026 §15 said did not exist:
   *
   *   > A conversation assigned to someone whose membership was revoked stays
   *   > assigned to them … Nothing sweeps `assignedTo` when a membership ends,
   *   > because membership removal has no endpoint yet.
   *
   * Unconditional on the caller, unlike `releaseForUser` above, and that
   * difference is the point. `releaseForUser`'s filter is "`assignedTo` is
   * null or is me", which is what makes taking a conversation from a colleague
   * impossible (ADR-026 §4) — and which is also why a departed member's queue
   * was unreleasable by anyone. This method is not reachable from a
   * conversation route at all; its only caller is the membership service,
   * whose authorization is `member.manage` over the person being released
   * rather than `conversation.assign` over the conversation.
   *
   * Scoped by `organizationId` like every other method here (ADR-022 §1), so a
   * `User` who works in two tenants keeps their assignments in the tenant they
   * were not removed from.
   *
   * Three queries rather than one, and deliberately: `updateMany` reports a
   * count and returns no documents, but the caller must publish one
   * `conversation.updated` event PER conversation (ADR-026 §9) and cannot
   * build a payload from a number. Reading the ids first also makes the
   * re-read exact rather than a guess about what the update touched. All three
   * are indexed and the row count is one person's open work, not a tenant's
   * history.
   */
  async releaseAllForUser(
    organizationId: ObjectIdLike,
    userId: ObjectIdLike,
  ): Promise<ConversationDocument[]> {
    const assigned = await ConversationModel.find({ organizationId, assignedTo: userId }).select("_id");
    if (assigned.length === 0) return [];

    const ids = assigned.map((conversation) => conversation._id);

    await ConversationModel.updateMany(
      { _id: { $in: ids }, organizationId, assignedTo: userId },
      { $set: { assignedTo: null } },
    );

    /*
      Re-read by the ids just written, still tenant-scoped — the caller needs
      whole documents to project into events, and re-reading is what makes the
      payload reflect what is actually stored rather than what was intended.
    */
    return ConversationModel.find({ _id: { $in: ids }, organizationId });
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
