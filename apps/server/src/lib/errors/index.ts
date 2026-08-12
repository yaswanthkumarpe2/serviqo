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
