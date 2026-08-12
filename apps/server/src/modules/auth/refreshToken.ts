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
 * Format and parsing are one rule, so they live in one file — splitting them
 * across slices is exactly the drift ADR-008 §7 warned about. `parseRefreshToken`
 * landed here with the refresh slice, beside the format it has to agree with.
 */

/**
 * Separates the non-secret routing component from the secret.
 *
 * base64url (RFC 4648 §5) contains no `.`, so the first separator is
 * unambiguously the boundary — a property the parser below depends on.
 */
export const REFRESH_TOKEN_SEPARATOR = ".";

/**
 * A 24-character hex ObjectId, which is exactly what `_id.toString()` produces.
 *
 * Checked before the id reaches Mongoose because `findById` raises a
 * `CastError` on a malformed value, and a hand-typed cookie answered with a
 * 500 would report a client's garbage as a server fault (ADR-012 §9).
 * Deliberately stricter than `mongoose.Types.ObjectId.isValid`, which also
 * accepts any 12-character string.
 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

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

export interface ParsedRefreshToken {
  /** Not secret — routes the lookup to exactly one Session document. */
  sessionId: string;
  /** The credential. Hashed for comparison and never stored, logged, or echoed. */
  secret: string;
}

/**
 * The inverse of `formatRefreshToken`. Returns `null` for anything that is not
 * a well-formed token — every rejection here becomes the same 401 as a
 * mismatched secret (ADR-012 §3).
 *
 * Splitting on the FIRST separator is what makes the format unambiguous: the
 * id cannot contain a `.`, so everything after the first one is the secret,
 * even though base64url guarantees the secret contains none either.
 *
 * This validates shape, not authenticity. A token that parses is still just a
 * claim until its secret hashes to something the session accepts.
 */
export function parseRefreshToken(raw: string): ParsedRefreshToken | null {
  const separatorIndex = raw.indexOf(REFRESH_TOKEN_SEPARATOR);
  // `<= 0` rejects both "no separator" and a leading one (empty session id).
  if (separatorIndex <= 0) return null;

  const sessionId = raw.slice(0, separatorIndex);
  if (!OBJECT_ID_PATTERN.test(sessionId)) return null;

  const secret = raw.slice(separatorIndex + 1);
  if (secret.length === 0) return null;

  return { sessionId, secret };
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

/**
 * Attributes for REMOVING the refresh cookie.
 *
 * A browser only replaces a cookie when name, `Path`, and domain all match,
 * so clearing has to reuse the attributes that set it — which is why this
 * derives from `refreshCookieOptions` rather than restating them and drifting.
 *
 * `maxAge` is dropped rather than zeroed: `res.clearCookie` sets an expiry in
 * the past, and `res.cookie` recomputes `expires` from `maxAge` whenever it is
 * present. Leaving it in would quietly re-issue the cookie for another seven
 * days at the exact moment the server meant to destroy it.
 */
export function clearRefreshCookieOptions(): CookieOptions {
  const options = refreshCookieOptions();
  delete options.maxAge;
  return options;
}
