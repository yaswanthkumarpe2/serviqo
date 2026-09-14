import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireCustomerAccount } from "../../middleware/requireCustomerAccount";
import { validateBody } from "../../middleware/validate";
import { createConversationService } from "../conversations/conversation.service";
import { createMessageService } from "../messages/message.service";
import { createMessageSchema } from "../widget/widgetConversation.validation";
import { createCustomerPortalController } from "./customerPortal.controller";

import type { RateLimiters } from "../../lib/rateLimit";

export interface CustomerPortalRouterDependencies {
  rateLimiters: RateLimiters;
}

/**
 * The signed-in customer's surface (ADR-034 §5).
 *
 * Mounted at `/api/v1/me`, which is the only prefix in the API that names
 * neither a tenant nor a resource. That is deliberate and is the whole
 * addressing model here: a customer names nothing, because there is exactly
 * one answer to every question they can ask — their organization, their
 * conversations, their messages — and every one of those is derived from the
 * token rather than from the URL.
 *
 * The contrast with `/api/v1/organizations/:organizationId/...` is the point.
 * Staff address a tenant because they may belong to several; a customer cannot
 * address one at all, so no request they make can reach across a boundary even
 * by accident (ADR-017 §1's guarantee, arrived at from the other direction).
 *
 * Every route carries `requireAccessToken` then `requireCustomerAccount`, in
 * that order, written out per route rather than hoisted — "who may reach this
 * route?" is answered by reading this file.
 *
 * The limiter classes are the WIDGET's, not the staff ones. These endpoints
 * carry the same traffic the widget carries — a person typing in a chat — and
 * giving the authenticated path its own budget would mean the same behaviour
 * was metered two different ways depending on which door it came through.
 */
export function createCustomerPortalRouter({ rateLimiters }: CustomerPortalRouterDependencies): Router {
  const controller = createCustomerPortalController({
    conversationService: createConversationService(),
    messageService: createMessageService(),
  });

  const router = Router();

  router.get(
    "/conversations",
    requireAccessToken,
    requireCustomerAccount,
    rateLimiters.widgetConversationRead,
    controller.listConversations,
  );

  router.post(
    "/conversations",
    requireAccessToken,
    requireCustomerAccount,
    rateLimiters.widgetConversationWrite,
    controller.startConversation,
  );

  router.get(
    "/conversations/:conversationId/messages",
    requireAccessToken,
    requireCustomerAccount,
    rateLimiters.widgetConversationRead,
    controller.listMessages,
  );

  router.post(
    "/conversations/:conversationId/messages",
    requireAccessToken,
    requireCustomerAccount,
    rateLimiters.widgetConversationWrite,
    validateBody(createMessageSchema),
    controller.sendMessage,
  );

  return router;
}
