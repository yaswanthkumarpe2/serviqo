import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { createOrganizationController } from "./organization.controller";
import { createOrganizationSchema } from "./organization.validation";
import { createOrganizationOnboardingService } from "./organizationOnboarding.service";

import type { RateLimiters } from "../../lib/rateLimit";

/**
 * A factory rather than a module-level Router, matching `auth.routes.ts` —
 * though this one takes no dependencies today. Kept as a factory anyway so
 * the mount site reads identically for both modules and so the first
 * injected dependency does not change the file's shape.
 *
 * The middleware and the schema are visible in the route definition on
 * purpose: "is this route protected?" and "does it validate its input?" are
 * both answered by reading this file.
 */
export interface OrganizationRouterDependencies {
  rateLimiters: RateLimiters;
}

export function createOrganizationRouter({ rateLimiters }: OrganizationRouterDependencies): Router {
  const router = Router();

  const controller = createOrganizationController({
    onboardingService: createOrganizationOnboardingService(),
  });

  /*
    The second protected route in Serviqo, and the first that writes.

    No `requirePermission`: creating an organization is not an action inside
    an organization, so there is no tenant to be a member of and no role to
    require. It is the one authenticated write RBAC cannot govern, because it
    is what brings the first RBAC subject into existence (ADR-016 §1).
  */
  /*
    The write class, keyed by the verified user (ADR-018 §4). ADR-016 §2
    named this vector exactly — "an authenticated user can create
    organizations in a loop. That is a rate-limiting concern, and rate
    limiting is the next slice." This is that slice.

    Keyed by user rather than IP because the abuser here is authenticated:
    rotating IP addresses is trivial and rotating verified accounts is not.
  */
  router.post(
    "/",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    validateBody(createOrganizationSchema),
    controller.create,
  );

  /*
    The first organization-scoped route, and the first consumer of both
    authorization middlewares (ADR-017 §8).

    The order is the contract: who is calling, then which tenant and may they
    act in it, then does their role hold this permission. Each depends on the
    one before and throws loudly if mounted without it — a silent
    unauthenticated pass would be the worst possible failure here.

    The tenant is a path segment, not a header or a body field. A URL cannot
    be addressed without it, so a route that needs tenant context cannot be
    reached without naming one (ADR-017 §1).
  */
  router.get(
    "/:organizationId",
    requireAccessToken,
    // Read class, keyed by the verified user. Placed before the tenant
    // resolution so a caller cannot spend database lookups probing
    // organization ids they have no membership in (ADR-018 §3).
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("organization.read"),
    controller.read,
  );

  return router;
}
