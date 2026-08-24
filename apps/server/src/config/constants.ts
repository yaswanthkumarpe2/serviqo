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

// ---- widget visitor token (ADR-019 §8) ----
//
// The second credential format in Serviqo, and deliberately not a variant of
// the first. A widget token says "this browser is that customer, in that
// tenant" and nothing else — no role, no permission, no staff reach.

/**
 * Widget-token lifetime.
 *
 * Long compared to `ACCESS_TOKEN_TTL_MS`, and that is the decision rather
 * than an oversight (ADR-019 §6). ADR-010 §6 required a visitor credential to
 * "survive an entire conversation and probably a return visit". A token that
 * expires mid-conversation would silently create a SECOND customer for the
 * same person — the worst available failure, because it looks like it worked.
 *
 * The same twenty-four hours `EMAIL_VERIFICATION_TOKEN_TTL_MS` uses. Nothing
 * can shorten it for a token already issued: widget tokens are stateless and
 * unrevocable, which this value is therefore the sole bound on
 * (ADR-019 §14).
 */
export const WIDGET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * JWT `iss` claim — deliberately the SAME string as `ACCESS_TOKEN_ISSUER`,
 * and written as a reference so the two cannot drift apart by accident
 * (ADR-019 §8).
 *
 * One system issues both credentials, and inventing a second issuer would be
 * a lie about the topology told to make a table look more different. The
 * audience below is the discriminator; that is what audience is for.
 */
export const WIDGET_TOKEN_ISSUER = ACCESS_TOKEN_ISSUER;

/**
 * JWT `aud` claim — the principal type this token authenticates.
 *
 * The other half of the pair `ACCESS_TOKEN_AUDIENCE` was minted for eleven
 * slices early (ADR-010 §5). A token carrying one audience can never verify
 * against a verifier demanding the other, so a visitor credential cannot
 * reach a staff route and a staff credential cannot reach a widget route.
 *
 * It is the weaker of the two separations. The stronger one is that the two
 * formats are signed with different keys (`JWT_WIDGET_SECRET`), so a staff
 * token presented here fails at the signature rather than at a claim.
 */
export const WIDGET_TOKEN_AUDIENCE = "serviqo-widget";

/**
 * Minimum length of the widget HS256 signing secret, in characters.
 *
 * Deliberately equal to `ACCESS_TOKEN_SECRET_MIN_LENGTH` — HMAC-SHA256's
 * security is bounded by its key regardless of which credential it signs —
 * and deliberately named separately, so raising one does not silently raise
 * the other.
 */
export const WIDGET_TOKEN_SECRET_MIN_LENGTH = 32;

// ---- public widget identifier (ADR-019 §9) ----

/**
 * Bytes of entropy in an organization's `widgetKey` (32 bytes = 256 bits).
 *
 * The same width as `REFRESH_SECRET_BYTES`, for a value that is NOT a secret.
 * A widget key is published in every tenant's page source; the entropy is
 * there so the key cannot be guessed into, not so it can be kept. It is also
 * what makes collision retry a branch that never executes (ADR-019 §9).
 */
export const WIDGET_KEY_BYTES = 32;

/**
 * Prefix every widget key carries.
 *
 * Self-describing in a log line or a support ticket, and greppable by
 * secret-scanning tooling that flags high-entropy strings. Three characters.
 */
export const WIDGET_KEY_PREFIX = "wk_";

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
 * Authenticated writes: `POST /organizations`, and, as of ADR-020,
 * `PUT /organizations/:id/widget-config/origins` and
 * `POST /organizations/:id/widget-config/rotate-key`.
 *
 * ADR-016 §2 recorded the vector precisely — "an authenticated user can
 * create organizations in a loop. That is a rate-limiting concern, and rate
 * limiting is the next slice." Thirty tenants in an hour is far past
 * anything a person does, and far below what a script wants. The widget
 * installation routes reuse this class rather than a new one: staff-
 * initiated, low-frequency configuration writes with the same shape.
 */
export const AUTHENTICATED_WRITE_LIMIT = 30;
export const AUTHENTICATED_WRITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Authenticated reads: `GET /auth/me`, `GET /organizations/:organizationId`,
 * and, as of ADR-020, `GET /organizations/:id/widget-config`.
 *
 * A dashboard mount costs two calls, so 300 allows roughly 150 page loads
 * per window per user. This class catches a runaway client or a scraper
 * rather than an attacker — these reads are cheap and already authorized.
 */
export const AUTHENTICATED_READ_LIMIT = 300;
export const AUTHENTICATED_READ_WINDOW_MS = 15 * 60 * 1000;

/**
 * The public widget session endpoint: `POST /widget/session` (ADR-019 §11).
 *
 * The sixth class, ordered in advance by ADR-010 §9 — "two limiter classes,
 * not one" — because customer endpoints are high-volume, anonymous, and
 * unauthenticated by design, while staff endpoints face a small, known
 * population that per-account lockout also protects.
 *
 * The numbers are `SESSION_LIMIT` and `SESSION_WINDOW_MS` rather than new
 * ones, because the endpoint has the same shape: unauthenticated, IP-keyed,
 * exactly one database write per call, and no secret being guessed. Sixty
 * covers a shared NAT of ordinary size — a visitor needs one session per
 * browser per `WIDGET_TOKEN_TTL_MS` — while bounding an anonymous
 * document-creating loop to four per minute.
 *
 * NOT the credential class: ten per fifteen minutes is a guessing bound
 * derived from `LOGIN_MAX_FAILED_ATTEMPTS`, and nothing is guessed here.
 * Applied to a public widget it would take one small office behind one NAT
 * to exhaust a tenant's visitors — a self-inflicted outage, not a defence.
 *
 * Its own class rather than sharing the session bucket, so widget traffic
 * cannot exhaust a staff member's refresh budget and staff traffic cannot
 * exhaust a tenant's visitors.
 */
export const WIDGET_SESSION_LIMIT = SESSION_LIMIT;
export const WIDGET_SESSION_WINDOW_MS = SESSION_WINDOW_MS;

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

/**
 * Conversation and message writes: `POST /widget/conversations`,
 * `POST /widget/conversations/:id/messages` (ADR-022 §12).
 *
 * Keyed by customer, not IP — `requireWidgetToken` establishes a verified
 * principal before this runs, the same shape `authenticatedWrite` already
 * has for staff. Not that class's numbers (30/hour): thirty rare,
 * deliberate staff configuration writes per hour is a different traffic
 * shape from an active conversation's messages. Not `widgetSession`'s either
 * (IP-keyed, for a route with no principal yet). A stated judgment: sixty in
 * five minutes is one message every five seconds sustained — generous for
 * genuine rapid typing, bounding a scripted flood to a low, non-disruptive
 * rate.
 */
export const WIDGET_CONVERSATION_WRITE_LIMIT = 60;
export const WIDGET_CONVERSATION_WRITE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Conversation message history reads: `GET /widget/conversations/:id/messages`
 * (ADR-022 §12).
 *
 * Keyed by customer. Reuses `AUTHENTICATED_READ_LIMIT`'s numbers rather than
 * inventing new ones — both are cheap, already-authorized reads bounding a
 * runaway client rather than defending against an attacker, and the shape
 * (per-principal, 15-minute window) transfers unchanged.
 */
export const WIDGET_CONVERSATION_READ_LIMIT = AUTHENTICATED_READ_LIMIT;
export const WIDGET_CONVERSATION_READ_WINDOW_MS = AUTHENTICATED_READ_WINDOW_MS;

// ---- conversations and messages (ADR-022) ----

/**
 * Maximum message body length, in Unicode code points, measured after
 * trimming.
 *
 * A judgment call, stated as one: long enough for a genuine multi-paragraph
 * support question, short enough to bound per-message storage and rendering
 * cost. Enforced at both the Zod boundary and the `Message` schema itself
 * (ADR-022 §9) — two layers sharing this one constant.
 */
export const MESSAGE_BODY_MAX_LENGTH = 4000;

/** Messages returned per page when a caller does not specify `limit` (ADR-022 §11). */
export const MESSAGE_PAGE_DEFAULT_LIMIT = 30;

/** The most messages a single page may request, regardless of `limit` (ADR-022 §11). */
export const MESSAGE_PAGE_MAX_LIMIT = 100;

// ---- session metadata ----

/**
 * Maximum stored User-Agent length. Shared across layers — the HTTP boundary
 * helper truncates to it and the session schema validates against it — so it
 * is owned here rather than by either one.
 */
export const MAX_USER_AGENT_LENGTH = 512;
