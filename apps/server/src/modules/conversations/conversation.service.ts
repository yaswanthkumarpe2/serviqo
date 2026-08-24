import { logger } from "../../lib/logger";
import { conversationRepository } from "./conversation.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationDocument } from "./conversation.model";

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
  };
}
