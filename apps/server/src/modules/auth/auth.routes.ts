import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { validateBody } from "../../middleware/validate";
import { createAuthController } from "./auth.controller";
import { loginSchema, registerSchema, resendVerificationSchema, verifyEmailSchema } from "./auth.validation";
import { createCurrentUserService } from "./currentUser.service";
import { createLoginService } from "./login.service";
import { createLogoutService } from "./logout.service";
import { createLogoutAllService } from "./logoutAll.service";
import { createRefreshService } from "./refresh.service";
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
    refreshService: createRefreshService(),
    logoutService: createLogoutService(),
    logoutAllService: createLogoutAllService(),
    currentUserService: createCurrentUserService(),
  });

  router.post("/register", validateBody(registerSchema), controller.register);
  router.post("/resend-verification", validateBody(resendVerificationSchema), controller.resendVerification);
  router.post("/verify-email", validateBody(verifyEmailSchema), controller.verifyEmail);
  router.post("/login", validateBody(loginSchema), controller.login);
  // No validateBody on any of these: the credential is the cookie, and none
  // of them accepts a body at all (ADR-012 §1, ADR-013 §3, ADR-014 §3). The
  // absence of a schema here is the point.
  router.post("/refresh", controller.refresh);
  router.post("/logout", controller.logout);
  router.post("/logout-all", controller.logoutAll);
  // Serviqo's first protected route, and the reason `requireAccessToken`
  // exists (ADR-015). The middleware is visible here for the same reason the
  // schemas above are: "is this route protected?" is answered by reading this
  // file. No `validateBody` — the caller's identity comes from the token and
  // the database, and there is no input to validate (ADR-015 §11).
  router.get("/me", requireAccessToken, controller.me);

  return router;
}
