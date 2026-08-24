import { ValidationError } from "../../lib/errors";
import { created, success } from "../../lib/response";
import { customerRepository } from "../customers/customer.repository";
import { toMessageResponse } from "../widget/widgetResponses";
import { toInboxConversationResponse } from "./agentInbox.responses";
import {
  OBJECT_ID_PATTERN,
  decodeConversationCursor,
  listAgentMessagesQuerySchema,
  listConversationsQuerySchema,
} from "./agentInbox.validation";

import type { ConversationService } from "../conversations/conversation.service";
import type { MessageService } from "../messages/message.service";
import type { SendAgentMessageInput } from "./agentInbox.validation";
import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export interface AgentInboxControllerDependencies {
  conversationService: ConversationService;
  messageService: MessageService;
}

/**
 * Translates request → service → response for the agent inbox (ADR-025 §3),
 * and nothing else — the contract every controller in this codebase follows.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error into
 * a response.
 *
 * Note what these handlers never read: `req.body.organizationId`,
 * `req.query.organizationId`, `req.body.customerId`, `req.body.senderType`.
 * The tenant comes from `req.organizationContext`, which `requireOrganization`
 * built from the path segment after proving membership (ADR-017 §1, §5); the
 * customer comes from a conversation document; `senderType` is a literal
 * inside the service (ADR-025 §6). None of the three has a client-reachable
 * source.
 */
export function createAgentInboxController({
  conversationService,
  messageService,
}: AgentInboxControllerDependencies) {
  /**
   * Guards `:conversationId` before any service or repository call touches
   * it — the identical helper `widget.controller.ts` applies, for the
   * identical reason: a malformed value reaching `Mongoose.findOne` raises a
   * `CastError`, which `errorHandler` turns into a generic 500, reporting a
   * client's mistyped URL as a server fault.
   *
   * Answering `400` specifically here is safe: it depends only on the
   * submitted string's shape, never on whether any conversation exists, so it
   * is not an existence oracle (ADR-025 §10).
   */
  function requireWellFormedConversationId(value: string | string[] | undefined): string {
    if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
      throw new ValidationError("Request validation failed", [
        { field: "conversationId", message: "conversationId is not a valid id" },
      ]);
    }
    return value;
  }

  /**
   * Parses a query string against a schema, raising the same
   * `400 VALIDATION_ERROR` shape `middleware/validate.ts` produces for a
   * body.
   *
   * Query parsing happens here rather than in a `validateQuery` middleware
   * because Express 5 exposes `req.query` through a getter with no setter, so
   * such a middleware would have nowhere to write its result — the limitation
   * `widget.controller.ts` already documents and works around identically.
   */
  function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
    const parsed = schema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError(
        "Request validation failed",
        parsed.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.map(String).join(".") : "query",
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }

  /**
   * Lists the tenant's conversations, most recently active first
   * (ADR-025 §5).
   *
   * `req.organizationContext` is safe to assert: `requireOrganization` set it
   * or this handler was never reached, and `requirePermission` refused after
   * that unless the caller's role holds `conversation.read`.
   *
   * Customers are fetched in ONE batched, tenant-scoped query rather than one
   * per row (ADR-025 §7) — and scoped by the same `organizationId`, so a
   * conversation whose `customerId` somehow pointed outside the tenant would
   * render with a null customer rather than reaching across the boundary.
   */
  const listConversations: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;

    const { cursor, limit } = parseQuery(listConversationsQuerySchema, req.query);

    const page = await conversationService.listForOrganization(
      organizationId,
      { cursor: decodeConversationCursor(cursor), limit },
      req.log,
    );

    const customers = await customerRepository.findByIdsAndOrganization(
      page.conversations.map((conversation) => conversation.customerId),
      organizationId,
    );

    success(res, {
      conversations: page.conversations.map((conversation) =>
        toInboxConversationResponse(conversation, customers.get(conversation.customerId.toString()) ?? null),
      ),
      nextCursor: page.nextCursor,
    });
  };

  /**
   * Reads one conversation the caller's tenant owns (ADR-025 §5).
   *
   * A conversation that does not exist and one belonging to another
   * organization produce byte-identical 404s (ADR-025 §10) — not because this
   * handler compares them, but because the repository lookup takes both keys
   * and neither matches.
   */
  const readConversation: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);

    const conversation = await conversationService.readForOrganization(organizationId, conversationId, req.log);

    const customer = await customerRepository.findByIdAndOrganization(conversation.customerId, organizationId);

    success(res, toInboxConversationResponse(conversation, customer));
  };

  /** Reads a page of a conversation's history for staff (ADR-025 §5). */
  const listMessages: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);

    const { cursor, limit } = parseQuery(listAgentMessagesQuerySchema, req.query);

    const page = await messageService.listForOrganization(
      organizationId,
      conversationId,
      { cursor, limit },
      req.log,
    );

    success(res, { messages: page.messages.map(toMessageResponse), nextCursor: page.nextCursor });
  };

  /**
   * Sends a reply as the organization (ADR-025 §6).
   *
   * `req.body` is safe to assert: `validateBody(sendAgentMessageSchema)`
   * replaced it with exactly `{ body }`. No `senderType`, no `customerId`, no
   * `conversationId`, and no `organizationId` could have survived that schema
   * even if a client sent them — they are stripped, not rejected, so a forged
   * value never becomes observable to this handler at all.
   *
   * 201, matching `POST /widget/conversations/:id/messages`: a message is
   * created, and `created()` is the envelope helper that exists for that.
   */
  const sendMessage: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { body } = req.body as SendAgentMessageInput;

    const message = await messageService.createFromAgent(organizationId, conversationId, body, req.log);

    created(res, toMessageResponse(message));
  };

  return { listConversations, readConversation, listMessages, sendMessage };
}
