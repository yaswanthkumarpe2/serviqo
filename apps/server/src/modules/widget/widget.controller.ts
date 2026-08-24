import { ValidationError } from "../../lib/errors";
import { created, success } from "../../lib/response";
import { OBJECT_ID_PATTERN, listMessagesQuerySchema } from "./widgetConversation.validation";

import type { ConversationDocument } from "../conversations/conversation.model";
import type { ConversationService } from "../conversations/conversation.service";
import type { MessageDocument } from "../messages/message.model";
import type { MessageService } from "../messages/message.service";
import type { CreateMessageInput } from "./widgetConversation.validation";
import type { CreateWidgetSessionInput } from "./widget.validation";
import type { WidgetSessionService } from "./widgetSession.service";
import type { RequestHandler } from "express";

export interface WidgetControllerDependencies {
  sessionService: WidgetSessionService;
  conversationService: ConversationService;
  messageService: MessageService;
}

/**
 * Projects a `Conversation` to what the widget needs (ADR-022 §13). No
 * `organizationId`, no `customerId` — the caller already knows both, they
 * hold the token, and echoing an identifier back to the party that supplied
 * it discloses nothing (the same minimalism `toSessionCustomer` in
 * `widgetSession.service.ts` established).
 */
function toConversationResponse(conversation: ConversationDocument) {
  return {
    id: conversation._id.toString(),
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
  };
}

/** Projects a `Message` to exactly the fields ADR-022 §13 names. */
function toMessageResponse(message: MessageDocument) {
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderType: message.senderType,
    body: message.body,
    createdAt: message.createdAt,
  };
}

/**
 * Guards `:conversationId` before any service or repository call touches
 * it. A malformed value is a `400 VALIDATION_ERROR` — the same status
 * `middleware/validate.ts` produces for a malformed body — and is safe to
 * answer specifically: it depends only on the submitted string's shape,
 * never on whether any conversation exists (mirroring `widget.validation.ts`
 * §12's identical reasoning for `widgetKey`).
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
 * Translates request → service → response, and nothing else — the contract
 * `auth.controller.ts` and `organization.controller.ts` both follow.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error into
 * a response.
 */
export function createWidgetController({
  sessionService,
  conversationService,
  messageService,
}: WidgetControllerDependencies) {
  /**
   * Opens a widget session for an anonymous website visitor (ADR-019 §6).
   *
   * Serviqo's first PUBLIC write endpoint. There is no `req.principal` to
   * read and no `req.organizationContext` — by design, since a customer never
   * authenticates (ADR-010 §1) — so this handler reads exactly two things:
   * the validated body, and the `Origin` header.
   *
   * `req.body` is safe to assert: `validateBody` replaced it with the
   * schema's output before this could run, which also means an
   * `organizationId`, `customerId`, `userId`, or `role` a client tried to
   * send was STRIPPED rather than rejected, and cannot reach the service at
   * all (ADR-019 §12).
   *
   * The `Origin` header is passed as data, never as an identity. The service
   * compares it against a list belonging to a tenant the widget key already
   * resolved; nothing looks anything up by it.
   *
   * 201 rather than 200: a session — and usually a `Customer` — is created,
   * and `created()` is the envelope helper that exists for exactly that.
   */
  const createSession: RequestHandler = async (req, res) => {
    const result = await sessionService.createSession(
      req.body as CreateWidgetSessionInput,
      { origin: req.get("origin") },
      req.log,
    );

    created(res, result);
  };

  /**
   * Resolves or creates the caller's open conversation (ADR-022 §7).
   *
   * `req.widgetPrincipal` is safe to assert: `requireWidgetToken` set it or
   * this handler was never reached (ADR-022 §6). Always `201`, resumed or
   * newly created alike — the identical precedent `POST /widget/session`
   * itself set for the same reason (ADR-022 §13).
   */
  const resolveConversation: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.widgetPrincipal!;

    const conversation = await conversationService.resolveOpen(organizationId, customerId, req.log);

    created(res, toConversationResponse(conversation));
  };

  /**
   * Sends a customer message into the caller's own conversation
   * (ADR-022 §5, §7).
   *
   * `req.body` is safe to assert: `validateBody(createMessageSchema)`
   * replaced it with exactly `{ body }` — no `senderType`, no
   * `conversationId`, no `customerId` could have survived that schema even
   * if a client sent them. `senderType` is assigned inside
   * `messageService.create` as a literal, never read from here.
   */
  const createMessage: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.widgetPrincipal!;
    const conversationId = requireWellFormedConversationId(req.params.conversationId);
    const { body } = req.body as CreateMessageInput;

    const message = await messageService.create(organizationId, customerId, conversationId, body, req.log);

    created(res, toMessageResponse(message));
  };

  /**
   * Reads a page of the caller's own conversation history (ADR-022 §11).
   *
   * `req.query` is parsed here rather than through a `validateBody`-style
   * middleware — Express 5 exposes `req.query` as a getter with no setter,
   * so nowhere exists to write a parsed replacement (`widget.validation.ts`'s
   * own noted limitation). A parse failure is the identical
   * `400 VALIDATION_ERROR` shape `validateBody` produces, so a malformed
   * `cursor` or an out-of-range `limit` is indistinguishable, from the
   * client's side, from a malformed body on any other route.
   */
  const listMessages: RequestHandler = async (req, res) => {
    const { organizationId, customerId } = req.widgetPrincipal!;
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

  return { createSession, resolveConversation, createMessage, listMessages };
}
