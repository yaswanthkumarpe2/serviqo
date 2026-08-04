/**
 * Redaction helpers for development email logging.
 *
 * These exist because Pino's `redact` paths match on *field names*
 * (`*.token`, `*.resetToken`, ...). A secret sitting inside a URL string —
 * `http://localhost:5173/verify-email?token=SECRET` — is just a string value
 * and would sail straight through that filter into the log. So the value has
 * to be reduced to something safe *before* it is ever handed to the logger.
 */

/** A URL reduced to information that cannot contain a secret. */
export interface RedactedActionUrl {
  /** Scheme, host, and port only — never carries credentials. */
  origin: string;
  /** Pathname only. Identifies which email action this was. */
  path: string;
  /** Whether a `token` query parameter was present — the value is never captured. */
  hasToken: boolean;
}

const UNPARSEABLE = "(unparseable)";

/** Action links are always web URLs; anything else is not something we can reason about safely. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Reduces an email action URL to origin + pathname + a boolean.
 *
 * Query parameter *values* and fragments are dropped entirely, never
 * inspected or echoed, because that is exactly where the secret lives.
 *
 * The protocol allowlist is load-bearing, not decoration. `new URL()` accepts
 * far more than web links: `garbage::SECRET` parses happily as scheme
 * `garbage:` with the whole secret sitting in `pathname`, which would then be
 * logged verbatim. Restricting to http/https means a value only reaches the
 * pathname branch when it is genuinely a web link of the shape we issue.
 *
 * This relies on the contract that action tokens travel in the *query string*
 * (`/verify-email?token=...`), matching the approved frontend routes. Callers
 * must not put a secret in the path.
 *
 * A malformed URL must not crash the caller: development logging is a
 * diagnostic side-effect and can never be allowed to fail a real operation.
 * The fallback also refuses to echo the offending input, since a string that
 * failed to parse may still contain a token.
 */
export function describeActionUrl(rawUrl: string): RedactedActionUrl {
  try {
    const url = new URL(rawUrl);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return { origin: UNPARSEABLE, path: UNPARSEABLE, hasToken: false };
    }
    return {
      origin: url.origin,
      path: url.pathname,
      hasToken: url.searchParams.has("token"),
    };
  } catch {
    return { origin: UNPARSEABLE, path: UNPARSEABLE, hasToken: false };
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
