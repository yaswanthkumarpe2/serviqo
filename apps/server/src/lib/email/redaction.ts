/**
 * Redaction helpers for development email logging.
 *
 * These exist because Pino's `redact` paths match on *field names*
 * (`*.token`, `*.resetToken`, ...). A secret sitting inside a URL string —
 * `http://localhost:5173/verify-email?token=SECRET` — is just a string value
 * and would sail straight through that filter into the log. So the value has
 * to be reduced to something safe *before* it is ever handed to the logger.
 */

/**
 * The only action categories that may appear in a log. A closed set of
 * compile-time literals, never a caller-supplied string.
 */
export type EmailActionCategory = "verify-email" | "password-reset" | "invitation" | "unknown";

/** A URL reduced to information that cannot contain a secret. */
export interface RedactedActionUrl {
  /** Scheme, host, and port only — structurally incapable of carrying a token. */
  origin: string;
  /** Which known email action this link corresponds to. Never raw path text. */
  action: EmailActionCategory;
  /** Whether a `token` query parameter was present — the value is never captured. */
  hasToken: boolean;
}

const UNPARSEABLE_ORIGIN = "(unparseable)";

/** Action links are always web URLs; anything else is not something we can reason about safely. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Exact pathnames that map to a known email action. Extended when a route is
 * finalized — an unlisted path simply classifies as "unknown", which is the
 * safe direction to be wrong in.
 */
const KNOWN_EMAIL_ACTIONS: ReadonlyMap<string, EmailActionCategory> = new Map([
  ["/verify-email", "verify-email"],
  ["/reset-password", "password-reset"],
  ["/accept-invitation", "invitation"],
  ["/invitations", "invitation"],
]);

/**
 * Reduces a pathname to one of a fixed set of categories.
 *
 * Matching is exact (after lowercasing and dropping one trailing slash), so
 * `/verify-email/SECRET` does NOT match `/verify-email` — it falls through to
 * "unknown". That is the entire point: the return value is always one of four
 * compile-time literals, so no caller-controlled substring can reach a log
 * regardless of what the path contains.
 */
function classifyPath(pathname: string): EmailActionCategory {
  const normalized = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return KNOWN_EMAIL_ACTIONS.get(normalized) ?? "unknown";
}

/**
 * Reduces an email action URL to origin + action category + a boolean.
 *
 * This boundary fails closed rather than trusting callers. An earlier version
 * logged `url.pathname` verbatim, which was safe only while every caller
 * remembered to keep secrets in the query string — a convention that a future
 * route like `/verify-email/SECRET_TOKEN` would silently violate. Nothing
 * derived from the path is emitted now; only a closed-set category is.
 *
 * Query parameter *values* and fragments are likewise never inspected or
 * echoed, because that is where the secret normally lives.
 *
 * The protocol allowlist is also load-bearing: `new URL()` accepts far more
 * than web links, and `garbage::SECRET` parses happily as scheme `garbage:`
 * with the whole secret as its pathname.
 *
 * A malformed URL must not crash the caller — development logging is a
 * diagnostic side-effect and can never fail a real operation. The fallback
 * refuses to echo the offending input, since a string that failed to parse
 * can still hold a live token.
 */
export function describeActionUrl(rawUrl: string): RedactedActionUrl {
  try {
    const url = new URL(rawUrl);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return { origin: UNPARSEABLE_ORIGIN, action: "unknown", hasToken: false };
    }
    return {
      origin: url.origin,
      action: classifyPath(url.pathname),
      hasToken: url.searchParams.has("token"),
    };
  } catch {
    return { origin: UNPARSEABLE_ORIGIN, action: "unknown", hasToken: false };
  }
}

/**
 * Masks a recipient address for logs: `yaswanth@example.com` → `y***@example.com`.
 *
 * SECURITY.md sets no explicit policy on logging email addresses, so this
 * minimizes PII by default while keeping enough signal to correlate a log
 * line with a support report. The domain is preserved because it identifies
 * an organization rather than a person.
 *
 * Anything that is not a recognizable address is reduced to `***` rather than
 * echoed back — a malformed value is exactly the case where blindly logging
 * the input could surface something unintended.
 */
export function maskEmailAddress(address: string): string {
  const separatorIndex = address.lastIndexOf("@");
  if (separatorIndex < 1) return "***";

  const domain = address.slice(separatorIndex + 1);
  if (domain.length === 0) return "***";

  return `${address[0]}***@${domain}`;
}
