import { InvalidAccessTokenError } from "../lib/errors";
import { verifyAccessToken } from "../modules/auth/accessToken";

import type { RequestHandler } from "express";

/**
 * Serviqo's authentication boundary (ADR-015 §1).
 *
 * A route declares that it requires a credential in its own definition:
 *
 *   router.get("/me", requireAccessToken, controller.me);
 *
 * so "is this route protected?" is answered by reading the route file, the
 * same way `validateBody` answers "does this route validate its input?".
 *
 * This lives outside `modules/` because it is cross-cutting by construction —
 * every protected route in every future domain mounts it (ADR-003). The split
 * with `modules/auth/accessToken.ts` is header handling here, credential
 * handling there.
 *
 * It answers "who is calling" and never "may they". Authorization —
 * `requirePermission`, `requireOrganization` — belongs to the RBAC slice
 * (ADR-015 §13).
 */

/** One message for every refusal, so no branch is distinguishable by its text. */
const GENERIC_FAILURE_MESSAGE = "Authentication required";

/**
 * RFC 6750 §2.1. Matched case-insensitively on the scheme, which the RFC
 * requires, and with exactly one space — the form every client this codebase
 * ships produces.
 */
const BEARER_PATTERN = /^Bearer (.+)$/i;

/** Why a request was refused. Reaches the log, never a response body (ADR-015 §6). */
type RefusalReason = "missing_header" | "malformed_header" | "invalid_token";

/**
 * Reads the bearer token from `Authorization`, verifies it, and attaches the
 * principal it asserts to the request.
 *
 * Every refusal is the same `401 INVALID_ACCESS_TOKEN`. The `reason` recorded
 * below is for operators and is deliberately the one place the distinctions
 * exist.
 *
 * The token is never logged, malformed or not — it is a credential, and the
 * refusal events record why one failed rather than what was presented
 * (ADR-015 §12).
 */
export const requireAccessToken: RequestHandler = async (req, _res, next) => {
  function refuse(reason: RefusalReason): void {
    req.log.info({ event: "auth.access_token.rejected", reason }, "Request refused for want of a valid access token");
    next(new InvalidAccessTokenError(GENERIC_FAILURE_MESSAGE));
  }

  const header = req.get("authorization");
  if (header === undefined) {
    return refuse("missing_header");
  }

  const match = BEARER_PATTERN.exec(header);
  if (match === null) {
    // Covers a bare token, the wrong scheme (`Basic`, `Token`), and an empty
    // credential. All of them mean the same thing: no bearer token arrived.
    return refuse("malformed_header");
  }

  /*
    Signature, issuer, audience, expiry, and the shape of the claims — all
    inside the verifier, which returns null rather than distinguishing them
    (ADR-015 §2).

    A valid token is not yet an entitlement. It says which User is calling;
    whether that account may still be served is re-checked against the
    database by the service below (ADR-015 §7).
  */
  const principal = await verifyAccessToken(match[1]!);
  if (principal === null) {
    return refuse("invalid_token");
  }

  req.principal = principal;
  next();
};
