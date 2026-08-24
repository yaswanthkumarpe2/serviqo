import { conversationRepository } from "../conversations/conversation.repository";
import { ConversationNotAccessibleError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { messageRepository } from "./message.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { MessageDocument } from "./message.model";

/**
 * Message business rules (ADR-022 §7): prove the conversation belongs to
 * the caller before touching it, persist, and best-effort record that the
 * conversation was just active.
 */

const CONVERSATION_NOT_ACCESSIBLE_MESSAGE = "Conversation not found";

export interface MessageListPage {
  messages: MessageDocument[];
  /** The last message's `_id` when a further page exists, `null` otherwise (ADR-022 §11). */
  nextCursor: string | null;
}

export interface MessageService {
  create(
    organizationId: string,
    customerId: string,
    conversationId: string,
    body: string,
    log?: AuthLogger,
  ): Promise<MessageDocument>;

  list(
    organizationId: string,
    customerId: string,
    conversationId: string,
    options: { cursor?: string; limit: number },
    log?: AuthLogger,
  ): Promise<MessageListPage>;
}

/**
 * Proves a conversation is the caller's own, or raises the one opaque
 * refusal every unreachable conversation produces (ADR-022 §8) — this is
 * the SAME query and the SAME error regardless of whether the conversation
 * does not exist, belongs to another organization, or belongs to another
 * customer.
 */
async function requireOwnConversation(organizationId: string, customerId: string, conversationId: string) {
  const conversation = await conversationRepository.findByIdForCustomer(conversationId, organizationId, customerId);
  if (conversation === null) {
    throw new ConversationNotAccessibleError(CONVERSATION_NOT_ACCESSIBLE_MESSAGE);
  }
  return conversation;
}

export function createMessageService(): MessageService {
  return {
    async create(
      organizationId: string,
      customerId: string,
      conversationId: string,
      body: string,
      log: AuthLogger = logger,
    ): Promise<MessageDocument> {
      await requireOwnConversation(organizationId, customerId, conversationId);

      const message = await messageRepository.create({
        organizationId,
        conversationId,
        customerId,
        // Assigned as a literal — never a parameter that traces back to
        // request input (ADR-022 §5). This is the one line in the entire
        // slice that decides a message is from a customer, and it cannot be
        // reached with any other value.
        senderType: "customer",
        body,
      });

      /*
        Best-effort (ADR-022 §10): the message the caller asked to send is
        already durably persisted above. A failure here is logged and
        swallowed — nothing reads lastMessageAt yet, so a stale value is
        invisible, and failing the whole request over a field nothing
        consumes would be a worse outcome than the one it is guarding
        against.
      */
      try {
        await conversationRepository.touchLastMessageAt(conversationId, organizationId, message.createdAt);
      } catch (err) {
        log.error(
          {
            event: "conversation.last_message_at.update_failed",
            organizationId,
            conversationId,
            messageId: message._id.toString(),
            err: err instanceof Error ? err.name : "UnknownError",
          },
          "Message persisted but the conversation's lastMessageAt could not be updated",
        );
      }

      log.info(
        { event: "message.created", organizationId, customerId, conversationId, messageId: message._id.toString() },
        "Message created",
      );

      return message;
    },

    async list(
      organizationId: string,
      customerId: string,
      conversationId: string,
      { cursor, limit }: { cursor?: string; limit: number },
      log: AuthLogger = logger,
    ): Promise<MessageListPage> {
      await requireOwnConversation(organizationId, customerId, conversationId);

      const rows = await messageRepository.list(organizationId, conversationId, { cursor, limit });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1]!._id.toString() : null;

      log.info(
        { event: "message.listed", organizationId, customerId, conversationId, count: page.length },
        "Message history read",
      );

      return { messages: page, nextCursor };
    },
  };
}
