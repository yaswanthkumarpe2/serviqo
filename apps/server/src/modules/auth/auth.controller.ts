import { created, noContent } from "../../lib/response";

import type { RegisterInput, ResendVerificationInput, VerifyEmailInput } from "./auth.validation";
import type { RegistrationService } from "./registration.service";
import type { VerificationService } from "./verification.service";
import type { RequestHandler } from "express";

export interface AuthControllerDependencies {
  registrationService: RegistrationService;
  verificationService: VerificationService;
}

/**
 * Translates request → service → response, and nothing else. No validation
 * (the route's `validateBody` already ran), no persistence, no email.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error
 * into a response.
 */
export function createAuthController({
  registrationService,
  verificationService,
}: AuthControllerDependencies) {
  // Safe to assert in both handlers: validateBody replaced req.body with the
  // route's schema output before either could run.

  const register: RequestHandler = async (req, res) => {
    const user = await registrationService.register(req.body as RegisterInput, req.log);
    created(res, { user });
  };

  /**
   * Always 204, and the service is built so there is nothing else it could
   * return — no branch of resend produces a value, precisely so this handler
   * has no state it could accidentally disclose (ADR-008 §1).
   */
  const resendVerification: RequestHandler = async (req, res) => {
    await verificationService.resendVerification(req.body as ResendVerificationInput, req.log);
    noContent(res);
  };

  /**
   * 204 on success and on an already-verified account; the service throws
   * for every other outcome and errorHandler turns that into the single
   * 400 INVALID_VERIFICATION_TOKEN (ADR-009 §1).
   *
   * No body, no session, no cookie: verifying an address proves control of
   * an inbox, it does not present a credential (ADR-009 §7).
   */
  const verifyEmail: RequestHandler = async (req, res) => {
    await verificationService.verifyEmail(req.body as VerifyEmailInput, req.log);
    noContent(res);
  };

  return { register, resendVerification, verifyEmail };
}
