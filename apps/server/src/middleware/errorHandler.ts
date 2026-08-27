import type { NextFunction, Request, Response } from "express";

import { AppError, ValidationError } from "../lib/errors";
import { sendError, serverError } from "../lib/response";

/**
 * Body-parser (inside `express.json()`) rejects a request before any route
 * middleware runs, so these failures never reach a schema. They are client
 * errors, and answering them with a generic 500 would tell a caller its own
 * malformed request was a server fault.
 *
 * Body-parser's own `message` is deliberately discarded rather than
 * forwarded: a JSON syntax error quotes the offending fragment of the
 * request body, and on an auth endpoint that fragment can be the password
 * (ADR-007 §8). Each failure type gets a fixed message instead.
 */
const BODY_PARSER_FAILURES: Record<string, { status: number; code: string; message: string }> = {
  "entity.parse.failed": { status: 400, code: "MALFORMED_JSON", message: "Request body is not valid JSON" },
  "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
  "encoding.unsupported": { status: 415, code: "UNSUPPORTED_ENCODING", message: "Unsupported content encoding" },
  "charset.unsupported": { status: 415, code: "UNSUPPORTED_CHARSET", message: "Unsupported character set" },
};

function asBodyParserFailure(err: unknown) {
  if (typeof err !== "object" || err === null) return undefined;
  const { type } = err as { type?: unknown };
  return typeof type === "string" ? BODY_PARSER_FAILURES[type] : undefined;
}

/**
 * The single place that turns a thrown error into an HTTP response.
 * Known AppErrors are trusted (their message/code are safe to expose);
 * anything else is unexpected and collapsed to a generic 500 — the raw
 * error (with stack) is logged server-side only, never sent to the client.
 */
// `_next` is required positionally — Express only treats a 4-arg function as error middleware.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const bodyParserFailure = asBodyParserFailure(err);
  if (bodyParserFailure) {
    // The error object itself is not logged: it carries the same body
    // fragment its message does.
    req.log.warn({ code: bodyParserFailure.code }, bodyParserFailure.message);
    return sendError(res, bodyParserFailure.status, bodyParserFailure.code, bodyParserFailure.message);
  }

  if (err instanceof AppError) {
    req.log.warn({ err, code: err.code }, err.message);
    // Only ValidationError carries field-level detail today. Checked
    // explicitly rather than via an optional `details` member on AppError,
    // so no error class grows a field nothing populates.
    const details = err instanceof ValidationError ? err.details : undefined;
    return sendError(res, err.httpStatus, err.code, err.message, details);
  }

  req.log.error({ err }, "Unhandled error");
  return serverError(res);
}
