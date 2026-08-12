import { Router } from "express";

import { validateBody } from "../../middleware/validate";
import { createAuthController } from "./auth.controller";
import { loginSchema, registerSchema, resendVerificationSchema, verifyEmailSchema } from "./auth.validation";
import { createLoginService } from "./login.service";
import { createRegistrationService } from "./registration.service";
import { createVerificationService } from "./verification.service";

import type { EmailProvider } from "../../lib/email/emailProvider";

export interface AuthRouterDependencies {
  emailProvider: EmailProvider;
}

/**
 * A factory rather than a module-level Router, so the EmailProvider is an
 * explicit dependency threaded from app construction (ADR-002 §4) — tests
 * inject a fake without mocking module resolution.
 *
 * The schema is visible in each route definition on purpose: "does this
 * route validate its input?" is answered by reading this file.
 */
export function createAuthRouter({ emailProvider }: AuthRouterDependencies): Router {
  const router = Router();

  const controller = createAuthController({
    registrationService: createRegistrationService({ emailProvider }),
    verificationService: createVerificationService({ emailProvider }),
    // Takes no EmailProvider: login sends nothing. Its factory does start the
    // dummy-hash computation, so constructing it early is deliberate.
    loginService: createLoginService(),
  });

  router.post("/register", validateBody(registerSchema), controller.register);
  router.post("/resend-verification", validateBody(resendVerificationSchema), controller.resendVerification);
  router.post("/verify-email", validateBody(verifyEmailSchema), controller.verifyEmail);
  router.post("/login", validateBody(loginSchema), controller.login);

  return router;
}
