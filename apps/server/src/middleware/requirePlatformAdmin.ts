import { InsufficientPermissionError } from "../lib/errors";
import { userRepository } from "../modules/users/user.repository";

import type { RequestHandler } from "express";

/**
 * The platform boundary (ADR-032 §4).
 *
 * `requirePermission` answers "may this member do this inside that tenant".
 * This answers a question no membership can: "does this account operate
 * Serviqo itself". They are different axes and this is deliberately not built
 * on top of the other — there is no organization in scope here, so there is no
 * `Membership` to read and no `can()` call that could be made.
 *
 * Mounted after `requireAccessToken`, which establishes who is calling:
 *
 *   router.get("/overview", requireAccessToken, requirePlatformAdmin, handler)
 *
 * so "is this route platform-only?" is answered by reading the route file, the
 * same way `validateBody` answers "does this route validate its input?".
 */

/**
 * One message for every refusal (ADR-032 §5).
 *
 * It names no role and no threshold, so an ordinary user who probes the admin
 * API learns only that they may not use it — not that a platform role exists,
 * nor what theirs is, nor what the endpoint would have told an admin.
 */
const GENERIC_FAILURE_MESSAGE = "You do not have permission to perform this action";

/** Why a request was refused. Reaches the log, never a response body. */
type RefusalReason = "no_principal" | "unknown_user" | "user_not_entitled" | "not_platform_admin";

/**
 * Refuses unless the caller holds `platformRole: "admin"` on an account that
 * may still be served.
 *
 * The grant is read from the DATABASE on every request and is never a token
 * claim (ADR-011 §2). That costs one query per admin request — an amount of
 * traffic that rounds to nothing — and buys the property that revoking the
 * most powerful role in the system takes effect immediately rather than
 * whenever the holder's access token happens to expire.
 *
 * The same exists/active/verified gate `currentUser.service.ts` applies runs
 * here too, and for the same reason: a valid signature identifies a user, it
 * does not entitle them (ADR-015 §7). It is repeated rather than shared
 * because the two refuse differently — that service throws 401 because the
 * question is "who are you", and this throws 403 because the question is "may
 * you", and a caller who reached this point has already proved the first.
 */
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  function refuse(reason: RefusalReason): void {
    /*
      Safe fields only. The reason and the user id are what an operator needs
      to tell a misconfigured grant from someone knocking on a door they
      should not know about — and the second of those is worth an alert.
    */
    req.log.warn(
      { event: "auth.platform_admin.denied", reason, userId: req.principal?.userId },
      "Request refused at the platform-admin boundary",
    );
    next(new InsufficientPermissionError(GENERIC_FAILURE_MESSAGE));
  }

  /*
    Asserted rather than handled the way `requirePermission` asserts its
    ordering dependency: a route that mounted this without
    `requireAccessToken` would be checking a platform grant against nobody at
    all. Failing loudly is the only safe response, but this one still refuses
    the REQUEST rather than throwing, because the wrong answer here is
    "allowed" and a 403 is the correct outcome for a caller with no principal.
  */
  const userId = req.principal?.userId;
  if (userId === undefined) {
    return refuse("no_principal");
  }

  const user = await userRepository.findById(userId);

  if (user === null) {
    return refuse("unknown_user");
  }

  if (user.status !== "active" || user.emailVerifiedAt === null) {
    return refuse("user_not_entitled");
  }

  if (user.platformRole !== "admin") {
    return refuse("not_platform_admin");
  }

  req.platformContext = { userId, platformRole: "admin" };
  next();
};
