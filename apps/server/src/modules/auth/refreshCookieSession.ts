import { sha256, timingSafeEqualHex } from "../../lib/crypto/tokens";
import { sessionRepository } from "../sessions/session.repository";
import { parseRefreshToken } from "./refreshToken";

import type { SessionDocument } from "../sessions/session.model";

/**
 * Resolves a refresh cookie to the session it authenticates (ADR-014 §6).
 *
 * Shared by the two logout services, which ask the same question — "is this
 * cookie a live credential for a real session?" — and differ only in how much
 * they then revoke. Extracted rather than copied because a second copy of
 * security-critical credential handling is a defect waiting for its second
 * author: a fix applied to one endpoint would silently miss the other.
 *
 * `/refresh` deliberately does NOT use this. Its classification is a three-way
 * outcome with a grace window and reuse detection (ADR-012 §4), not a yes/no
 * on the current hash, and folding the two together would make this answer a
 * question neither caller quite asked.
 *
 * Resolves; never throws. What a caller does with a refusal — and every
 * logout path answers success regardless (ADR-013 §1) — is the caller's
 * decision, so this reports rather than decides.
 */

/** Why a cookie did not resolve to a usable session. Reaches the log, never a response body. */
export type SessionResolutionFailure =
  | "missing_cookie"
  | "malformed_token"
  | "unknown_session"
  | "already_revoked"
  | "expired_session"
  | "secret_mismatch";

export type SessionResolution =
  | { ok: true; session: SessionDocument }
  /** `sessionId` is absent when the cookie never yielded one to report. */
  | { ok: false; reason: SessionResolutionFailure; sessionId?: string };

export async function resolveSessionFromRefreshCookie(
  rawToken: string | undefined,
): Promise<SessionResolution> {
  if (rawToken === undefined) {
    return { ok: false, reason: "missing_cookie" };
  }

  // The token is never returned or logged, malformed or not — it is a credential.
  const parsed = parseRefreshToken(rawToken);
  if (parsed === null) {
    return { ok: false, reason: "malformed_token" };
  }

  const session = await sessionRepository.findByIdWithRefreshTokenState(parsed.sessionId);
  if (session === null) {
    return { ok: false, reason: "unknown_session", sessionId: parsed.sessionId };
  }

  // Evaluated logically rather than by the document's existence: the TTL
  // monitor is asynchronous (ADR-004 §6). Neither branch has anything to
  // revoke, and they are separated only so the log distinguishes a session
  // someone ended from one that timed out.
  if (session.revokedAt !== null) {
    return { ok: false, reason: "already_revoked", sessionId: parsed.sessionId };
  }
  if (session.expiresAt <= new Date()) {
    return { ok: false, reason: "expired_session", sessionId: parsed.sessionId };
  }

  /*
    The session id in the token is not secret, so it cannot be the whole
    credential — revoking on it alone would let anyone end anyone's session by
    guessing an ObjectId (ADR-013 §3). On the logout-all path that same
    guess would end every session the user has, which is why this check is
    load-bearing rather than incidental (ADR-014 §3).

    Only the CURRENT hash counts. A previously rotated one resolves to nothing
    and, deliberately, does not trigger reuse detection (ADR-013 §5).
  */
  if (!timingSafeEqualHex(sha256(parsed.secret), session.currentRefreshTokenHash)) {
    return { ok: false, reason: "secret_mismatch", sessionId: parsed.sessionId };
  }

  return { ok: true, session };
}
