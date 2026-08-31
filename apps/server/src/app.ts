import path from "node:path";

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

/**
 * The built React app, served by this same process so Render can run the
 * whole deployment as one web service. `apps/web/dist` sits next to
 * `apps/server` regardless of whether this file is running as TS source
 * (`apps/server/src/app.ts`, dev) or compiled output
 * (`apps/server/dist/app.js`, production) — `src` and `dist` are siblings
 * at the same depth, so the relative path up to `apps/web/dist` is
 * identical either way.
 */
const webDistPath = path.join(__dirname, "../../web/dist");
const webIndexPath = path.join(webDistPath, "index.html");

/**
 * True for any path this app already owns an answer for — the REST API,
 * the Socket.IO handshake, and the health check. The static file server and
 * SPA fallback below must never claim one of these, or an unmatched
 * `/api/v1/...` request would silently become `index.html` (200, wrong
 * content-type, and no more JSON 404) instead of falling through to
 * `notFound`.
 */
function isAppOwnedPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/socket.io" ||
    pathname.startsWith("/socket.io/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  );
}

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
    `trust proxy` stays at Express's default of false in development and
    test (ADR-018 §7): with no reverse proxy in front of the process,
    `req.ip` is the socket address and `X-Forwarded-For` is ignored
    entirely — which is what makes a forged forwarding header unable to buy
    a fresh rate-limit budget.

    Behind a reverse proxy this would be wrong in the other direction: every
    request would appear to come from the proxy and all clients would share
    one bucket. Production sits behind exactly one such hop — Render's edge
    — so trust proxy is set to the exact hop count, 1, never `true` (which
    would trust the whole forwarded chain and let any client forge
    X-Forwarded-For to buy a fresh budget). This is the deployment
    prerequisite SECURITY.md §3 documents.
  */
  if (env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

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

  /*
    Serves the built React app so one process can be Render's whole web
    service — the dashboard's own routes (`/organizations`, `/inbox`, ...)
    exist only in the browser router, so any of them must still resolve to
    `index.html` on a hard refresh rather than 404.

    Production only, same reasoning as `trust proxy` above: development runs
    the frontend on Vite's own dev server (see `apps/web/vite.config.ts`'s
    proxy setup), and `apps/web/dist` is not part of the test suite's
    contract — mounting this unconditionally would make `GET /no-such-route`
    silently start returning `index.html` instead of the JSON 404 the API
    test suite asserts, the moment someone happens to have run a web build
    locally.

    `isAppOwnedPath` keeps this from ever answering for `/api`, `/socket.io`,
    or `/health`: express.static simply calls `next()` when it finds no
    matching file, but an unmatched API path must fall through to the JSON
    404 below, not to a static-file lookup under `apps/web/dist`.
  */
  if (env.NODE_ENV === "production") {
    app.use((req, res, next) => {
      if (isAppOwnedPath(req.path)) return next();
      express.static(webDistPath)(req, res, next);
    });

    app.use((req, res, next) => {
      if (
        isAppOwnedPath(req.path) ||
        (req.method !== "GET" && req.method !== "HEAD") ||
        // A dot in the final path segment means this was a request for a
        // FILE (`/assets/index-abc123.js`, `/favicon.ico`, ...), not a
        // client-side route. `express.static` above already had its chance
        // at it; a miss here means the file genuinely doesn't exist and
        // must 404 for real — rewriting it to `index.html` would hand the
        // browser an HTML document where it expected a script or a
        // stylesheet.
        path.extname(req.path) !== ""
      ) {
        return next();
      }
      /*
        No `apps/web/dist` — the build step was skipped somehow — falls
        through to the same JSON 404 as any other unmatched route, rather
        than erroring.
      */
      res.sendFile(webIndexPath, (err) => {
        if (err) next();
      });
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
