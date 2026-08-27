import {
  ConversationAlreadyAssignedError,
  ConversationNotAccessibleError,
  ConversationReopenConflictError,
} from "../../lib/errors";
import { logger } from "../../lib/logger";
import { conversationEvents, toConversationUpdatedEvent } from "./conversationEvents";
import { conversationRepository } from "./conversation.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationDocument, ConversationStatus } from "./conversation.model";
import type { ConversationListCursor, ConversationListFilter } from "./conversation.repository";

/**
 * Resolving a customer's open conversation (ADR-022 §7).
 *
 * `AuthLogger` is imported from the auth module rather than duplicated,
 * following `widgetSession.service.ts`'s own precedent for the identical
 * reason it states: the type is now a fourth domain's consumer, and moving
 * it to `lib/` remains a deliberate, separate decision this slice has no
 * other reason to make (ADR-016 §9, restated by ADR-019).
 */

/** MongoDB's duplicate-key error code — the §3 unique index rejecting a write. */
const DUPLICATE_KEY_ERROR = 11000;

/** The one refusal every unreachable conversation produces (ADR-022 §8, ADR-025 §10). */
const CONVERSATION_NOT_ACCESSIBLE_MESSAGE = "Conversation not found";

/** Named no agent, deliberately — who holds it depends on the reader's roster entitlement (ADR-026 §4, §11). */
const CONVERSATION_ALREADY_ASSIGNED_MESSAGE = "Another agent is handling this conversation";

/** The one message in this slice that says what to do next, because "conflict" does not (ADR-026 §7). */
const CONVERSATION_REOPEN_CONFLICT_MESSAGE = "This customer already has an open conversation";

/** One page of an organization's conversations, with ADR-022 §11's cursor contract. */
export interface ConversationListPage {
  conversations: ConversationDocument[];
  /**
   * The composite cursor to resume from when a further page exists, `null`
   * otherwise. Opaque to the client: it is a `<lastMessageAt>_<id>` pair
   * (ADR-025 §5), and the client's only correct use of it is to hand it back.
   */
  nextCursor: string | null;
}

/**
 * Encodes the composite keyset cursor (ADR-025 §5).
 *
 * ISO-8601 for the date rather than epoch milliseconds, so a cursor is
 * self-describing in a log or a bug report, and `_` as the separator because
 * neither an ISO timestamp nor a 24-char hex ObjectId can contain one — which
 * is what makes `indexOf` a safe split.
 */
function encodeConversationCursor(conversation: ConversationDocument): string {
  return `${conversation.lastMessageAt.toISOString()}_${conversation._id.toString()}`;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR;
}

export interface ConversationService {
  /**
   * Returns the customer's open conversation, creating one if none exists.
   *
   * Never fails on the race two concurrent requests from the same customer
   * can create (ADR-022 §3, §7): the loser of that race re-reads rather than
   * propagating the unique-index violation, because both callers want the
   * identical answer — "my open conversation" — regardless of which physical
   * write won.
   */
  resolveOpen(organizationId: string, customerId: string, log?: AuthLogger): Promise<ConversationDocument>;

  /**
   * One tenant's conversations, most recently active first, one page at a
   * time (ADR-025 §5) — the agent inbox's central read.
   *
   * Takes no customer: an agent is entitled to every conversation in their
   * own organization. What they are NOT entitled to is anything outside it,
   * and that is enforced by the repository method taking `organizationId` as
   * a mandatory key rather than by anything this service compares.
   */
  listForOrganization(
    organizationId: string,
    options: { cursor?: ConversationListCursor; limit: number; filter?: ConversationListFilter },
    log?: AuthLogger,
  ): Promise<ConversationListPage>;

  /**
   * One conversation, proved to belong to the caller's own tenant
   * (ADR-025 §5).
   *
   * Raises the same opaque refusal for "no such conversation" and "another
   * tenant's conversation" (ADR-025 §10).
   */
  readForOrganization(organizationId: string, conversationId: string, log?: AuthLogger): Promise<ConversationDocument>;

  /**
   * Claims a conversation for `userId` — the acting agent, resolved from the
   * verified access token by the caller and never from request input
   * (ADR-026 §2).
   *
   * Idempotent when the caller already holds it. Raises
   * `ConversationAlreadyAssignedError` when another agent does, and the same
   * opaque `ConversationNotAccessibleError` every unreachable conversation
   * produces otherwise.
   *
   * Authorization is the CALLER's to have proved — this method proves tenancy
   * and the assignment precondition, and nothing about the caller's role.
   * `requirePermission("conversation.assign")` is what gates reaching it.
   */
  claim(organizationId: string, conversationId: string, userId: string, log?: AuthLogger): Promise<ConversationDocument>;

  /**
   * Releases a conversation `userId` holds (ADR-026 §4).
   *
   * The exact mirror of `claim`, sharing its precondition — `assignedTo` is
   * null or is me — so releasing an already-unassigned conversation succeeds
   * and releasing a colleague's does not.
   */
  release(
    organizationId: string,
    conversationId: string,
    userId: string,
    log?: AuthLogger,
  ): Promise<ConversationDocument>;

  /**
   * Opens or closes a conversation (ADR-026 §7).
   *
   * Both transitions are idempotent. Reopening raises
   * `ConversationReopenConflictError` when the customer has since opened a
   * newer conversation — ADR-022 §3's partial unique index refusing the write,
   * translated rather than absorbed.
   */
  setStatus(
    organizationId: string,
    conversationId: string,
    status: ConversationStatus,
    log?: AuthLogger,
  ): Promise<ConversationDocument>;
}

/**
 * Announces a persisted state change (ADR-026 §9).
 *
 * Shared by claim, release, and both status transitions, so four operations
 * produce one identically-shaped event rather than four copies that drift.
 *
 * `publish` swallows subscriber errors itself, so there is no try/catch here:
 * adding one would suggest this call can fail, which it cannot.
 */
function announce(organizationId: string, conversation: ConversationDocument): void {
  conversationEvents.publish(toConversationUpdatedEvent(organizationId, conversation));
}

export function createConversationService(): ConversationService {
  return {
    async resolveOpen(
      organizationId: string,
      customerId: string,
      log: AuthLogger = logger,
    ): Promise<ConversationDocument> {
      const existing = await conversationRepository.findOpenByCustomer(organizationId, customerId);
      if (existing !== null) {
        log.info(
          { event: "conversation.opened", organizationId, customerId, conversationId: existing._id.toString(), resumed: true },
          "Conversation resolved",
        );
        return existing;
      }

      try {
        const created = await conversationRepository.create(organizationId, customerId);
        log.info(
          { event: "conversation.opened", organizationId, customerId, conversationId: created._id.toString(), resumed: false },
          "Conversation resolved",
        );
        return created;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        /*
          Lost the race: another request from the same customer created the
          open conversation between our read and our write. The database
          already has the answer both callers want.
        */
        const resolved = await conversationRepository.findOpenByCustomer(organizationId, customerId);
        if (resolved === null) {
          // The index guarantees a winner exists; a null read here would mean
          // it was deleted in the instant between the conflict and this
          // re-read, which is not a case this slice needs to paper over —
          // surfacing it as the generic failure it is is more honest than
          // inventing a conversation that is not there.
          throw err;
        }

        log.info(
          { event: "conversation.opened", organizationId, customerId, conversationId: resolved._id.toString(), resumed: true },
          "Conversation resolved after a concurrent create",
        );
        return resolved;
      }
    },

    async listForOrganization(
      organizationId: string,
      { cursor, limit, filter }: { cursor?: ConversationListCursor; limit: number; filter?: ConversationListFilter },
      log: AuthLogger = logger,
    ): Promise<ConversationListPage> {
      const rows = await conversationRepository.listByOrganization(organizationId, { cursor, limit, filter });

      // The `limit + 1` probe (ADR-022 §11's shape): the extra row, if it
      // came back, is the proof a further page exists and is trimmed here.
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeConversationCursor(page[page.length - 1]!) : null;

      log.info(
        { event: "conversation.listed", organizationId, count: page.length },
        "Conversation list read",
      );

      return { conversations: page, nextCursor };
    },

    async readForOrganization(
      organizationId: string,
      conversationId: string,
      log: AuthLogger = logger,
    ): Promise<ConversationDocument> {
      const conversation = await conversationRepository.findByIdForOrganization(conversationId, organizationId);
      if (conversation === null) {
        /*
          Not logged as a distinct "cross-tenant attempt" — the server cannot
          tell one from a typo, and pretending otherwise in a log invites a
          future reader to build a response branch on it (ADR-025 §10).
        */
        throw new ConversationNotAccessibleError(CONVERSATION_NOT_ACCESSIBLE_MESSAGE);
      }

      log.info(
        { event: "conversation.read", organizationId, conversationId },
        "Conversation read",
      );

      return conversation;
    },

    async claim(
      organizationId: string,
      conversationId: string,
      userId: string,
      log: AuthLogger = logger,
    ): Promise<ConversationDocument> {
      const claimed = await conversationRepository.claimForUser(conversationId, organizationId, userId);

      if (claimed !== null) {
        announce(organizationId, claimed);

        /*
          `userId` is safe in a log and is the one identity an operator needs
          to answer "who took this?". The assignee's NAME is not logged here
          or anywhere: a log line is read by operators who did not go through
          `can(role, "member.read")` (ADR-026 §11, §12).
        */
        log.info(
          { event: "conversation.claimed", organizationId, conversationId, userId },
          "Conversation claimed",
        );
        return claimed;
      }

      /*
        The conditional update did not apply, and its `null` is deliberately
        ambiguous (ADR-026 §4). One further tenant-scoped read — on this
        failure path only — is what separates the two causes, and it is the
        SAME query every other unreachable-conversation path uses, so the 404
        it produces is byte-identical to theirs.
      */
      throw await refusalForFailedAssignment(organizationId, conversationId);
    },

    async release(
      organizationId: string,
      conversationId: string,
      userId: string,
      log: AuthLogger = logger,
    ): Promise<ConversationDocument> {
      const released = await conversationRepository.releaseForUser(conversationId, organizationId, userId);

      if (released !== null) {
        announce(organizationId, released);

        log.info(
          { event: "conversation.released", organizationId, conversationId, userId },
          "Conversation released",
        );
        return released;
      }

      throw await refusalForFailedAssignment(organizationId, conversationId);
    },

    async setStatus(
      organizationId: string,
      conversationId: string,
      status: ConversationStatus,
      log: AuthLogger = logger,
    ): Promise<ConversationDocument> {
      let updated: ConversationDocument | null;

      try {
        updated = await conversationRepository.setStatus(conversationId, organizationId, status);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        /*
          ADR-022 §3's partial unique index refusing a REOPEN: the customer
          opened a newer conversation while this one was closed, and two open
          conversations for one customer is the invariant that index exists to
          make impossible (ADR-026 §7).

          Translated rather than absorbed. Closing the newer conversation to
          make room would destroy a thread the customer is actively using, and
          dropping the index would move an invariant the database enforces
          into application code that could get it wrong.
        */
        throw new ConversationReopenConflictError(CONVERSATION_REOPEN_CONFLICT_MESSAGE);
      }

      if (updated === null) {
        throw new ConversationNotAccessibleError(CONVERSATION_NOT_ACCESSIBLE_MESSAGE);
      }

      announce(organizationId, updated);

      log.info(
        { event: status === "closed" ? "conversation.closed" : "conversation.reopened", organizationId, conversationId },
        "Conversation status changed",
      );

      return updated;
    },
  };
}

/**
 * Turns a conditional assignment update's `null` into the refusal it actually
 * means (ADR-026 §4).
 *
 * Shared by claim and release so the two cannot disagree about which failure
 * is which. Returns the error rather than throwing it, so the call site reads
 * as `throw await …` and the control flow stays visible where the operation
 * is.
 *
 * The read is the same `findByIdForOrganization` every other path uses — two
 * keys in one query — so a conversation in another tenant is indistinguishable
 * from one that does not exist, and the 404 is produced by the query missing
 * rather than by a branch comparing tenants (ADR-025 §10, ADR-026 §12).
 */
async function refusalForFailedAssignment(organizationId: string, conversationId: string): Promise<Error> {
  const existing = await conversationRepository.findByIdForOrganization(conversationId, organizationId);

  if (existing === null) {
    return new ConversationNotAccessibleError(CONVERSATION_NOT_ACCESSIBLE_MESSAGE);
  }

  // It exists, in this tenant, and the update's precondition still failed —
  // which leaves exactly one cause: another agent holds it.
  return new ConversationAlreadyAssignedError(CONVERSATION_ALREADY_ASSIGNED_MESSAGE);
}
