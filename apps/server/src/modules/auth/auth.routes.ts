import { Router } from "express";

import { validateBody } from "../../middleware/validate";
import { createAuthController } from "./auth.controller";
import { registerSchema } from "./auth.validation";
import { createRegistrationService } from "./registration.service";

import type { EmailProvider } from "../../lib/email/emailProvider";

export interface AuthRouterDependencies {
  emailProvider: EmailProvider;
}

/**
 * A factory rather than a module-level Router, so the EmailProvider is an
 * explicit dependency threaded from app construction (ADR-002 §4) — tests
 * inject a fake without mocking module resolution.
 *
 * The schema is visible in the route definition on purpose: "does this route
 * validate its input?" is answered by reading this file.
 */
export function createAuthRouter({ emailProvider }: AuthRouterDependencies): Router {
  const router = Router();

  const registrationService = createRegistrationService({ emailProvider });
  const controller = createAuthController({ registrationService });

  router.post("/register", validateBody(registerSchema), controller.register);

  return router;
}
