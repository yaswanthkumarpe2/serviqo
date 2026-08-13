import { logger } from "../../lib/logger";
import { sessionRepository } from "../sessions/session.repository";
import { failureType } from "./authLogging";
import { resolveSessionFromRefreshCookie } from "./refreshCookieSession";

import type { AuthLogger } from "./authLogging";
import type { SessionResolutionFailure } from "./refreshCookieSession";

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

/**
 * Why a call revoked nothing. Never reaches the caller (ADR-013 §1).
 *
 * The credential-shaped reasons come from the shared resolver; only the
 * database failure below originates here.
 */
type NoopReason = SessionResolutionFailure | "revocation_failed";

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

      // Parse, load, validate, and compare the secret — the shared resolver
      // owns all of it, so logout and logout-all cannot drift on what counts
      // as a live credential (ADR-014 §6).
      const resolution = await resolveSessionFromRefreshCookie(rawToken);
      if (!resolution.ok) {
        return noop(resolution.reason, resolution.sessionId);
      }

      const { session } = resolution;
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
