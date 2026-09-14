import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { validateBody } from "../../middleware/validate";
import { createAuthController } from "./auth.controller";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "./auth.validation";
import { createChangePasswordService } from "./changePassword.service";
import { createCurrentUserService } from "./currentUser.service";
import { createLoginService } from "./login.service";
import { createLogoutService } from "./logout.service";
import { createLogoutAllService } from "./logoutAll.service";
import { createPasswordResetService } from "./passwordReset.service";
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
    changePasswordService: createChangePasswordService(),
    passwordResetService: createPasswordResetService({ emailProvider }),
  });

  /*
    Four unauthenticated endpoints, four separate budgets (ADR-031) — six
    since password reset (ADR-036), below.

    They shared one — the credential class — until ADR-031, and the sharing
    was the bug: completing one honest sign-up costs a register call, a
    verify call, and a resend whenever the first mail is slow, so a person
    doing nothing wrong spent three to five of the ten attempts that budget
    was sized to allow a PASSWORD GUESSER. The result was a sign-up flow that
    locked out the people using it correctly while barely inconveniencing the
    attack it was drawn against.

    Splitting them lets each number answer the question its own endpoint
    poses. `credential` keeps the lockout pair, because guessing is what
    `/login` faces. `registration` bounds Argon2id cost and bulk account
    creation over an hour. `emailVerification` is the outer of two guessing
    bounds — `EMAIL_VERIFICATION_MAX_ATTEMPTS` is the inner and real one.
    `verificationResend` is the tightest of the four, because it is the only
    one whose accepted calls put mail in somebody else's inbox.

    All four mount BEFORE `validateBody`, unchanged and on purpose. A limiter
    behind validation would spend a Zod parse per attempt, and — more
    importantly — a caller could learn from the difference in responses
    whether their body was well-formed while being refused, which is a
    distinction a refused caller should not get.
  */
  router.post("/register", rateLimiters.registration, validateBody(registerSchema), controller.register);
  router.post(
    "/resend-verification",
    rateLimiters.verificationResend,
    validateBody(resendVerificationSchema),
    controller.resendVerification,
  );
  router.post("/verify-email", rateLimiters.emailVerification, validateBody(verifyEmailSchema), controller.verifyEmail);
  router.post("/login", rateLimiters.credential, validateBody(loginSchema), controller.login);
  /*
    Password reset (ADR-036), the fifth and sixth unauthenticated endpoints,
    each with its own class for ADR-031's reason. `passwordResetRequest` meters
    mail sent to an address the caller names; `passwordReset` is the outer
    guessing bound on a six-digit code whose real bound is its attempt counter.
    Limiters before validation, as above.
  */
  router.post(
    "/forgot-password",
    rateLimiters.passwordResetRequest,
    validateBody(forgotPasswordSchema),
    controller.forgotPassword,
  );
  router.post(
    "/reset-password",
    rateLimiters.passwordReset,
    validateBody(resetPasswordSchema),
    controller.resetPassword,
  );
  // No validateBody on any of these: the credential is the cookie, and none
  // of them accepts a body at all (ADR-012 §1, ADR-013 §3, ADR-014 §3). The
  // absence of a schema here is the point.
  /*
    The session class (ADR-018 §3). None of these has a verified principal —
    the credential is the cookie — so it keys on the session id the cookie
    names, falling back to the IP without one (ADR-035 §2). Higher than the
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

  /*
    Changing your own password (ADR-034 §8).

    The `credential` class rather than `authenticatedWrite`, and keyed by IP
    rather than by user like every other authenticated write: this endpoint
    verifies a password, so it is a place where guessing is the attack — the
    exact property ADR-018 §3 created that class for. A holder of a stolen
    access token must not get an unlimited oracle for the password they lack.
  */
  router.post(
    "/change-password",
    requireAccessToken,
    rateLimiters.credential,
    validateBody(changePasswordSchema),
    controller.changePassword,
  );

  return router;
}
