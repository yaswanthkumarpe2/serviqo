import helmet from "helmet";

import { env } from "../lib/env";
import { isAppOwnedPath } from "../lib/http/appOwnedPath";

import type { HelmetOptions } from "helmet";
import type { RequestHandler } from "express";

/**
 * Security response headers (ADR-018 §9).
 *
 * This process serves three different kinds of thing, and one policy cannot
 * be right for all of them:
 *
 *   1. the JSON API (`/api`, `/socket.io`, `/health`), which should load
 *      nothing and be framed by nothing;
 *   2. in production, the built React app — `index.html` and the hashed
 *      bundles under `/assets` (see `app.ts`) — which is a document, and must
 *      be allowed to load its own script and stylesheet;
 *   3. `/widget.js`, whose entire purpose is to be loaded by tenant sites on
 *      other origins (ADR-021 §1).
 *
 * The earlier version of this file was written when only (1) existed, and
 * said so. It stopped being true when `app.ts` began serving `apps/web/dist`
 * with an `index.html` fallback: `default-src 'none'` is exactly right for
 * `application/json` and forbids an HTML document its own bundle. That never
 * surfaced in development, because there Vite serves the frontend and this
 * server sends no HTML at all — the one environment where the bug cannot
 * appear is the one we develop in.
 *
 * So the policy is chosen per request, by the same classifier `app.ts` uses
 * to decide who answers.
 */

/**
 * Everything that does not depend on what is being served.
 */
const sharedOptions = {
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
    Redundant with `frame-ancestors` for modern browsers and retained for
    older ones. helmet's default is already DENY; stated explicitly because
    it is part of the policy, not an accident of the default.
  */
  frameguard: { action: "deny" },

  // Stops a browser reinterpreting a JSON error body as HTML.
  noSniff: true,

  // Free version disclosure, sent by Express until now.
  hidePoweredBy: true,
} satisfies HelmetOptions;

/**
 * The API. Unchanged, and correct as it always was.
 *
 * A JSON response should load nothing and be framed by nothing. helmet's
 * default policy names script/style/img sources, which is meaningful for a
 * document and meaningless for `application/json`.
 */
const apiHeaders = helmet({
  ...sharedOptions,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "same-origin" },
});

/**
 * The directives the built React app needs to render, and nothing beyond
 * them. `default-src 'none'` stays as the floor, so anything not named below
 * — a worker, a plugin, a manifest — is still denied.
 */
const documentDirectives = {
  "default-src": ["'none'"],

  /*
    The real security value of this policy, and the reason it is worth
    writing by hand rather than accepting helmet's defaults. `vite build`
    emits no inline script — `dist/index.html` carries a single
    `<script type="module" src="/assets/index-*.js">` and nothing else — so
    `'self'` alone is enough, with no `'unsafe-inline'` and no nonce
    machinery to maintain.
  */
  "script-src": ["'self'"],

  /*
    `'unsafe-inline'` here is a deliberate concession, stated rather than
    slipped in: the widget builds its shadow-root stylesheet as a `<style>`
    element at runtime (`apps/web/src/widget/styles.ts`), and React writes
    inline `style` attributes. Injected CSS is a far smaller problem than
    injected script, and `script-src` above stays locked either way.

    `fonts.googleapis.com` is the stylesheet `index.html` links for the three
    webfont families.
  */
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],

  // The font files that Google stylesheet then points at.
  "font-src": ["https://fonts.gstatic.com"],

  "img-src": ["'self'", "data:"],

  // Covers both the REST API and the same-origin Socket.IO upgrade: one
  // process serves the app and the API, so there is no second host to name.
  "connect-src": ["'self'"],

  "frame-ancestors": ["'none'"],
  "base-uri": ["'none'"],

  // Unlike the API's `'none'`: the dashboard is a document with real forms.
  "form-action": ["'self'"],
} as const;

/**
 * The HTML document and the assets it references.
 */
const documentHeaders = helmet({
  ...sharedOptions,
  contentSecurityPolicy: { useDefaults: false, directives: documentDirectives },
  crossOriginResourcePolicy: { policy: "same-origin" },
});

/**
 * `/widget.js`.
 *
 * Identical to the document policy but for CORP: `same-origin` blocks
 * precisely the thing this file exists to do. A tenant embedding the loader
 * on their own site is the supported case (ADR-021 §1), and under
 * `same-origin` it would work only on our own origin — which is why it works
 * against `widget-test.html` locally and would fail on a real customer's
 * site.
 */
const widgetHeaders = helmet({
  ...sharedOptions,
  contentSecurityPolicy: { useDefaults: false, directives: documentDirectives },
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

/** The widget loader, at the path `vite.widget.config.ts` emits it to. */
const WIDGET_SCRIPT_PATH = "/widget.js";

export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    if (isAppOwnedPath(req.path)) return apiHeaders(req, res, next);
    if (req.path === WIDGET_SCRIPT_PATH) return widgetHeaders(req, res, next);
    return documentHeaders(req, res, next);
  };
}
