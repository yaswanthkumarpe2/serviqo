import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { createConversationService } from "../conversations/conversation.service";
import { createMessageService } from "../messages/message.service";
import { createAgentInboxController } from "./agentInbox.controller";
import { sendAgentMessageSchema } from "./agentInbox.validation";

import type { RateLimiters } from "../../lib/rateLimit";

/**
 * The staff-facing conversation surface (ADR-025 §1, §3) — `modules/widget/`'s
 * symmetric twin.
 *
 * Where that router mounts NO authentication middleware because a customer
 * holds no staff credential, this one mounts the full chain on every single
 * route, in the order ADR-017 §8 fixed:
 *
 *   who is calling → bound them → which tenant and may they act in it →
 *   does their role hold this permission → is the input well-formed
 *
 * Each depends on the one before and throws loudly if mounted without it. The
 * middleware and the schema are visible in each route definition on purpose:
 * "is this route protected?", "which permission does it need?", and "does it
 * validate its input?" are all answered by reading this file.
 */
export interface AgentInboxRouterDependencies {
  rateLimiters: RateLimiters;
}

export function createAgentInboxRouter({ rateLimiters }: AgentInboxRouterDependencies): Router {
  /*
    `mergeParams` so `:organizationId` — a segment of the MOUNT path, not of
    any route below — reaches `requireOrganization`, which reads it from
    `req.params` and consults no other source (ADR-017 §1).

    Without this the tenant would silently be `undefined` on every request,
    and `requireOrganization` would refuse everything as `malformed_organization_id`.
    That is a safe failure rather than an open door, but it is still a broken
    surface, which is why `agentInbox.routes.test.ts` asserts a successful
    read rather than only asserting refusals.
  */
  const router = Router({ mergeParams: true });

  const controller = createAgentInboxController({
    conversationService: createConversationService(),
    messageService: createMessageService(),
  });

  /*
    The read class, keyed by the verified user (ADR-018 §4), mounted BEFORE
    `requireOrganization` on every read — the same placement
    `GET /organizations/:organizationId` uses and for the same stated reason:
    a caller must not be able to spend database lookups probing organization
    ids they hold no membership in (ADR-018 §3).
  */
  router.get(
    "/",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("conversation.read"),
    controller.listConversations,
  );

  router.get(
    "/:conversationId",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("conversation.read"),
    controller.readConversation,
  );

  router.get(
    "/:conversationId/messages",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("conversation.read"),
    controller.listMessages,
  );

  /*
    The one write, and the only route in Serviqo behind
    `conversation.reply` — which is to say the only HTTP path by which
    `senderType: "agent"` becomes reachable (ADR-025 §6).

    `authenticatedWrite`'s bound is 30/hour, chosen in ADR-016 §2 for
    organization creation. ADR-025 §3 and §13 record openly that this is low
    for an agent replying over REST and name the follow-up (a dedicated
    `agentConversationWrite` class reusing `WIDGET_CONVERSATION_WRITE_LIMIT`'s
    numbers). Reused as-is here rather than widening a shared class from
    inside a feature slice.
  */
  router.post(
    "/:conversationId/messages",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("conversation.reply"),
    validateBody(sendAgentMessageSchema),
    controller.sendMessage,
  );

  return router;
}
