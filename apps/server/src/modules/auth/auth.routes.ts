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
import type { RateLimiters } from "../../lib/rateLimit";

export interface AuthRouterDependencies {
  emailProvider: EmailProvider;
  rateLimiters: RateLimiters;
}

/**
 * A factory rather than a module-level Router, so the EmailProvider is an
 * explicit dependency threaded from app construction (ADR-002 §4) — tests
 * inject a fake without mocking module resolution.
 *
 * The schema is visible in each route definition on purpose: "does this
 * route validate its input?" is answered by reading this file.
 */
export function createAuthRouter({ emailProvider, rateLimiters }: AuthRouterDependencies): Router {
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

  /*
    The credential class (ADR-018 §3): the endpoints where guessing is the
    attack, or where an unauthenticated caller triggers Argon2id work. Its
    limit and window are `LOGIN_MAX_FAILED_ATTEMPTS` and
    `LOGIN_LOCK_DURATION_MS`, so the per-IP bound and the per-account lockout
    agree rather than enforcing two different policies.

    Mounted BEFORE `validateBody` on purpose. A limiter behind validation
    would spend a Zod parse per attempt, and — more importantly — a caller
    could learn from the difference in responses whether their body was
    well-formed while being refused, which is a distinction a refused caller
    should not get.
  */
  router.post("/register", rateLimiters.credential, validateBody(registerSchema), controller.register);
  router.post(
    "/resend-verification",
    rateLimiters.credential,
    validateBody(resendVerificationSchema),
    controller.resendVerification,
  );
  router.post("/verify-email", rateLimiters.credential, validateBody(verifyEmailSchema), controller.verifyEmail);
  router.post("/login", rateLimiters.credential, validateBody(loginSchema), controller.login);
  // No validateBody on any of these: the credential is the cookie, and none
  // of them accepts a body at all (ADR-012 §1, ADR-013 §3, ADR-014 §3). The
  // absence of a schema here is the point.
  /*
    The session class (ADR-018 §3), keyed by IP because none of these has a
    verified principal — the credential is the cookie. Higher than the
    credential class because a legitimate tab refreshes once per access-token
    lifetime plus once per reload, and lower than the read class because each
    of these performs a database write.
  */
  router.post("/refresh", rateLimiters.session, controller.refresh);
  router.post("/logout", rateLimiters.session, controller.logout);
  router.post("/logout-all", rateLimiters.session, controller.logoutAll);
  // Serviqo's first protected route, and the reason `requireAccessToken`
  // exists (ADR-015). The middleware is visible here for the same reason the
  // schemas above are: "is this route protected?" is answered by reading this
  // file. No `validateBody` — the caller's identity comes from the token and
  // the database, and there is no input to validate (ADR-015 §11).
  /*
    The read class, mounted AFTER `requireAccessToken` so it can key on the
    verified user rather than the socket address (ADR-018 §4). An office
    behind one NAT would otherwise share a single budget, making a shared
    limit a shared outage.

    An unauthenticated request never reaches this limiter — it is refused by
    `requireAccessToken` first — which is precisely why the global per-IP
    bound in `api.routes.ts` exists.
  */
  router.get("/me", requireAccessToken, rateLimiters.authenticatedRead, controller.me);

  return router;
}
