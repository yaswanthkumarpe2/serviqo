import { ConversationNotAccessibleError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { conversationRepository } from "./conversation.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationDocument } from "./conversation.model";
import type { ConversationListCursor } from "./conversation.repository";

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
    options: { cursor?: ConversationListCursor; limit: number },
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
      { cursor, limit }: { cursor?: ConversationListCursor; limit: number },
      log: AuthLogger = logger,
    ): Promise<ConversationListPage> {
      const rows = await conversationRepository.listByOrganization(organizationId, { cursor, limit });

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
  };
}
