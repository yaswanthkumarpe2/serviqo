import express from "express";

import { resolveEmailProvider } from "./lib/email";
import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";
import { requestContext } from "./middleware/requestContext";
import { createApiRouter } from "./routes/api.routes";
import { healthRouter } from "./routes/health.routes";

import type { EmailProvider } from "./lib/email/emailProvider";

export interface CreateAppOptions {
  /**
   * Injected by tests. Left unset, the environment decides — which is also
   * where production's fail-fast guard lives, so constructing the app is the
   * moment a misconfigured production deployment stops (ADR-007 §10).
   */
  emailProvider?: EmailProvider;
}

/**
 * Builds the Express app without starting it — kept separate from main.ts
 * so tests can exercise it directly with supertest, no listening socket
 * or database connection required.
 */
export function createApp({ emailProvider = resolveEmailProvider() }: CreateAppOptions = {}) {
  const app = express();

  // requestContext first: body parsing can itself fail (malformed JSON,
  // oversized payload), and errorHandler needs req.log and a requestId to
  // answer those safely (ADR-007 §8).
  app.use(requestContext);
  app.use(express.json());

  app.use(healthRouter);
  app.use(createApiRouter({ emailProvider }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
