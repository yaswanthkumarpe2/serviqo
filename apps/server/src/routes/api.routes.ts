import { Router } from "express";

import { createAuthRouter } from "../modules/auth/auth.routes";
import { createOrganizationRouter } from "../modules/organizations/organization.routes";

import type { EmailProvider } from "../lib/email/emailProvider";

export interface ApiRouterDependencies {
  emailProvider: EmailProvider;
}

/**
 * Mounts every versioned API module under a single prefix, so `app.ts` stays
 * concerned with application-level middleware and one router mount rather
 * than accumulating a path per domain.
 *
 * `/health` deliberately stays outside this router, unversioned: a liveness
 * probe is infrastructure, not part of the API contract clients program
 * against.
 */
export function createApiRouter({ emailProvider }: ApiRouterDependencies): Router {
  const router = Router();

  router.use("/api/v1/auth", createAuthRouter({ emailProvider }));
  /*
    Its own prefix, not a sub-path of /auth. The auth prefix is permanently
    organization-user authentication (ADR-010 §5); an organization is a
    tenant resource, and mounting its routes under the credential namespace
    would blur a boundary that later has to hold against customer traffic.
  */
  router.use("/api/v1/organizations", createOrganizationRouter());

  return router;
}
