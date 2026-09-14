import { ValidationError } from "../lib/errors";

import type { ValidationIssue } from "../lib/errors";
import type { RequestHandler } from "express";
import type { ZodError, ZodType } from "zod";

/**
 * Request input validation at the HTTP boundary (ADR-007 §6).
 *
 * A route declares its schema in its own definition:
 *
 *   router.post("/login", validateBody(loginSchema), controller.login);
 *
 * so "does this route validate its input?" is answered by reading the route
 * file, not by auditing the handler. The handler never runs on invalid input,
 * and services below it take already-validated arguments — they enforce
 * business rules (email taken, token expired), not shape.
 *
 * Only `validateBody` exists: no route has a parameterized path or a query
 * string yet. A future `validateQuery` cannot mirror this one exactly —
 * Express 5 exposes `req.query` through a getter with no setter, so it must
 * write its parsed result somewhere other than `req.query`.
 */

/** Reported when the failure has no path of its own — a non-object body, typically. */
const ROOT_FIELD = "body";

/**
 * Flattens Zod issues into the wire shape. Only the path and Zod's own
 * message survive; the rejected value never does (ADR-007 §7). Path segments
 * may be numeric for arrays, giving `members.0.role`.
 */
function toValidationIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join(".") : ROOT_FIELD,
    message: issue.message,
  }));
}

/**
 * Parses `req.body` with `schema`, replacing it with the parsed result.
 *
 * The replacement is the point, not a side effect: Zod object schemas strip
 * unrecognized keys, so a client cannot smuggle an extra field through to a
 * service — mass assignment is structurally impossible rather than something
 * every service has to remember to guard against.
 */
export function validateBody<Output>(schema: ZodType<Output>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(new ValidationError("Request validation failed", toValidationIssues(result.error)));
      return;
    }

    req.body = result.data;
    next();
  };
}
