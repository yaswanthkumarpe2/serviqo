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

/**
 * How long an emailed verification CODE stays usable (ADR-030 §3).
 *
 * Ten minutes, not the twenty-four hours a link had. The two numbers protect
 * against different things and the difference is not a matter of taste: a
 * 256-bit link secret cannot be guessed no matter how long it lives, while a
 * six-digit code has about a million possibilities, so its lifetime is
 * literally one of the two terms bounding a guessing attack. The other is
 * EMAIL_VERIFICATION_MAX_ATTEMPTS below.
 *
 * Ten minutes is long enough for mail to arrive and a person to switch
 * windows and retype six digits, and short enough that a code left in an
 * abandoned inbox is not a standing credential.
 */
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Digits in an emailed verification code.
 *
 * Six is what people expect and will retype without resentment. It is also
 * only ~20 bits, which is why this constant never appears without the two
 * beside it — the code is not the security boundary, the code plus its TTL
 * plus its attempt limit is.
 */
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;

/**
 * How many wrong codes one issued code survives before it is destroyed
 * (ADR-030 §4).
 *
 * The load-bearing half of the design. Without it, a million guesses walks
 * through a six-digit code and the whole scheme is theatre; with it, an
 * attacker gets five tries out of a million per issued code and must trigger
 * a new email — which the resend rate limiter meters — to get five more.
 *
 * On exhaustion the code is CONSUMED rather than merely counted, so a
 * sixth guess has nothing to test even if it is correct.
 */
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;

/**
 * How long an emailed password-reset CODE stays usable (ADR-036 §2).
 *
 * Replaces the hour a reset LINK was going to live. Once reset became a
 * six-digit code the reasoning ADR-030 §3 gave for verification applies
 * without change — a code's lifetime is one of the two terms bounding a
 * guessing attack — and a reset code guards something strictly more valuable
 * than a verification code does, so it is certainly no longer-lived.
 *
 * Deliberately its own constant rather than an alias of the verification TTL.
 * The two are equal today because the same person reading the same inbox
 * needs the same few minutes; they are not equal by definition, and an alias
 * would let a change aimed at one silently move the other.
 */
export const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong codes one issued reset code survives before it is destroyed
 * (ADR-036 §2).
 *
 * The same five as verification and for the same reason — this, not the
 * code's length, is what makes six digits a credential. Exhaustion consumes
 * the code, so the attacker must trigger a fresh email, which the
 * `passwordResetRequest` limiter meters.
 */
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;

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
 * `POST /login` — and nothing else (ADR-031 §2).
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
 * This class USED to cover register, resend-verification and verify-email
 * as well, and the shared budget was the bug ADR-031 exists to fix: one
 * sign-up costs a register call, a verify call and — whenever the first mail
 * is slow or lands in spam — a resend, so a single honest person completing
 * a single sign-up spent three to five of the ten attempts this number was
 * sized to allow a password guesser. Each of those endpoints now has its own
 * budget below, sized to what that endpoint is actually defending against.
 */
export const CREDENTIAL_LIMIT = LOGIN_MAX_FAILED_ATTEMPTS;
export const CREDENTIAL_WINDOW_MS = LOGIN_LOCK_DURATION_MS;

/**
 * `POST /verify-email` (ADR-031 §4).
 *
 * This one IS a guessing defence, but the per-IP budget is the outer of two
 * bounds, not the real one: `EMAIL_VERIFICATION_MAX_ATTEMPTS` destroys the
 * issued code after five wrong guesses, so an attacker's ceiling is five
 * tries per code regardless of what this number says.
 *
 * Twenty per fifteen minutes therefore buys headroom for the honest case
 * that the old shared budget did not have — mistyping a code, a second
 * browser tab, a family behind one address each verifying their own account
 * — while still refusing a client that is grinding codes across many
 * addresses from one IP.
 */
export const EMAIL_VERIFICATION_LIMIT = 20;
export const EMAIL_VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

/**
 * `POST /resend-verification` (ADR-031 §5).
 *
 * The tightest of the four, and the only one that is tighter than the shared
 * budget it replaced. This endpoint is an email-sending oracle aimed at an
 * address the caller names: every accepted call puts a message in somebody
 * else's inbox, so the cost of being generous is paid by a third party and
 * by the sending domain's reputation, not by this server.
 *
 * Three per fifteen minutes is two more than a person who is waiting for a
 * slow mail needs, and far below anything useful as a mail bomb. Someone who
 * exhausts it has a delivery problem a fourth copy will not solve.
 */
export const VERIFICATION_RESEND_LIMIT = 3;
export const VERIFICATION_RESEND_WINDOW_MS = 15 * 60 * 1000;

/**
 * `POST /forgot-password` (ADR-036 §5).
 *
 * The same shape and the same numbers as `verificationResend`, as a separate
 * class. It is the same kind of endpoint — every accepted call puts mail in an
 * inbox the caller names — so the same three per fifteen minutes is right.
 *
 * Separate because sharing would recreate ADR-031's bug in miniature: a person
 * who had just waited on a slow verification mail would find they could not
 * ask for a reset code, and a run of refusals in the log could not say which
 * of the two mail senders was being hammered.
 */
export const PASSWORD_RESET_REQUEST_LIMIT = 3;
export const PASSWORD_RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;

/**
 * `POST /reset-password` (ADR-036 §5).
 *
 * The outer of two guessing bounds, exactly as `emailVerification` is:
 * `PASSWORD_RESET_MAX_ATTEMPTS` destroys an issued code after five wrong
 * guesses whatever this number allows. Twenty per fifteen minutes leaves room
 * for mistyped digits and a rejected new password without letting one address
 * grind codes across many accounts.
 */
export const PASSWORD_RESET_LIMIT = 20;
export const PASSWORD_RESET_WINDOW_MS = 15 * 60 * 1000;

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
 * Adding a member to an organization: `POST /organizations/:id/members`
 * (ADR-027 §12).
 *
 * The ninth class, and it exists for exactly one property of exactly one
 * route. ADR-027 §5 accepts that this endpoint distinguishes "a verified
 * Serviqo account exists for this email" from "it does not", because the
 * alternative — answering 201 for an address that was added to nothing —
 * would have a manager believe they granted access that does not exist. That
 * disclosure needs a bound, and this is it.
 *
 * NOT `authenticatedWrite`. Sharing that budget would put the probe on the
 * same 30/hour counter as role changes and removals, so a manager doing
 * ordinary team admin would spend the probing budget and the limiter could
 * not tell the two apart — tightening one would throttle the other. The same
 * reason ADR-019 §11 gave `widgetSession` its own class rather than the
 * session bucket.
 *
 * Twenty per hour, keyed by the verified user. Far past any real team's
 * onboarding rate — twenty new colleagues in an hour is a migration, not a
 * Tuesday — and far below what enumerating an address list needs, since each
 * twenty guesses costs one email-verified account and a full hour.
 */
export const MEMBER_INVITE_LIMIT = 20;
export const MEMBER_INVITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Ownership transfer: `POST /organizations/:organizationId/ownership`
 * (ADR-028 §11).
 *
 * Its own class rather than `authenticatedWrite`, for ADR-027 §12's reason
 * applied to a sharper case: this is the most destructive operation in the
 * product and by far the rarest. Sharing the 30/hour write budget would mean
 * ordinary widget-config edits could exhaust the transfer budget and vice
 * versa, and would make "someone is repeatedly attempting ownership
 * transfers" invisible in the limiter's own signal — the one pattern an
 * operator most wants to see.
 *
 * Five per hour, keyed by the verified user. A person transfers an
 * organization approximately once; five leaves room for a mistyped recipient
 * and a correction, and leaves none for thrashing the two-write sequence in
 * ADR-028 §8 in the hope of catching its window.
 *
 * NOT keyed by organization. The abuser here is an authenticated owner, and
 * keying on the tenant would let one busy organization's legitimate transfer
 * be blocked by another request against the same tenant — the shared-outage
 * shape ADR-019 §11 refused for `widgetSession`.
 */
export const OWNERSHIP_TRANSFER_LIMIT = 5;
export const OWNERSHIP_TRANSFER_WINDOW_MS = 60 * 60 * 1000;

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

// ---- the agent inbox (ADR-025 §5) ----

/**
 * Conversations returned per page when an agent does not specify `limit`.
 *
 * Deliberately NOT `MESSAGE_PAGE_DEFAULT_LIMIT`'s 30: an inbox row is a
 * summary a person scans, and a first screen of it is a different quantity
 * from a chat backlog's. Fifty fills a tall list without a second request
 * while staying well inside one indexed scan.
 */
export const CONVERSATION_PAGE_DEFAULT_LIMIT = 50;

/**
 * The most conversations a single page may request, regardless of `limit`.
 *
 * The same ceiling `MESSAGE_PAGE_MAX_LIMIT` sets, written as a reference so
 * the two cannot drift into disagreeing about how large "one page of a
 * tenant-scoped list" may be.
 */
export const CONVERSATION_PAGE_MAX_LIMIT = MESSAGE_PAGE_MAX_LIMIT;

// ---- Socket.IO real-time transport (ADR-023 §8) ----
//
// Policy-identical to two existing REST classes, counted in a SEPARATE
// in-memory store from `lib/rateLimit` — ADR-023 §8 states explicitly why
// that is a named gap rather than an oversight. Reusing the numbers rather
// than inventing new ones keeps one policy answer per traffic shape,
// regardless of which transport carries it.

/**
 * Socket handshake attempts: keyed by the connecting socket's IP address,
 * checked inside `io.use` before a connection is accepted.
 *
 * Reuses `WIDGET_SESSION_LIMIT`/`WIDGET_SESSION_WINDOW_MS` — the same shape
 * as the REST widget-session endpoint (unauthenticated-at-the-point-of-
 * limiting, IP-keyed, one relatively cheap operation per call).
 */
export const SOCKET_CONNECTION_LIMIT = WIDGET_SESSION_LIMIT;
export const SOCKET_CONNECTION_WINDOW_MS = WIDGET_SESSION_WINDOW_MS;

/**
 * `message:send` over a socket: keyed by the authenticated `customerId`.
 *
 * Reuses `WIDGET_CONVERSATION_WRITE_LIMIT`/`WIDGET_CONVERSATION_WRITE_WINDOW_MS`
 * verbatim — sending a message through a socket is the same traffic shape as
 * sending one over REST, not a different one that happens to use a different
 * wire format.
 */
export const SOCKET_MESSAGE_WRITE_LIMIT = WIDGET_CONVERSATION_WRITE_LIMIT;
export const SOCKET_MESSAGE_WRITE_WINDOW_MS = WIDGET_CONVERSATION_WRITE_WINDOW_MS;

// ---- session metadata ----

/**
 * Maximum stored User-Agent length. Shared across layers — the HTTP boundary
 * helper truncates to it and the session schema validates against it — so it
 * is owned here rather than by either one.
 */
export const MAX_USER_AGENT_LENGTH = 512;
