import { ValidationError } from "../../lib/errors";
import { created, success } from "../../lib/response";
import { conversationRepository } from "../conversations/conversation.repository";
import { OBJECT_ID_PATTERN, listMessagesQuerySchema } from "../widget/widgetConversation.validation";
import { toConversationResponse, toMessageResponse } from "../widget/widgetResponses";

import type { ConversationService } from "../conversations/conversation.service";
import type { MessageService } from "../messages/message.service";
import type { CreateMessageInput } from "../widget/widgetConversation.validation";
import type { RequestHandler } from "express";

export interface CustomerPortalControllerDependencies {
  conversationService: ConversationService;
  messageService: MessageService;
}

/**
 * The signed-in customer's own chat (ADR-034 §5).
 *
 * Every handler here is the authenticated twin of one in
 * `widget.controller.ts`, and they call the SAME services with the same
 * arguments. That is the point: a conversation is a conversation whether the
 * person reached it through a widget on a website or through a login, and
 * forking the services would give two code paths one chance each to get tenant
 * isolation wrong.
 *
 * The only difference is where `(organizationId, customerId)` comes from —
 * `req.customerContext`, established by `requireCustomerAccount`, rather than
 * `req.widgetPrincipal` from a widget token.
 *
 * The response shapes are reused too, for the sharper reason that a customer
 * must be told exactly as much on one path as on the other. A richer payload
 * here would be a disclosure that exists only because the reader happened to
 * sign in.
 */

/**
 * Guards `:conversationId` before any service or repository call touches it.
 *
 * Lifted verbatim from the widget controller's identical guard, including its
 * reasoning: a malformed value is a `400 VALIDATION_ERROR` and is safe to
 * answer specifically, because it depends only on the submitted string's shape
 * and never on whether any conversation exists.
 */
function requireWellFormedConversationId(value: unknown): string {
  /*
    `unknown`, not `string | undefined`. Express types a route parameter as
    `string | string[]` because a path can repeat a name, so narrowing here
    rather than at the call site is what keeps an array from reaching the
    pattern test as a coerced string.
  */
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new ValidationError("Request validation failed", [
      { field: "conversationId", message: "Must be a 24-character hexadecimal id" },
    ]);
  }
  return value;
}

/** How many of a customer's own conversations one response carries (ADR-034 §5). */
const CONVERSATION_LIMIT = 20;

export function createCustomerPortalController({
  conversationService,
  messageService,
}: CustomerPortalControllerDependencies) {
  /**
   * The caller's own conversations, newest activity first.
   *
   * Scoped by both ids in the query, so this cannot return somebody else's
   * conversation even if the repository were called with a stray id — the
   * isolation is produced by the filter rather than checked afterwards.
   */
  const listConversations: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.customerContext!;

    const conversations = await conversationRepository.listByCustomer(organizationId, customerId, CONVERSATION_LIMIT);

    success(res, { conversations: conversations.map(toConversationResponse) });
  };

  /**
   * Opens the caller's live chat, or hands back the one already open.
   *
   * `resolveOpen` is idempotent by construction — a customer has at most one
   * open conversation per tenant, enforced by a unique partial index — so
   * pressing "start a chat" twice continues one conversation rather than
   * starting a second.
   */
  const startConversation: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.customerContext!;

    const conversation = await conversationService.resolveOpen(organizationId, customerId, req.log);

    created(res, toConversationResponse(conversation));
  };

  /**
   * Sends a message as the customer.
   *
   * `req.body` is safe to assert: `validateBody(createMessageSchema)` replaced
   * it with exactly `{ body }`. `senderType` is a literal inside
   * `messageService.create` and is never read from here, so no request can
   * make a customer's message claim to be an agent's.
   */
  const sendMessage: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.customerContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { body } = req.body as CreateMessageInput;

    const message = await messageService.create(organizationId, customerId, conversationId, body, req.log);

    created(res, toMessageResponse(message));
  };

  /**
   * Reads a page of the caller's own history.
   *
   * `req.query` is parsed here rather than through a `validateBody`-style
   * middleware, for the reason the widget controller records: Express 5
   * exposes `req.query` as a getter with no setter, so there is nowhere to
   * write a parsed replacement.
   */
  const listMessages: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.customerContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);

    const parsed = listMessagesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError(
        "Request validation failed",
        parsed.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.map(String).join(".") : "query",
          message: issue.message,
        })),
      );
    }

    const page = await messageService.list(organizationId, customerId, conversationId, parsed.data, req.log);

    success(res, { messages: page.messages.map(toMessageResponse), nextCursor: page.nextCursor });
  };

  return { listConversations, startConversation, sendMessage, listMessages };
}
