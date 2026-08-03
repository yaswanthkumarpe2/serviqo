import type { NextFunction, Request, Response } from "express";

import { NotFoundError } from "../lib/errors";

/** Unmatched routes flow through the same AppError -> errorHandler pipeline as every other error. */
export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`));
}
