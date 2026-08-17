export { AppError } from "./AppError";

import { AppError } from "./AppError";

/**
 * Only the error classes an existing slice actually throws live here.
 * AuthenticationError, AuthorizationError, TenantIsolationError, etc. get
 * added in the slices that throw them.
 */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

/**
 * One rejected field. `field` is the dotted path into the request body
 * (`"email"`, `"profile.name"`, `"members.0.role"`).
 *
 * There is deliberately no `value`/`received` member: the rejected input is
 * routinely the thing that must not be echoed — a password that failed the
 * length rule, an address typed into the wrong box — and a response body
 * ends up in client logs, error trackers, and browser history (ADR-007 §7).
 */
export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Malformed request input, rejected at the HTTP boundary before any handler
 * runs (see middleware/validate.ts). Business rules that need database state
 * — email already taken, token expired — are NOT validation failures and get
 * their own error classes.
 */
export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = "VALIDATION_ERROR";
  readonly details: ValidationIssue[];

  constructor(message: string, details: ValidationIssue[] = []) {
    super(message);
    this.details = details;
  }
}

/**
 * Registration was attempted with an address that already has an account.
 *
 * Serviqo answers this specifically rather than generically, accepting that
 * it discloses whether an address is registered — see ADR-007 §1 for why,
 * and for why login and forgot-password must stay generic.
 */
export class EmailAlreadyExistsError extends AppError {
  readonly httpStatus = 409;
  readonly code = "EMAIL_ALREADY_EXISTS";
}

/**
 * Authentication failed — and deliberately does not say how (ADR-011 §3).
 *
 * Unknown address, wrong password, locked account, and disabled account all
 * raise this same error with the same message. Naming the reason would tell
 * an unauthenticated caller whether an address has an account, which is
 * exactly what ADR-007 §1 committed login to withholding.
 */
export class InvalidCredentialsError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_CREDENTIALS";
}

/**
 * The credentials were correct but the address has never been verified
 * (ADR-011 §6).
 *
 * This is the one authentication refusal that is not generic, and it is safe
 * because it is unreachable without a correct password — so it discloses
 * nothing the caller did not already know. It is named specifically because
 * it is the only refusal with a self-service remedy
 * (`POST /auth/resend-verification`), and a caller cannot be expected to
 * guess that.
 */
export class EmailNotVerifiedError extends AppError {
  readonly httpStatus = 403;
  readonly code = "EMAIL_NOT_VERIFIED";
}

/**
 * A verification token could not be redeemed — and deliberately does not say
 * why (ADR-009 §1).
 *
 * Invalid, expired, already consumed, fabricated, and belonging-to-a-deleted-
 * user all raise this same error with the same message. "Expired" would
 * confirm the token was once real, and "already consumed" would confirm the
 * address is verified; either turns a link into an account-existence probe
 * for whoever holds it.
 */
export class InvalidVerificationTokenError extends AppError {
  readonly httpStatus = 400;
  readonly code = "INVALID_VERIFICATION_TOKEN";
}

/**
 * A refresh token could not be exchanged — and deliberately does not say why
 * (ADR-012 §3).
 *
 * Absent cookie, malformed token, unknown session, expired session, revoked
 * session, unknown secret, replayed secret, a concurrent rotation that lost,
 * and an account no longer entitled to refresh all raise this one error with
 * one message.
 *
 * The distinctions matter most where they are least safe to make: "this
 * session was revoked" would confirm a real session exists at that id, and
 * "replayed" would tell whoever stole the token that the theft was noticed.
 * The endpoint has exactly two observable outcomes, and this is the one that
 * is not success.
 */
export class InvalidRefreshTokenError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_REFRESH_TOKEN";
}

/**
 * A request did not present a usable access token — and deliberately does not
 * say which part failed (ADR-015 §6).
 *
 * Absent header, malformed header, wrong scheme, bad signature, expired,
 * wrong issuer, wrong audience, a user who no longer exists, and a disabled
 * account all raise this one error with one message.
 *
 * "Expired" is the tempting exception and is refused with the rest: the
 * legitimate client already knows its own expiry, so the distinction helps
 * only whoever is probing with a token they were not given — to them,
 * "expired" confirms it was once real. "No such user" and "disabled" are
 * withheld for the reason ADR-011 §6 withheld a disabled account from a
 * caller holding its password; confirming it to one holding a token is
 * strictly worse.
 *
 * The first error in this file thrown by middleware rather than a service.
 */
export class InvalidAccessTokenError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_ACCESS_TOKEN";
}

/**
 * The caller has made too many requests for the class of endpoint they are
 * using (ADR-018 §6).
 *
 * One message for every limiter class. It names no limit, no window, no
 * route class, and no remaining budget — those are facts about Serviqo's
 * defences rather than about this caller, the same reasoning that kept the
 * required permission out of ADR-017 §6's 403.
 *
 * It also discloses nothing about accounts. The credential limiter is keyed
 * by IP and never by submitted email (ADR-018 §5), so this response is
 * identical whether the address in the body exists or not.
 *
 * `Retry-After` and `RateLimit` headers accompany it. Those are standards-
 * track, they let an honest client back off instead of hammering, and the
 * window length is not a secret — an attacker learns it by waiting.
 */
export class TooManyRequestsError extends AppError {
  readonly httpStatus = 429;
  readonly code = "TOO_MANY_REQUESTS";
}

/**
 * The caller may not reach this organization — and deliberately does not
 * learn which of several reasons applies (ADR-017 §6).
 *
 * The organization does not exist, is suspended, the caller is not a member,
 * their membership is still `invited`, or it has been `suspended`: one
 * response, one message, one status.
 *
 * A `403` here would confirm the organization exists, turning any
 * authenticated account into an oracle for which tenant ids are real — and,
 * with a guessable slug, for whether a named company uses Serviqo. That is
 * the enumeration reasoning ADR-009 §1, ADR-011 §3, ADR-012 §3 and ADR-015 §6
 * each applied in turn, and a tenant's existence is the kind of fact
 * SECURITY.md §2 keeps inside its own boundary.
 *
 * Contrast `InsufficientPermissionError` below, which answers a caller whose
 * membership is already proved.
 */
export class OrganizationNotAccessibleError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

/**
 * The caller is a member of this organization, and their role does not hold
 * the permission this route requires (ADR-017 §6).
 *
 * Specific, unlike every other refusal in this file, and safely so:
 * `requireOrganization` has already proved membership by the time this can be
 * raised, so the caller demonstrably knows the organization exists and works
 * there. Withholding "your role cannot do this" from them would disclose
 * nothing and only make the product confusing.
 */
export class InsufficientPermissionError extends AppError {
  readonly httpStatus = 403;
  readonly code = "INSUFFICIENT_PERMISSION";
}

/**
 * Every slug derived from a submitted organization name was already taken or
 * reserved, within the bounded number of attempts onboarding will make
 * (ADR-016 §7).
 *
 * Effectively unreachable — it needs many organizations whose names slugify
 * identically — and named specifically anyway, because the alternative is an
 * unbounded retry against a contended name, which is a request that never
 * returns. A caller resolves it by choosing a different name.
 *
 * Not an enumeration concern: slugs are public URL segments by construction,
 * and this endpoint is authenticated besides (ADR-016 §8).
 */
export class OrganizationSlugUnavailableError extends AppError {
  readonly httpStatus = 409;
  readonly code = "ORGANIZATION_SLUG_UNAVAILABLE";
}
