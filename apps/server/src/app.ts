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

  app.use(express.json());
  app.use(requestContext);

  app.use(healthRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
