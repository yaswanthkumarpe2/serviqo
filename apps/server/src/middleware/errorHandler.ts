import type { NextFunction, Request, Response } from "express";

import { AppError } from "../lib/errors";
import { sendError, serverError } from "../lib/response";

/**
 * The single place that turns a thrown error into an HTTP response.
 * Known AppErrors are trusted (their message/code are safe to expose);
 * anything else is unexpected and collapsed to a generic 500 — the raw
 * error (with stack) is logged server-side only, never sent to the client.
 */
// `_next` is required positionally — Express only treats a 4-arg function as error middleware.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    req.log.warn({ err, code: err.code }, err.message);
    return sendError(res, err.httpStatus, err.code, err.message);
  }

  req.log.error({ err }, "Unhandled error");
  return serverError(res);
}
