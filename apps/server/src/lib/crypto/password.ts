import argon2 from "argon2";

import {
  ARGON2_MEMORY_COST,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../../config/constants";

/**
 * Password hashing primitives. No business logic — registration, login,
 * lockout, and enumeration handling live in the future auth service.
 */

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON2_MEMORY_COST,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

/**
 * Canonicalizes a password with Unicode NFC, and nothing else.
 *
 * NFC — not NFKC — per RFC 8265 (PRECIS OpaqueString), the profile written
 * for passwords. NFC unifies only *canonically equivalent* sequences, which
 * Unicode defines as the same character (e.g. "é" as U+00E9 versus
 * U+0065 U+0301), so a password typed on one platform still verifies on
 * another. NFKC would additionally apply compatibility folding — collapsing
 * "ﬁ"→"fi", fullwidth "Ａ"→"A", "①"→"1" — merging genuinely distinct
 * passwords and measurably shrinking the password space.
 *
 * Deliberately absent: trimming, case folding, width mapping. A password is
 * an opaque secret, not an identifier; leading and trailing whitespace can
 * be intentional. This is exactly where password handling diverges from
 * email handling, which *is* trimmed and lowercased.
 *
 * Must be applied identically at registration, login, and password reset,
 * or verification silently breaks.
 */
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

/** Length is measured in code points after normalization, matching the stored form. */
function codePointLength(value: string): number {
  return [...value].length;
}

export function isPasswordLengthValid(normalizedPassword: string): boolean {
  const length = codePointLength(normalizedPassword);
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

/**
 * Hashes a password with Argon2id.
 *
 * Enforces the length policy defensively so an out-of-range password cannot
 * be hashed even if a caller forgets to validate. The user-facing 400 comes
 * from the request schema; this throw is a backstop, and its message never
 * includes the password.
 */
export async function hashPassword(password: string): Promise<string> {
  const normalized = normalizePassword(password);
  if (!isPasswordLengthValid(normalized)) {
    throw new RangeError(
      `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return argon2.hash(normalized, ARGON2_OPTIONS);
}

/**
 * Verifies a password against a stored hash. Returns false rather than
 * throwing for every failure mode — wrong password, malformed stored hash,
 * over-long input — because login must answer with one generic result and
 * must never crash on attacker-controlled input.
 *
 * The minimum length is intentionally NOT enforced here: a short login
 * attempt is simply wrong, not an error.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  const normalized = normalizePassword(password);
  if (codePointLength(normalized) > PASSWORD_MAX_LENGTH) return false;

  try {
    return await argon2.verify(storedHash, normalized);
  } catch {
    return false;
  }
}

/**
 * True when `storedHash` was produced with parameters weaker than the
 * current policy. Argon2's encoded hash carries its own parameters, so a
 * successful login can transparently upgrade an old hash.
 */
export function needsRehash(storedHash: string): boolean {
  return argon2.needsRehash(storedHash, ARGON2_OPTIONS);
}
