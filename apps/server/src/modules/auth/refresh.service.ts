import { REFRESH_RACE_GRACE_MS } from "../../config/constants";
import { sha256, timingSafeEqualHex } from "../../lib/crypto/tokens";
import { InvalidRefreshTokenError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { sessionRepository } from "../sessions/session.repository";
import { userRepository } from "../users/user.repository";
import { issueAccessToken } from "./accessToken";
import { failureType } from "./authLogging";
import { toAuthenticatedUser } from "./login.service";
import { formatRefreshToken, generateRefreshSecret, parseRefreshToken } from "./refreshToken";

import type { SessionDocument } from "../sessions/session.model";
import type { UserDocument } from "../users/user.model";
import type { AuthLogger } from "./authLogging";
import type { AuthenticatedUser } from "./login.service";

/**
 * Refresh token exchange (ADR-012), the only consumer of the refresh
 * credential and the code that finally implements ADR-004's classification
 * table.
 *
 * Every refusal leaves through the same error with the same message. The
 * `reason` recorded in the log is for operators, and is deliberately the one
 * place the distinctions exist (ADR-012 §3).
 */

/** One message for every refusal, so no branch is distinguishable by its text. */
const GENERIC_FAILURE_MESSAGE = "Refresh token is invalid or expired";

export interface RefreshResult {
  user: AuthenticatedUser;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /**
   * The rotated refresh token. Goes into the HttpOnly cookie and NOWHERE
   * else — a copy in the response body would defeat the flag (ADR-011 §1).
   */
  refreshToken: string;
}

/**
 * How the controller must treat the cookie on failure.
 *
 * `clearCookie` is false for exactly one refusal: the loser of a concurrent
 * rotation. Clearing there would delete the cookie the winning request just
 * set, turning a self-healing race into a forced re-login (ADR-012 §5).
 */
export interface RefreshFailure {
  clearCookie: boolean;
}

/**
 * Thrown for every refusal. Carries the cookie disposition, which is the only
 * thing that varies between refusal branches — and the only thing a caller
 * can observe.
 */
export class RefreshRejectedError extends InvalidRefreshTokenError {
  readonly clearCookie: boolean;

  constructor(message: string, { clearCookie }: RefreshFailure) {
    super(message);
    this.clearCookie = clearCookie;
  }
}

export interface RefreshService {
  refresh(rawToken: string | undefined, log?: AuthLogger): Promise<RefreshResult>;
}

/**
 * The classification of a presented secret against a session's token state
 * (ADR-004 §4).
 */
type Classification = "current" | "concurrent_refresh" | "replay" | "unknown";

function reject(clearCookie: boolean): never {
  throw new RefreshRejectedError(GENERIC_FAILURE_MESSAGE, { clearCookie });
}

/** A session is valid logically, never by existence alone — TTL is cleanup (ADR-004 §6). */
function isUsable(session: SessionDocument, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt > now;
}

/**
 * Places the presented secret in ADR-004's three-way table, with the grace
 * window splitting "replay" into a benign and a hostile case (ADR-012 §4).
 *
 * Only the LAST history entry can be a concurrent refresh. An older hash
 * means the session has rotated more than once since that token was current,
 * which no double-submit produces.
 */
function classify(session: SessionDocument, presentedHash: string, now: Date): Classification {
  if (timingSafeEqualHex(presentedHash, session.currentRefreshTokenHash)) return "current";

  const history = session.previousRefreshTokenHashes;
  const matchedIndex = history.findIndex((hash) => timingSafeEqualHex(presentedHash, hash));
  if (matchedIndex < 0) return "unknown";

  const isImmediatelyPrevious = matchedIndex === history.length - 1;
  const withinGrace =
    session.lastRotatedAt !== null && now.getTime() - session.lastRotatedAt.getTime() <= REFRESH_RACE_GRACE_MS;

  return isImmediatelyPrevious && withinGrace ? "concurrent_refresh" : "replay";
}

export function createRefreshService(): RefreshService {
  /**
   * Detected theft: every session this user has is revoked, not just the one
   * the replayed token addressed. A stolen refresh token usually means the
   * device or its storage is compromised, so the sessions that were not
   * replayed are the ones most worth ending.
   */
  async function revokeEverythingFor(session: SessionDocument, log: AuthLogger): Promise<void> {
    const userId = session.userId.toString();
    try {
      const revokedCount = await sessionRepository.revokeAllForUser(session.userId);
      log.error(
        { event: "auth.refresh.reuse_detected", userId, sessionId: session._id.toString(), revokedCount },
        "Refresh token reuse detected; every session for this user was revoked",
      );
    } catch (err) {
      // The refusal stands regardless. Logged as its own event so a failed
      // revocation is never mistaken for a successful one during triage.
      log.error(
        { event: "auth.refresh.revocation_failed", userId, failureType: failureType(err) },
        "Refresh token reuse detected but sessions could not be revoked",
      );
    }
  }

  /**
   * The session-time equivalent of login's post-password gates (ADR-012 §7).
   *
   * Refresh is the only moment in a seven-day session when the server
   * reconsiders whether the account may still mint access tokens. The session
   * is revoked rather than merely refused, so a dead account's cookie stops
   * coming back every fifteen minutes.
   */
  async function loadEntitledUser(session: SessionDocument, log: AuthLogger): Promise<UserDocument> {
    const user = await userRepository.findById(session.userId.toString());

    // The `emailVerifiedAt` half is expected to be unreachable — nothing
    // un-verifies an address today — and is checked anyway, so a future
    // email-change flow cannot walk around this gate in silence.
    if (user === null || user.status !== "active" || user.emailVerifiedAt === null) {
      await sessionRepository.revokeById(session._id);
      log.info(
        {
          event: "auth.refresh.failed",
          reason: user === null ? "unknown_user" : "user_not_entitled",
          userId: session.userId.toString(),
          sessionId: session._id.toString(),
        },
        "Refresh refused for an account that may no longer hold a session",
      );
      reject(true);
    }

    return user;
  }

  return {
    async refresh(rawToken: string | undefined, log: AuthLogger = logger): Promise<RefreshResult> {
      if (rawToken === undefined) {
        log.info({ event: "auth.refresh.failed", reason: "missing_cookie" }, "Refresh attempted with no cookie");
        // Nothing to clear, but clearing an absent cookie is harmless and
        // keeps the no-credential answer identical to a dead one.
        reject(true);
      }

      const parsed = parseRefreshToken(rawToken);
      if (parsed === null) {
        // The token is never logged: malformed or not, it is a credential.
        log.info({ event: "auth.refresh.failed", reason: "malformed_token" }, "Refresh token could not be parsed");
        reject(true);
      }

      const session = await sessionRepository.findByIdWithRefreshTokenState(parsed.sessionId);
      if (session === null) {
        log.info(
          { event: "auth.refresh.failed", reason: "unknown_session", sessionId: parsed.sessionId },
          "Refresh attempted against a session that does not exist",
        );
        reject(true);
      }

      const now = new Date();

      // Checked before classification, so a session already revoked by an
      // earlier reuse detection does not re-run revocation on every replay.
      if (!isUsable(session, now)) {
        log.info(
          {
            event: "auth.refresh.failed",
            reason: session.revokedAt !== null ? "session_revoked" : "session_expired",
            userId: session.userId.toString(),
            sessionId: session._id.toString(),
          },
          "Refresh attempted against a session that is no longer usable",
        );
        reject(true);
      }

      const presentedHash = sha256(parsed.secret);
      const classification = classify(session, presentedHash, now);

      if (classification === "replay") {
        await revokeEverythingFor(session, log);
        reject(true);
      }

      if (classification === "concurrent_refresh") {
        // The losing request of a legitimate race receives credentials of no
        // kind — and keeps its cookie, which the winner has already replaced
        // with the current token (ADR-012 §4-5).
        log.info(
          {
            event: "auth.refresh.failed",
            reason: "concurrent_refresh",
            userId: session.userId.toString(),
            sessionId: session._id.toString(),
          },
          "Refresh lost a race with a concurrent rotation",
        );
        reject(false);
      }

      if (classification === "unknown") {
        log.info(
          {
            event: "auth.refresh.failed",
            reason: "unknown_secret",
            userId: session.userId.toString(),
            sessionId: session._id.toString(),
          },
          "Refresh attempted with a secret this session has never accepted",
        );
        reject(true);
      }

      const user = await loadEntitledUser(session, log);

      const { secret, secretHash } = generateRefreshSecret();

      // Compare-and-swap: commits only if the session still accepts the hash
      // just validated. A null return means another request rotated first,
      // which is the same benign race as above — issue nothing, keep the
      // cookie (ADR-012 §6).
      const rotated = await sessionRepository.rotateRefreshToken(session._id, presentedHash, secretHash);
      if (rotated === null) {
        log.info(
          {
            event: "auth.refresh.failed",
            reason: "rotation_lost",
            userId: session.userId.toString(),
            sessionId: session._id.toString(),
          },
          "Refresh lost the rotation write to a concurrent request",
        );
        reject(false);
      }

      const { token: accessToken, expiresInSeconds } = await issueAccessToken({
        userId: user._id.toString(),
        sessionId: session._id.toString(),
      });

      log.info(
        { event: "auth.refresh.succeeded", userId: user._id.toString(), sessionId: session._id.toString() },
        "Refresh token rotated and a new access token issued",
      );

      // `secret` goes out of scope here; the only copy that leaves this
      // process is inside the Set-Cookie header the controller writes.
      return {
        user: toAuthenticatedUser(user),
        accessToken,
        expiresIn: expiresInSeconds,
        refreshToken: formatRefreshToken(session._id.toString(), secret),
      };
    },
  };
}
