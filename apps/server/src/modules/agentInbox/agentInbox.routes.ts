import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { readUploadBody } from "../attachments/attachment.routes";
import { createConversationService } from "../conversations/conversation.service";
import { createMessageService } from "../messages/message.service";
import { createAgentInboxController } from "./agentInbox.controller";
import {
  sendAgentMessageSchema,
  updateConversationTagsSchema,
  updateAssignmentSchema,
  updateConversationStatusSchema,
} from "./agentInbox.validation";

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

  /*
    Registered BEFORE `/:conversationId`, which would otherwise take "tags" as
    a conversation id and refuse it as malformed (ADR-042 §3).
  */
  router.get(
    "/tags",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("conversation.read"),
    controller.listTags,
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
    rateLimiters.agentConversationWrite,
    requireOrganization,
    requirePermission("conversation.reply"),
    validateBody(sendAgentMessageSchema),
    controller.sendMessage,
  );

  /*
    An agent uploads a file to send (ADR-041 §2). Behind `conversation.reply`,
    because a file is only ever uploaded to be sent. The body is read last, after
    every check, so a refused caller never makes the server buffer a file.
  */
  // Tagging is working the conversation, so it shares `conversation.reply` with replying and closing.
  router.put(
    "/:conversationId/tags",
    requireAccessToken,
    rateLimiters.agentConversationWrite,
    requireOrganization,
    requirePermission("conversation.reply"),
    validateBody(updateConversationTagsSchema),
    controller.updateTags,
  );

  router.post(
    "/:conversationId/attachments",
    requireAccessToken,
    rateLimiters.attachmentUpload,
    requireOrganization,
    requirePermission("conversation.reply"),
    readUploadBody,
    controller.uploadAttachment,
  );

  /*
    Assignment and status are TWO routes rather than one `PATCH` on the
    conversation, and the reason is visible right here: the permission on the
    next line differs from the permission on the one after it (ADR-026 §2).

    `requirePermission` takes one permission per route by construction, so a
    combined endpoint accepting `{ assignedTo, status }` would have to check
    the second permission INSIDE the handler — moving the authorization
    decision out of this file and into a branch, which is the "scattered
    `if (role === 'admin')` checks" shape ADR-002 §7–19 forbade.

    Both are `PATCH` on a sub-resource path, so the path IS the field being
    changed and each route can carry exactly one permission without a
    discriminator in the body doing authorization work.

    `authenticatedWrite`, matching the reply route above and inheriting
    ADR-025 §13's recorded limitation — 30/hour is low for an agent working a
    queue, and the follow-up is a dedicated `agentConversationWrite` class
    rather than widening a shared one from inside a feature slice
    (ADR-026 §12).
  */
  router.patch(
    "/:conversationId/assignment",
    requireAccessToken,
    rateLimiters.agentConversationWrite,
    requireOrganization,
    requirePermission("conversation.assign"),
    validateBody(updateAssignmentSchema),
    controller.updateAssignment,
  );

  /*
    Behind `conversation.reply`, not `conversation.assign` and not a new
    `conversation.close` (ADR-026 §3): closing is acting in a conversation,
    which is the standing `conversation.reply` already describes, and a
    permission whose row would be identical to it for every role is being
    anticipated rather than enforced.
  */
  router.patch(
    "/:conversationId/status",
    requireAccessToken,
    rateLimiters.agentConversationWrite,
    requireOrganization,
    requirePermission("conversation.reply"),
    validateBody(updateConversationStatusSchema),
    controller.updateStatus,
  );

  return router;
}
