import helmet from "helmet";

import { env } from "../lib/env";

import type { RequestHandler } from "express";

/**
 * Security response headers (ADR-018 §9).
 *
 * Configured for what this process actually serves: a JSON API, and nothing
 * else. `apps/web` is served by Vite in development and would be a static
 * host in production — no HTML leaves this server, so helmet's document-
 * oriented defaults are wrong here in both directions and are replaced
 * rather than accepted.
 *
 * IMPORTANT for the widget slice (ADR-010 §8–9): everything below applies to
 * API RESPONSES. The widget's HTML document does not exist yet and must be
 * framed by tenant sites to work at all. When it ships it needs its own
 * headers — served from its own origin, or from a route that overrides this
 * policy. Nothing here forecloses that, and it is called out because
 * applying a blanket `frame-ancestors 'none'` to the whole application later
 * would silently make the widget architecture impossible.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    /*
      A JSON response should load nothing and be framed by nothing. helmet's
      default policy names script/style/img sources, which is meaningful for
      a document and meaningless for `application/json` — and would be
      actively wrong if this server ever served the SPA, because it would
      break Vite's inline bootstrap.

      `frame-ancestors 'none'` here is about API responses. See the module
      note above for the widget.
    */
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },

    /*
      Only meaningful over HTTPS, which development does not use. Enabled in
      production only: a stray HSTS pin issued to `localhost` outlives the
      experiment that set it and breaks every other local project on that
      host.
    */
    strictTransportSecurity:
      env.NODE_ENV === "production"
        ? { maxAge: 15552000, includeSubDomains: true, preload: false }
        : false,

    /*
      API URLs carry organization ids (ADR-017 §1). None of that belongs in a
      `Referer` header sent to a third party.
    */
    referrerPolicy: { policy: "no-referrer" },

    /*
      Correct while every caller is same-origin — `vite.config.ts` proxies
      `/api`, so the browser sees one origin. The widget slice revisits this
      alongside CORS for `/api/v1/widget/*`, which will need `cross-origin`
      (ADR-018 §9).
    */
    crossOriginResourcePolicy: { policy: "same-origin" },

    /*
      Redundant with `frame-ancestors` for modern browsers and retained for
      older ones. helmet's default is already DENY; stated explicitly because
      the widget carve-out above depends on knowing this is set.
    */
    frameguard: { action: "deny" },

    // Stops a browser reinterpreting a JSON error body as HTML.
    noSniff: true,

    // Free version disclosure, sent by Express until now.
    hidePoweredBy: true,
  });
}
