export { AppError } from "./AppError";

import { AppError } from "./AppError";

/**
 * Only the error classes an existing slice actually throws live here.
 * ValidationError, AuthenticationError, AuthorizationError, ConflictError,
 * TenantIsolationError, etc. get added in the slices that throw them.
 */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}
