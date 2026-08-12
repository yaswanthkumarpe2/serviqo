import { REFRESH_COOKIE_NAME } from "../../config/constants";
import { readCookie } from "../../lib/http/cookies";
import { normalizeUserAgent } from "../../lib/http/userAgent";
import { created, noContent, success } from "../../lib/response";
import { RefreshRejectedError } from "./refresh.service";
import { clearRefreshCookieOptions, refreshCookieOptions } from "./refreshToken";

import type { LoginInput, RegisterInput, ResendVerificationInput, VerifyEmailInput } from "./auth.validation";
import type { LoginService } from "./login.service";
import type { LogoutService } from "./logout.service";
import type { RefreshService } from "./refresh.service";
import type { RegistrationService } from "./registration.service";
import type { VerificationService } from "./verification.service";
import type { RequestHandler } from "express";

export interface AuthControllerDependencies {
  registrationService: RegistrationService;
  verificationService: VerificationService;
  loginService: LoginService;
  refreshService: RefreshService;
  logoutService: LogoutService;
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
  loginService,
  refreshService,
  logoutService,
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

  /**
   * The refresh token is written to an HttpOnly cookie and is deliberately
   * absent from the body — a body copy would make the flag meaningless
   * (ADR-011 §1). The access token goes the other way, in the body, so it
   * never becomes an ambient credential on every API call.
   *
   * The User-Agent is truncated by the existing boundary helper before it
   * reaches the service; it is diagnostic metadata that must never be able
   * to fail a login.
   */
  const login: RequestHandler = async (req, res) => {
    const result = await loginService.login(
      req.body as LoginInput,
      { userAgent: normalizeUserAgent(req.get("user-agent")) },
      req.log,
    );

    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());

    success(res, {
      user: result.user,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    });
  };

  /**
   * Exchanges the refresh cookie for a fresh pair of credentials (ADR-012).
   *
   * The credential is read from the cookie header here and nowhere else —
   * there is no body and no schema, because a second place to look for a
   * credential is how one of them ends up trusted by mistake (§1). Cookies
   * are parsed at this one call site rather than by app-wide middleware, so
   * the header's blast radius matches the cookie's `Path` scope (§2).
   *
   * The error is caught, uniquely among these handlers, for one reason: the
   * cookie has to be cleared on the way out. Every refusal is the same
   * `INVALID_REFRESH_TOKEN`, and errorHandler still writes the body — the
   * catch only decides the `Set-Cookie`, then rethrows (§5).
   */
  const refresh: RequestHandler = async (req, res) => {
    try {
      const result = await refreshService.refresh(readCookie(req.headers.cookie, REFRESH_COOKIE_NAME), req.log);

      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());

      success(res, {
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    } catch (err) {
      // False for exactly one refusal: the loser of a concurrent rotation,
      // whose cookie the winning request has already replaced with a valid
      // token. Clearing it there would destroy a live credential.
      if (err instanceof RefreshRejectedError && err.clearCookie) {
        res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      }
      throw err;
    }
  };

  /**
   * Ends the current session (ADR-013).
   *
   * No try/catch and no branch: the service resolves on every path, so the
   * cookie is cleared and the envelope written unconditionally. That IS the
   * idempotency — a second logout is not a failed logout, and answering
   * differently would confirm which session ids are real (§1).
   *
   * The cookie is cleared even when nothing was revoked. Removing the
   * browser's credential is the part of signing out the browser owns, and it
   * is correct whether or not the server had a session to end.
   *
   * `data` is deliberately a constant. ADR-008 §1 reserved 204 for bodies
   * whose *contents* would vary with internal state; a body that says the same
   * thing to everyone is not a channel, so the standard envelope costs nothing
   * here (§2).
   */
  const logout: RequestHandler = async (req, res) => {
    await logoutService.logout(readCookie(req.headers.cookie, REFRESH_COOKIE_NAME), req.log);

    res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());

    success(res, {});
  };

  return { register, resendVerification, verifyEmail, login, refresh, logout };
}
