import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { REFRESH_SECRET_BYTES } from "../../config/constants";

/**
 * Primitives for opaque, database-backed token secrets (ADR-004).
 *
 * Separate from `lib/ids`, which mints non-secret correlation identifiers.
 * These values are credentials: different security tier, different review
 * expectations, so they do not share a module.
 *
 * No token *format* logic here (no `sessionId.secret` assembly or parsing)
 * and no JWT issuance — those belong to the auth/token service in a later
 * slice.
 */

/**
 * Generates a cryptographically random secret, base64url-encoded.
 *
 * 32 bytes = 256 bits, well beyond guessing range, which is why these
 * secrets are hashed with SHA-256 rather than a memory-hard KDF: there is
 * no low-entropy input to slow an attacker down over.
 *
 * base64url (RFC 4648 §5) is used so the value is safe in a cookie, header,
 * or URL without escaping — it contains no `+`, `/`, or `=`.
 */
export function generateSecret(): string {
  return randomBytes(REFRESH_SECRET_BYTES).toString("base64url");
}

/** Deterministic SHA-256 digest, lowercase hex. Deterministic because lookup compares stored digests. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two SHA-256 hex digests.
 *
 * `crypto.timingSafeEqual` throws on length mismatch, so lengths are checked
 * first. That early return is safe here: both operands are always 64-character
 * digests of the same fixed-width function, so a length difference means
 * malformed input rather than a near-miss guess, and reveals nothing about
 * the secret.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
