import { Router } from "express";

import { createAuthRouter } from "../modules/auth/auth.routes";

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

  return router;
}
