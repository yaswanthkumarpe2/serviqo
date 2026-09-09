/**
 * True for any path this app already owns an answer for — the REST API, the
 * Socket.IO handshake, and the health check.
 *
 * Two callers, for two reasons that happen to need the same line drawn.
 *
 * `app.ts` uses it so the static file server and SPA fallback never claim one
 * of these: an unmatched `/api/v1/...` request must fall through to the JSON
 * 404 rather than silently become `index.html` (200, wrong content-type, and
 * no more JSON error).
 *
 * `securityHeaders.ts` uses it to pick a response policy, because "is this a
 * JSON response or an HTML one" is the same question. It lives here rather
 * than being exported from `app.ts` only because `app.ts` imports
 * `securityHeaders` — the other direction would be a cycle.
 */
export function isAppOwnedPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/socket.io" ||
    pathname.startsWith("/socket.io/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  );
}
