import express from "express";

import { resolveEmailProvider } from "./lib/email";
import { env } from "./lib/env";
import { createDisabledRateLimiters, createRateLimiters } from "./lib/rateLimit";
import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";
import { requestContext } from "./middleware/requestContext";
import { securityHeaders } from "./middleware/securityHeaders";
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
  /**
   * Whether the rate limiters actually refuse anything (ADR-018 §8).
   *
   * Defaults to off under `NODE_ENV=test`, because suites written before
   * this slice would otherwise fail for reasons unrelated to what they
   * assert — `auth.login.test.ts` deliberately makes eleven failed logins,
   * which is the credential limit by construction.
   *
   * The security suites pass `true` explicitly and exercise the real
   * middleware, store, and refusal path, so the limiter is not thereby
   * untested. It is disabled only where it would be noise.
   */
  rateLimiting?: boolean;
}

/**
 * Builds the Express app without starting it — kept separate from main.ts
 * so tests can exercise it directly with supertest, no listening socket
 * or database connection required.
 */
export function createApp({
  emailProvider = resolveEmailProvider(),
  rateLimiting = env.NODE_ENV !== "test",
}: CreateAppOptions = {}) {
  const app = express();

  /*
    `trust proxy` is deliberately NOT set, so it keeps Express's default of
    false (ADR-018 §7). `req.ip` is therefore the socket address and
    `X-Forwarded-For` is ignored entirely — which is what makes a forged
    forwarding header unable to buy a fresh rate-limit budget.

    Behind a reverse proxy this is wrong in the other direction: every
    request would appear to come from the proxy and all clients would share
    one bucket. Configuring that is a deployment prerequisite recorded in
    SECURITY.md §3, not something to guess at here.
  */

  // Headers first: they must be present on every response, including the
  // ones that never reach a route (404s, body-parser failures, 429s).
  app.use(securityHeaders());

  // requestContext next: body parsing can itself fail (malformed JSON,
  // oversized payload), and errorHandler needs req.log and a requestId to
  // answer those safely (ADR-007 §8). The rate limiter also logs through
  // req.log, so it must come after this.
  app.use(requestContext);
  app.use(express.json());

  app.use(healthRouter);

  /*
    Built per app instance rather than at module scope, so each instance owns
    its counters — one test suite cannot exhaust another's budget through
    shared module state, and production has exactly one instance anyway.
  */
  const rateLimiters = rateLimiting ? createRateLimiters() : createDisabledRateLimiters();

  app.use(createApiRouter({ emailProvider, rateLimiters }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
