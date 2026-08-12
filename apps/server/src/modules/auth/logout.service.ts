import { sha256, timingSafeEqualHex } from "../../lib/crypto/tokens";
import { logger } from "../../lib/logger";
import { sessionRepository } from "../sessions/session.repository";
import { failureType } from "./authLogging";
import { parseRefreshToken } from "./refreshToken";

import type { AuthLogger } from "./authLogging";

/**
 * Logout (ADR-013), the third consumer of the refresh cookie and the first
 * that destroys rather than exchanges it.
 *
 * The service returns nothing and throws nothing. Every path — revoked,
 * already revoked, unknown, malformed, absent — ends the same way, because
 * "log me out" asks for a state rather than a transaction, and a state that
 * already holds is not a failure (§1). The controller clears the cookie
 * unconditionally for the same reason.
 *
 * Distinctions exist only in the log, where they are for operators.
 */

/** Why a call revoked nothing. Never reaches the caller (ADR-013 §1). */
type NoopReason =
  | "missing_cookie"
  | "malformed_token"
  | "unknown_session"
  | "already_revoked"
  | "expired_session"
  | "secret_mismatch"
  | "revocation_failed";

export interface LogoutService {
  logout(rawToken: string | undefined, log?: AuthLogger): Promise<void>;
}

export function createLogoutService(): LogoutService {
  return {
    async logout(rawToken: string | undefined, log: AuthLogger = logger): Promise<void> {
      function noop(reason: NoopReason, sessionId?: string): void {
        log.info(
          { event: "auth.logout.noop", reason, ...(sessionId === undefined ? {} : { sessionId }) },
          "Logout revoked no session",
        );
      }

      if (rawToken === undefined) {
        return noop("missing_cookie");
      }

      // The token is never logged, malformed or not — it is a credential.
      const parsed = parseRefreshToken(rawToken);
      if (parsed === null) {
        return noop("malformed_token");
      }

      const session = await sessionRepository.findByIdWithRefreshTokenState(parsed.sessionId);
      if (session === null) {
        return noop("unknown_session", parsed.sessionId);
      }

      // Evaluated logically rather than by the document's existence: the TTL
      // monitor is asynchronous (ADR-004 §6). Neither branch has anything to
      // revoke, and they are separated only so the log distinguishes a session
      // someone ended from one that timed out.
      if (session.revokedAt !== null) {
        return noop("already_revoked", parsed.sessionId);
      }
      if (session.expiresAt <= new Date()) {
        return noop("expired_session", parsed.sessionId);
      }

      /*
        The session id in the token is not secret, so it cannot be the whole
        credential — revoking on it alone would let anyone end anyone's session
        by guessing an ObjectId (ADR-013 §3).

        Only the CURRENT hash counts. A previously rotated one revokes nothing
        and, deliberately, does not trigger reuse detection: that response
        costs every session the user has, and must not be reachable from an
        endpoint that grants nothing (§4-5).
      */
      if (!timingSafeEqualHex(sha256(parsed.secret), session.currentRefreshTokenHash)) {
        return noop("secret_mismatch", parsed.sessionId);
      }

      const userId = session.userId.toString();
      const sessionId = session._id.toString();

      try {
        // Filters on `revokedAt: null`, so two logouts racing each other leave
        // one revocation and the original timestamp (ADR-013 §6).
        const revoked = await sessionRepository.revokeById(session._id);

        if (revoked === null) {
          // Another request won between the read above and this write. The
          // session is revoked either way, which is all the caller asked for.
          return noop("already_revoked", sessionId);
        }

        log.info(
          { event: "auth.logout.succeeded", userId, sessionId },
          "Session revoked by logout",
        );
      } catch (err) {
        /*
          The response still succeeds and the cookie is still cleared: the
          browser has lost its credential, which is most of what signing out
          means to the person who asked for it.

          Logged as its own event, at error level, so a session left alive by a
          database failure is visible during triage rather than hidden inside a
          200. The error's class is recorded, never its message, which can
          quote document contents.
        */
        log.error(
          { event: "auth.logout.revocation_failed", userId, sessionId, failureType: failureType(err) },
          "Logout could not revoke the session",
        );
        return noop("revocation_failed", sessionId);
      }
    },
  };
}
