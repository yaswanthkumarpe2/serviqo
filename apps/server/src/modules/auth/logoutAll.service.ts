import { logger } from "../../lib/logger";
import { sessionRepository } from "../sessions/session.repository";
import { failureType } from "./authLogging";
import { resolveSessionFromRefreshCookie } from "./refreshCookieSession";

import type { AuthLogger } from "./authLogging";
import type { SessionResolutionFailure } from "./refreshCookieSession";

/**
 * Logout across every device (ADR-014).
 *
 * Structurally ADR-013's logout with a wider blast radius: the same cookie,
 * the same credential check, the same always-succeeds contract — and
 * `revokeAllForUser` instead of `revokeById`.
 *
 * Requiring the current secret matters more here than anywhere else. The
 * session id inside the token is not secret, so accepting it alone would let
 * anyone who can guess an ObjectId sign a stranger out of every device they
 * own. The shared resolver enforces that (ADR-014 §3).
 */

/** Why a call revoked nothing. Never reaches the caller (ADR-014 §1). */
type NoopReason = SessionResolutionFailure | "revocation_failed";

export interface LogoutAllService {
  logoutAll(rawToken: string | undefined, log?: AuthLogger): Promise<void>;
}

export function createLogoutAllService(): LogoutAllService {
  return {
    async logoutAll(rawToken: string | undefined, log: AuthLogger = logger): Promise<void> {
      function noop(reason: NoopReason, sessionId?: string): void {
        log.info(
          { event: "auth.logout_all.noop", reason, ...(sessionId === undefined ? {} : { sessionId }) },
          "Logout-all revoked no sessions",
        );
      }

      const resolution = await resolveSessionFromRefreshCookie(rawToken);
      if (!resolution.ok) {
        return noop(resolution.reason, resolution.sessionId);
      }

      const { session } = resolution;
      const userId = session.userId.toString();
      const sessionId = session._id.toString();

      try {
        /*
          Scope comes from the query, not from a check: the filter is
          `{ userId, revokedAt: null }`, so other users are untouched because
          they are never selected (ADR-014 §5). The same filter leaves
          already-revoked sessions with their original timestamps, and makes a
          repeat call revoke nothing rather than overwrite anything.

          The requesting session is included. "All devices" that spared the
          device asking would be a strange reading of the words.
        */
        const revokedCount = await sessionRepository.revokeAllForUser(session.userId);

        /*
          The count is logged and never returned. It is a fact about the
          account — how many devices this person had signed in — and a response
          field that varies with internal state is the channel ADR-008 §1
          closed (ADR-014 §2).
        */
        log.info(
          { event: "auth.logout_all.succeeded", userId, sessionId, revokedCount },
          "All sessions revoked by logout-all",
        );
      } catch (err) {
        /*
          The response still succeeds and the cookie is still cleared. Unlike
          single-session logout, that leaves the OTHER devices alive — the
          opposite of what was asked — so this is logged at error level with
          its own event, because a half-finished revoke-everything is exactly
          the thing that must not disappear inside a 200.

          The error's class is recorded, never its message, which can quote
          document contents.
        */
        log.error(
          { event: "auth.logout_all.revocation_failed", userId, sessionId, failureType: failureType(err) },
          "Logout-all could not revoke the user's sessions",
        );
        return noop("revocation_failed", sessionId);
      }
    },
  };
}
