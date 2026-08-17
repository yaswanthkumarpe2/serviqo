import { Router } from "express";

import { createAuthRouter } from "../modules/auth/auth.routes";
import { createOrganizationRouter } from "../modules/organizations/organization.routes";

import type { EmailProvider } from "../lib/email/emailProvider";
import type { RateLimiters } from "../lib/rateLimit";

export interface ApiRouterDependencies {
  emailProvider: EmailProvider;
  rateLimiters: RateLimiters;
}

/**
 * Mounts every versioned API module under a single prefix, so `app.ts` stays
 * concerned with application-level middleware and one router mount rather
 * than accumulating a path per domain.
 *
 * `/health` deliberately stays outside this router, unversioned: a liveness
 * probe is infrastructure, not part of the API contract clients program
 * against. It is also outside the global rate limiter below — an
 * orchestrator's health check must not be able to exhaust a budget, and it
 * reads no data.
 */
export function createApiRouter({ emailProvider, rateLimiters }: ApiRouterDependencies): Router {
  const router = Router();

  /*
    The blunt per-IP volume bound, applied before any route matches
    (ADR-018 §3).

    It exists for what the specific classes cannot see: a request refused by
    `requireAccessToken` never reaches the user-keyed limiters, so hammering
    an authenticated route with no token would otherwise be unlimited. Set
    high enough that a specific class always fires first for honest traffic.
  */
  router.use("/api/v1", rateLimiters.global);

  router.use("/api/v1/auth", createAuthRouter({ emailProvider, rateLimiters }));
  /*
    Its own prefix, not a sub-path of /auth. The auth prefix is permanently
    organization-user authentication (ADR-010 §5); an organization is a
    tenant resource, and mounting its routes under the credential namespace
    would blur a boundary that later has to hold against customer traffic.
  */
  router.use("/api/v1/organizations", createOrganizationRouter({ rateLimiters }));

  return router;
}
