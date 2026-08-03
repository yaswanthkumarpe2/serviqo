import type { NextFunction, Request, Response } from "express";

import { createId } from "../lib/ids";
import { logger } from "../lib/logger";

/**
 * Assigns requestId (and reserves correlationId for future cross-service
 * propagation — no distributed tracing yet, just making sure a later
 * service can pass one through without touching this middleware) to every
 * request, binds them to a child logger on req.log, and logs start/finish.
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incomingRequestId = req.headers["x-request-id"];
  const requestId = typeof incomingRequestId === "string" && incomingRequestId ? incomingRequestId : createId();

  const incomingCorrelationId = req.headers["x-correlation-id"];
  const correlationId =
    typeof incomingCorrelationId === "string" && incomingCorrelationId ? incomingCorrelationId : requestId;

  res.locals.requestId = requestId;
  res.locals.correlationId = correlationId;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Correlation-Id", correlationId);

  req.log = logger.child({ requestId, correlationId });

  const startedAt = Date.now();
  req.log.info({ method: req.method, url: req.originalUrl }, "request started");
  res.on("finish", () => {
    req.log.info(
      { method: req.method, url: req.originalUrl, statusCode: res.statusCode, durationMs: Date.now() - startedAt },
      "request completed",
    );
  });

  next();
}
