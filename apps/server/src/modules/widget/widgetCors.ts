import type { RequestHandler } from "express";

/**
 * Minimal, per-route CORS for `/api/v1/widget/*` (ADR-021 §5).
 *
 * Closes the one gap ADR-019 §13 deliberately left open: the server-side
 * origin decision (`decideOrigin`, `allowedOrigins`) was already complete and
 * enforced on every request — what was missing was the response header that
 * lets a browser READ the answer. This file adds exactly that header, and
 * nothing that decides anything.
 *
 * The tenant-specific allow/deny decision still happens exactly where
 * ADR-019 built it, inside `widgetSession.service.ts`, using the `widgetKey`
 * the POST body carries. Nothing here consults `allowedOrigins` — reflecting
 * the caller's `Origin` grants no access by itself; it only makes an answer
 * the server was always going to give (success or the same opaque refusal)
 * legible to the page that asked for it.
 */

/**
 * Sets `Access-Control-Allow-Origin` (reflected, never `*`), `Vary: Origin`,
 * and overrides the global `same-origin` `Cross-Origin-Resource-Policy` to
 * `cross-origin` — the carve-out ADR-018 §9 named in advance for this exact
 * path prefix.
 *
 * Runs on every response this router produces, refusals included: a refusal
 * must be exactly as readable as a success, or the header's presence would
 * itself distinguish them — the same enumeration concern ADR-019 §12 already
 * settled for the response body.
 *
 * `Access-Control-Allow-Credentials` is never sent. The widget token travels
 * in the JSON body, never a cookie, so credentialed CORS is not merely
 * unneeded here — pairing it with a reflected origin is the specific
 * combination that would matter if this endpoint ever grew one.
 *
 * No `Origin` header (a non-browser caller) means nothing to reflect; the
 * header is simply omitted, exactly as `originPolicy.ts`'s own table treats
 * an absent `Origin` as "not a browser" rather than as a value to substitute.
 */
export const widgetCorsHeaders: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  if (origin !== undefined) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
};

/**
 * Answers a CORS preflight generically — the resolution to ADR-019 §13's
 * "a preflight cannot know the tenant."
 *
 * It does not need to. Answering "yes, attempt this" grants nothing: the
 * actual `POST` still runs the full per-tenant check inside
 * `widgetSession.service.ts`, using the widget key the preflight's own
 * bodyless `OPTIONS` request structurally cannot carry. This handler
 * performs no lookup and touches no database — there is no tenant to
 * resolve one from at this stage.
 *
 * `204` with no body, matching the response a preflight expects. Mounted
 * only on `OPTIONS /session`, never as a catch-all — an unrecognized method
 * or path under this router falls through to the ordinary 404 handling the
 * rest of the API gets.
 */
export const widgetPreflight: RequestHandler = (_req, res) => {
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.status(204).end();
};
