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

// ---- account action tokens (ADR-005) ----
// Lifetimes for the single-use credentials emailed for account actions.
// Kept in code for the same reason as the values above: a misconfigured
// deployment must not be able to stretch a reset window.

/** Email-verification links stay usable for 24 hours. */
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Password-reset links are deliberately much shorter-lived than verification. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// ---- access token (ADR-011) ----

/**
 * Access-token lifetime.
 *
 * Short by design: nothing checks a session's revocation state per request,
 * so this value alone bounds how long a revoked session's access token keeps
 * working. Lengthening it widens that window.
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/** JWT `iss` claim. */
export const ACCESS_TOKEN_ISSUER = "serviqo";

/**
 * JWT `aud` claim — the principal type this token authenticates (ADR-010 §5).
 *
 * Serviqo authenticates organization users only; customers never hold a
 * token of any kind. This claim exists so that if a customer visitor
 * credential is ever introduced, a token minted for one principal type
 * cannot verify as the other. It is one claim now and un-retrofittable onto
 * tokens already issued.
 */
export const ACCESS_TOKEN_AUDIENCE = "serviqo-dashboard";

/**
 * Minimum length of the HS256 signing secret, in characters.
 *
 * HMAC-SHA256's security is bounded by key length; a short human-chosen
 * secret is the whole system's weakest link. Enforced at boot so a process
 * cannot start signing with one.
 */
export const ACCESS_TOKEN_SECRET_MIN_LENGTH = 32;

// ---- sessions and the refresh cookie (ADR-011) ----

/**
 * How long one login stays refreshable before the user must authenticate
 * again. Also the refresh cookie's Max-Age, so the two cannot drift.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Name of the cookie carrying the opaque refresh token. */
export const REFRESH_COOKIE_NAME = "serviqo_refresh";

/**
 * Path the refresh cookie is scoped to.
 *
 * Keeps the cookie off every non-auth API call, shrinking both its exposure
 * and the CSRF surface, and makes it structurally impossible for the staff
 * refresh credential to reach a future customer/widget endpoint (ADR-010 §8).
 * It also fixes the refresh endpoint's URL prefix — accepted deliberately.
 */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

// ---- rate limiting (ADR-018 §3) ----
//
// These live here rather than in `lib/rateLimit` for this file's stated
// ownership rule — more than one layer needs them: the limiter enforces
// them and the tests assert against them. They are also fixed policy in
// exactly the sense this file's header describes, so a misconfigured
// deployment cannot widen a security limit through the environment.
//
// No number here is invented. Each is either taken from a value the
// codebase already committed to, or is a judgement stated in ADR-018 §3.

/**
 * Credential endpoints: register, login, resend-verification, verify-email.
 *
 * Deliberately the SAME numbers as `LOGIN_MAX_FAILED_ATTEMPTS` and
 * `LOGIN_LOCK_DURATION_MS` above. Those already encode the approved answer
 * to "how many credential attempts is too many, and for how long"; a
 * different pair here would mean the per-IP limit and the per-account
 * lockout (ADR-011 §7) disagreed about one policy.
 *
 * Changing the lockout constants without revisiting these puts them back
 * into disagreement.
 *
 * This also bounds the denial-of-service ADR-007 §13 named: `POST /register`
 * spends ~19 MiB and ~100 ms of Argon2id per call on an unauthenticated
 * path.
 */
export const CREDENTIAL_LIMIT = LOGIN_MAX_FAILED_ATTEMPTS;
export const CREDENTIAL_WINDOW_MS = LOGIN_LOCK_DURATION_MS;

/**
 * Session endpoints: refresh, logout, logout-all.
 *
 * A legitimate tab refreshes about once per `ACCESS_TOKEN_TTL_MS`, plus once
 * per page load. Sixty allows heavy reloading across several tabs and still
 * bounds a loop.
 *
 * Not a guessing defence — refresh secrets are `REFRESH_SECRET_BYTES` of
 * entropy, so guessing is already infeasible. This bounds volume on an
 * endpoint that performs a database write per call.
 */
export const SESSION_LIMIT = 60;
export const SESSION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Authenticated writes: currently `POST /organizations`.
 *
 * ADR-016 §2 recorded the vector precisely — "an authenticated user can
 * create organizations in a loop. That is a rate-limiting concern, and rate
 * limiting is the next slice." Thirty tenants in an hour is far past
 * anything a person does, and far below what a script wants.
 */
export const AUTHENTICATED_WRITE_LIMIT = 30;
export const AUTHENTICATED_WRITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Authenticated reads: `GET /auth/me`, `GET /organizations/:organizationId`.
 *
 * A dashboard mount costs two calls, so 300 allows roughly 150 page loads
 * per window per user. This class catches a runaway client or a scraper
 * rather than an attacker — these reads are cheap and already authorized.
 */
export const AUTHENTICATED_READ_LIMIT = 300;
export const AUTHENTICATED_READ_WINDOW_MS = 15 * 60 * 1000;

/**
 * Every request under `/api/v1`, keyed by IP.
 *
 * A blunt volume bound covering what the specific classes cannot: requests
 * refused before any class applies. Hammering `GET /auth/me` with no token
 * produces a 401 from `requireAccessToken` and never reaches the user-keyed
 * read limiter, so without this it would be unlimited.
 *
 * Set high enough that it never fires before a specific class does for
 * honest traffic.
 */
export const GLOBAL_API_LIMIT = 1000;
export const GLOBAL_API_WINDOW_MS = 15 * 60 * 1000;

// ---- session metadata ----

/**
 * Maximum stored User-Agent length. Shared across layers — the HTTP boundary
 * helper truncates to it and the session schema validates against it — so it
 * is owned here rather than by either one.
 */
export const MAX_USER_AGENT_LENGTH = 512;
