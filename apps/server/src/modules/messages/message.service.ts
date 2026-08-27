import { conversationRepository } from "../conversations/conversation.repository";
import { ConversationClosedError, ConversationNotAccessibleError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { messageEvents, toMessageCreatedEvent } from "./messageEvents";
import { messageRepository } from "./message.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationDocument } from "../conversations/conversation.model";
import type { MessageDocument } from "./message.model";

/**
 * Message business rules (ADR-022 §7): prove the conversation belongs to
 * the caller before touching it, persist, and best-effort record that the
 * conversation was just active.
 */

const CONVERSATION_NOT_ACCESSIBLE_MESSAGE = "Conversation not found";

/** The same words for both senders, because "closed" means one thing (ADR-026 §6). */
const CONVERSATION_CLOSED_MESSAGE = "This conversation has been closed";

/**
 * Refuses a send into a closed conversation (ADR-026 §6).
 *
 * ONE function, called from both create paths, which is what makes the rule
 * symmetric by construction rather than by two branches agreeing. An
 * agent-only or customer-only rule would mean "closed" meant something
 * different depending on who asked, and the first bug report would be an
 * agent replying into a thread the customer can no longer answer in.
 *
 * Runs AFTER the ownership proof in both callers, deliberately: a caller who
 * may not reach this conversation must get the opaque 404 rather than learn
 * from a 409 that the id names a real, closed conversation (ADR-022 §8).
 */
function requireOpenConversation(conversation: ConversationDocument): void {
  if (conversation.status === "closed") {
    throw new ConversationClosedError(CONVERSATION_CLOSED_MESSAGE);
  }
}

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

  /**
   * Sends an AGENT message into a conversation belonging to the caller's own
   * organization (ADR-025 §6).
   *
   * Takes no `customerId` and no `senderType`. The first is copied from the
   * conversation document this method loads; the second is a literal in the
   * body below. Neither is a parameter, so neither can trace back to request
   * input.
   *
   * Authorization is the CALLER's to have proved — this method proves tenancy
   * (the conversation is under this `organizationId`) and nothing about the
   * caller's role. `requirePermission("conversation.reply")` is what gates
   * reaching it at all.
   */
  createFromAgent(
    organizationId: string,
    conversationId: string,
    body: string,
    log?: AuthLogger,
  ): Promise<MessageDocument>;

  /**
   * Reads a page of one conversation's history for STAFF (ADR-025 §5).
   *
   * The organization-scoped sibling of `list`. Same pagination contract, same
   * opaque refusal; the only difference is which repository lookup proves
   * reachability, and therefore which conversations are reachable at all.
   */
  listForOrganization(
    organizationId: string,
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

/**
 * Proves a conversation belongs to the caller's own tenant, or raises the
 * SAME opaque refusal `requireOwnConversation` raises (ADR-025 §10).
 *
 * A conversation that does not exist and one that exists inside another
 * organization are indistinguishable here — not because a branch compares
 * them carefully, but because `findByIdForOrganization` takes both keys in
 * one query and neither matches (ADR-022 §1). There is no branch to drift.
 */
async function requireTenantConversation(
  organizationId: string,
  conversationId: string,
): Promise<ConversationDocument> {
  const conversation = await conversationRepository.findByIdForOrganization(conversationId, organizationId);
  if (conversation === null) {
    throw new ConversationNotAccessibleError(CONVERSATION_NOT_ACCESSIBLE_MESSAGE);
  }
  return conversation;
}

/**
 * Records that a message just landed on its conversation, then announces it.
 *
 * Both steps are best-effort by construction and neither may fail the send:
 * the message is durably persisted before this runs (ADR-022 §10 for the
 * touch, ADR-025 §2 for the publish). Shared by both create paths so a
 * customer-sent and an agent-sent message produce the identical follow-up,
 * rather than two copies that drift.
 */
async function recordAndAnnounce(
  organizationId: string,
  conversationId: string,
  message: MessageDocument,
  log: AuthLogger,
): Promise<void> {
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

  /*
    The domain event seam (ADR-025 §2). This service knows nothing about
    Socket.IO, rooms, or who is connected — it states that a message exists,
    and `realtime/createSocketServer.ts` decides who hears about it.

    `publish` swallows subscriber errors itself, so there is no try/catch
    here: adding one would suggest this call can fail, which it cannot.
  */
  messageEvents.publish(toMessageCreatedEvent(organizationId, message));
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
      const conversation = await requireOwnConversation(organizationId, customerId, conversationId);

      // ADR-026 §6. The widget recovers from this refusal by resolving a new
      // conversation (§8), so a visitor whose thread was closed mid-session
      // still gets their message delivered.
      requireOpenConversation(conversation);

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
        already durably persisted above. A failure to touch `lastMessageAt`
        is logged and swallowed, and the broadcast that follows cannot fail
        the write either (ADR-025 §2).

        `lastMessageAt` is no longer a field nothing consumes — the agent
        inbox's list query sorts on it (ADR-025 §5) — so a failed touch is
        now visible as a conversation sorting stale. That is still a better
        outcome than failing a send whose message is already stored.
      */
      await recordAndAnnounce(organizationId, conversationId, message, log);

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

    async createFromAgent(
      organizationId: string,
      conversationId: string,
      body: string,
      log: AuthLogger = logger,
    ): Promise<MessageDocument> {
      const conversation = await requireTenantConversation(organizationId, conversationId);

      // The identical check the customer path applies, from the identical
      // function (ADR-026 §6): an agent who wants to speak in a closed
      // conversation reopens it first, which is an explicit act visible to
      // every other agent in the tenant.
      requireOpenConversation(conversation);

      const message = await messageRepository.create({
        organizationId,
        conversationId,
        /*
          Copied from the conversation the server just loaded under the
          caller's own organizationId — never read from the request in any
          form (ADR-025 §6).

          `Message.customerId` means "which customer this conversation is
          with" (ADR-022 §4), not "who sent this", so a client-supplied value
          here would mis-file an agent's reply into another customer's
          history. It has exactly one source, and that source is a document.
        */
        customerId: conversation.customerId,
        /*
          Assigned as a literal, exactly as `create` above assigns
          "customer" (ADR-022 §5, restated by ADR-025 §6). This is the ONE
          line in the codebase that decides a message is from an agent.

          There is deliberately no shared helper taking `senderType` as an
          argument: two functions, two literals, so the value is reachable
          only by calling the method mounted behind
          requirePermission("conversation.reply").
        */
        senderType: "agent",
        body,
      });

      await recordAndAnnounce(organizationId, conversationId, message, log);

      /*
        No `customerId` in this log line, and no body. The customer is
        derivable from the conversation for anyone with database access and
        does not belong in an agent-action audit line; the body is customer-
        and agent-authored content (ADR-022 §14).
      */
      log.info(
        { event: "message.created", organizationId, conversationId, messageId: message._id.toString(), senderType: "agent" },
        "Agent message created",
      );

      return message;
    },

    async listForOrganization(
      organizationId: string,
      conversationId: string,
      { cursor, limit }: { cursor?: string; limit: number },
      log: AuthLogger = logger,
    ): Promise<MessageListPage> {
      await requireTenantConversation(organizationId, conversationId);

      // The identical repository read the customer-facing `list` performs —
      // it is already scoped by organization and conversation and needs no
      // customer key, so there is nothing agent-specific to add (ADR-022 §4).
      const rows = await messageRepository.list(organizationId, conversationId, { cursor, limit });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1]!._id.toString() : null;

      log.info(
        { event: "message.listed", organizationId, conversationId, count: page.length },
        "Message history read by staff",
      );

      return { messages: page, nextCursor };
    },
  };
}
