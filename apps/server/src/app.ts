import express from "express";

import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";
import { requestContext } from "./middleware/requestContext";
import { healthRouter } from "./routes/health.routes";

/**
 * Builds the Express app without starting it — kept separate from main.ts
 * so tests can exercise it directly with supertest, no listening socket
 * or database connection required.
 */
export function createApp() {
  const app = express();

  // requestContext first: body parsing can itself fail (malformed JSON,
  // oversized payload), and errorHandler needs req.log and a requestId to
  // answer those safely (ADR-007 §8).
  app.use(requestContext);
  app.use(express.json());

  app.use(healthRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
