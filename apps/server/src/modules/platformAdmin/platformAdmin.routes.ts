import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requirePlatformAdmin } from "../../middleware/requirePlatformAdmin";
import { validateBody } from "../../middleware/validate";
import { createAgentInvitationService } from "./agentInvitation.service";
import { inviteAgentSchema } from "./agentInvitation.validation";
import { createPlatformAdminController } from "./platformAdmin.controller";
import { createPlatformAdminService } from "./platformAdmin.service";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { RateLimiters } from "../../lib/rateLimit";

export interface PlatformAdminRouterDependencies {
  rateLimiters: RateLimiters;
  /** Threaded from app construction (ADR-002 §4), like every other mail sender. */
  emailProvider: EmailProvider;
}

/**
 * The platform operations API (ADR-032 §3).
 *
 * Every route carries the same three-middleware prefix, written out on each
 * one rather than hoisted into `router.use`. That is the convention the rest
 * of this codebase follows — "is this route protected?" is answered by reading
 * the route file — and it matters more here than anywhere else: this is the
 * only router in Serviqo whose handlers read across tenants, and a reader must
 * not have to scroll up to discover what is guarding them.
 *
 * The ORDER is load-bearing. `requireAccessToken` establishes who is calling;
 * `requirePlatformAdmin` re-reads their grant from the database and refuses
 * everyone else; only then does the limiter run, so it can key on a verified
 * user rather than a socket address (ADR-018 §4).
 *
 * `authenticatedRead` rather than a class of its own. A new class is warranted
 * when an endpoint's abuse shape differs from every existing one — that is
 * what `memberInvite` and `ownershipTransfer` each argued — and these are
 * ordinary authenticated reads performed by a handful of people. Inventing a
 * limit for them would be inventing a number.
 */
export function createPlatformAdminRouter({
  rateLimiters,
  emailProvider,
}: PlatformAdminRouterDependencies): Router {
  const controller = createPlatformAdminController({
    platformAdminService: createPlatformAdminService(),
    agentInvitationService: createAgentInvitationService({ emailProvider }),
  });

  const router = Router();

  router.get("/overview", requireAccessToken, requirePlatformAdmin, rateLimiters.authenticatedRead, controller.overview);
  router.get(
    "/organizations",
    requireAccessToken,
    requirePlatformAdmin,
    rateLimiters.authenticatedRead,
    controller.organizations,
  );
  router.get("/users", requireAccessToken, requirePlatformAdmin, rateLimiters.authenticatedRead, controller.users);

  /*
    The one write on this router (ADR-034 §7).

    `memberInvite` rather than `authenticatedWrite`: this endpoint sends mail to
    an address the caller names, which is the abuse shape ADR-027 §12 created
    that class for, and it is the same shape whether the inviter is a tenant
    admin or a platform one.
  */
  router.post(
    "/agents",
    requireAccessToken,
    requirePlatformAdmin,
    rateLimiters.memberInvite,
    validateBody(inviteAgentSchema),
    controller.inviteAgent,
  );

  return router;
}
