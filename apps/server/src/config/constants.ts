/**
 * Fixed security policy values.
 *
 * These live in code, NOT in the environment, deliberately: a misconfigured
 * or malicious deployment must not be able to weaken password hashing,
 * widen a lockout threshold, or stretch the refresh grace window. Only
 * deployment-varying values (ports, URIs, log level) belong in `lib/env`.
 *
 * Ownership rule for constants: a value lives here when more than one layer
 * needs it. Values used only inside a single module stay in that module —
 * `MAX_PREVIOUS_REFRESH_TOKEN_HASHES` and `MAX_IP_LENGTH`, for example,
 * remain in `modules/sessions/session.model.ts` because only the session
 * schema and its rotation pipeline consume them, and moving them would
 * churn frozen code for no benefit.
 */

// ---- password policy ----

/** Minimum password length in Unicode code points, measured AFTER NFC normalization. */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Maximum password length in code points. Bounds per-attempt work and,
 * together with the JSON body limit, prevents oversized-input abuse.
 */
export const PASSWORD_MAX_LENGTH = 128;

// ---- Argon2id parameters (ADR-002 §1) ----
// OWASP-recommended baseline. Kept as plain numbers so this module has no
// dependency on the argon2 package; `lib/crypto/password.ts` assembles the
// options object and supplies the argon2id type.

/** Memory cost in KiB (19456 KiB = 19 MiB). */
export const ARGON2_MEMORY_COST = 19456;
/** Number of iterations. */
export const ARGON2_TIME_COST = 2;
/** Degree of parallelism. */
export const ARGON2_PARALLELISM = 1;

// ---- login lockout ----

/** Consecutive failed logins before an account is temporarily locked. */
export const LOGIN_MAX_FAILED_ATTEMPTS = 10;

/**
 * Lock duration. Always auto-expiring — a permanent lock would turn a known
 * email address into a denial-of-service vector.
 */
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

// ---- refresh rotation ----

/** Bytes of entropy in a refresh secret (32 bytes = 256 bits). */
export const REFRESH_SECRET_BYTES = 32;

/**
 * Window after a rotation in which presenting the immediately-previous
 * refresh token is classified as a benign concurrent refresh rather than
 * replay (ADR-004, amended).
 *
 * This window governs ONLY whether reuse triggers revocation. It must never
 * authorize issuing an access token, a refresh token, or a cookie — the
 * losing request of a legitimate race receives credentials of no kind.
 */
export const REFRESH_RACE_GRACE_MS = 10 * 1000;

// ---- session metadata ----

/**
 * Maximum stored User-Agent length. Shared across layers — the HTTP boundary
 * helper truncates to it and the session schema validates against it — so it
 * is owned here rather than by either one.
 */
export const MAX_USER_AGENT_LENGTH = 512;
