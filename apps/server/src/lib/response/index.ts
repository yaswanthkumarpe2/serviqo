import type { ValidationIssue } from "../errors";
import type { Response } from "express";

/**
 * The one place every controller builds a response. Matches ADR-002's
 * envelope exactly:
 *   success: { success: true,  data, meta:  { requestId, timestamp, version } }
 *   failure: { success: false, error: { code, message, requestId, timestamp, version } }
 *
 * Failures may additionally carry `error.details` (ADR-007 §7) — an optional
 * key, present only on errors that have field-level issues to report. Every
 * other key is unconditional, so a client reading only code/message is
 * unaffected by whether it appears.
 */

const API_VERSION = "v1";

interface EnvelopeMeta {
  requestId: string;
  timestamp: string;
  version: string;
}

function buildMeta(res: Response): EnvelopeMeta {
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
  return { requestId, timestamp: new Date().toISOString(), version: API_VERSION };
}

export function success<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data, meta: buildMeta(res) });
}

export function created<T>(res: Response, data: T) {
  return success(res, data, 201);
}

/**
 * 204 with no body at all — the one deliberate exception to the envelope
 * (ADR-008 §1).
 *
 * Used where the response must carry no information beyond "accepted",
 * because any field would be a channel through which internal state leaks.
 * Correlation is not lost: requestContext has already set X-Request-Id and
 * X-Correlation-Id on the response headers.
 */
export function noContent(res: Response) {
  return res.status(204).end();
}

/** General-purpose error responder — errorHandler uses this for any AppError's own httpStatus/code. */
export function sendError(res: Response, status: number, code: string, message: string, details?: ValidationIssue[]) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      // Omitted entirely rather than sent as null or [] — an absent key and
      // an empty list would otherwise mean the same thing in two ways.
      ...(details && details.length > 0 ? { details } : {}),
      ...buildMeta(res),
    },
  });
}

export function badRequest(res: Response, message = "Bad request", code = "BAD_REQUEST") {
  return sendError(res, 400, code, message);
}

export function unauthorized(res: Response, message = "Unauthorized", code = "UNAUTHORIZED") {
  return sendError(res, 401, code, message);
}

export function forbidden(res: Response, message = "Forbidden", code = "FORBIDDEN") {
  return sendError(res, 403, code, message);
}

export function notFound(res: Response, message = "Not found", code = "NOT_FOUND") {
  return sendError(res, 404, code, message);
}

export function conflict(res: Response, message = "Conflict", code = "CONFLICT") {
  return sendError(res, 409, code, message);
}

export function serverError(res: Response, message = "Something went wrong", code = "INTERNAL_ERROR") {
  return sendError(res, 500, code, message);
}
