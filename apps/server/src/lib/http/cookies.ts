/**
 * Reads one named cookie from a raw `Cookie` header.
 *
 * Deliberately a helper rather than app-wide middleware (ADR-012 §2). The
 * refresh cookie is `Path`-scoped to `/api/v1/auth` so it never travels with
 * unrelated requests; a global parser would undo that on the server side by
 * making every health check and every future endpoint parse a credential
 * header it has no business touching. One caller, one call site.
 *
 * The failure mode is safe by construction: this can only fail to find a
 * value, never invent one. What consumes the result compares a SHA-256 digest
 * against a stored one, so "parsed wrong" and "no cookie" both end at the
 * same 401.
 */

const COOKIE_SEPARATOR = ";";
const NAME_VALUE_SEPARATOR = "=";

/**
 * `res.cookie` encodes values with `encodeURIComponent`, so reading decodes.
 *
 * Malformed percent-escapes make `decodeURIComponent` throw, and a header is
 * attacker-controlled input — a hand-typed `%` must not become a 500. The raw
 * value is returned instead: it will simply fail to match a stored hash,
 * which is the correct answer for a cookie nothing here issued.
 */
function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Returns the value of `name`, or `undefined` when the header is absent or
 * carries no such cookie.
 *
 * Names are compared exactly. Splitting on the FIRST `=` matters: base64url
 * padding is absent by design (`lib/crypto/tokens`), but a value is opaque
 * here and must survive whatever it contains.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string" || header.length === 0) return undefined;

  for (const pair of header.split(COOKIE_SEPARATOR)) {
    const separatorIndex = pair.indexOf(NAME_VALUE_SEPARATOR);
    if (separatorIndex < 0) continue;

    if (pair.slice(0, separatorIndex).trim() !== name) continue;

    // A cookie may legitimately be present and empty; that is not a match
    // worth returning, since an empty credential can never validate.
    const value = decodeValue(pair.slice(separatorIndex + 1).trim());
    return value.length > 0 ? value : undefined;
  }

  return undefined;
}
