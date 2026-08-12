import {
  REFRESH_COOKIE_PATH,
  SESSION_TTL_MS,
} from "../../config/constants";
import { generateSecret, sha256 } from "../../lib/crypto/tokens";
import { env } from "../../lib/env";

import type { CookieOptions } from "express";

/**
 * The single home for the refresh credential's shape and transport
 * (ADR-004 §2, ADR-011 §1, §12).
 *
 * Format and parsing are one rule, so they live in one file even though
 * only issuance has a caller today — splitting them across slices is exactly
 * the drift ADR-008 §7 warned about. `parseRefreshToken` lands here with the
 * refresh slice, beside the format it has to agree with.
 */

/**
 * Separates the non-secret routing component from the secret.
 *
 * base64url (RFC 4648 §5) contains no `.`, so the first separator is
 * unambiguously the boundary — a property the future parser depends on.
 */
export const REFRESH_TOKEN_SEPARATOR = ".";

export interface RefreshSecret {
  /** The credential itself. Never persisted, never logged, never in a response body. */
  secret: string;
  /** The only form that reaches MongoDB. */
  secretHash: string;
}

/**
 * Mints a refresh secret and its stored digest.
 *
 * SHA-256 rather than Argon2id: this is a 256-bit random value, not
 * guessable human input, so a memory-hard KDF buys nothing and lookup must
 * be deterministic (ADR-004 §3).
 *
 * The hash depends only on the secret, which is what lets a Session be
 * created before its `_id` exists — the id is needed to *format* the token,
 * not to hash it.
 */
export function generateRefreshSecret(): RefreshSecret {
  const secret = generateSecret();
  return { secret, secretHash: sha256(secret) };
}

/**
 * Assembles the opaque refresh token (ADR-004 §2):
 *
 *     <sessionId>.<secret>
 *
 * The `sessionId` is not secret. It exists so the future refresh flow can
 * load exactly one Session document and compare one hash, instead of
 * scanning — which is what keeps validation O(1) and means no index over
 * sensitive material is ever needed.
 */
export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}${REFRESH_TOKEN_SEPARATOR}${secret}`;
}

/**
 * Cookie attributes for the refresh credential (ADR-011 §12).
 *
 * - `httpOnly` — the credential must be unreachable from page JavaScript.
 * - `sameSite: "strict"` — the primary CSRF control, and the resolution of
 *   the question ADR-007 §14 deferred until refresh cookies existed.
 * - `path` — keeps the cookie off every non-auth API call and makes it
 *   structurally impossible to send to a future customer/widget endpoint
 *   (ADR-010 §8).
 * - `maxAge` — the session's own lifetime, taken from the same constant the
 *   Session's `expiresAt` uses, so the two cannot drift.
 *
 * `secure` is off only outside production, because a Secure cookie cannot be
 * set over plain-HTTP localhost. `development` and `test` are the only other
 * values the environment schema permits, and ADR-007 §13's deployment gate
 * already forbids exposing authentication endpoints beyond local development.
 */
export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: SESSION_TTL_MS,
  };
}
