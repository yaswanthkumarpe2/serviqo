import { randomBytes } from "node:crypto";

import { WIDGET_KEY_BYTES, WIDGET_KEY_PREFIX } from "../../config/constants";

/**
 * An organization's public widget configuration (ADR-019 §9–§10).
 *
 * Two values, both tenant configuration rather than credentials: the key that
 * says which tenant a public page belongs to, and the list of websites
 * permitted to embed that tenant's widget.
 *
 * Deliberately NOT in `lib/crypto/tokens.ts`. That module's header states its
 * scope — "these values are credentials: different security tier, different
 * review expectations" — and a widget key is the opposite of a credential: it
 * is printed in every tenant's page source on purpose. Filing it beside
 * refresh secrets would misrepresent both.
 */

/**
 * Mints a widget key: `wk_` followed by 43 base64url characters.
 *
 * `randomBytes` rather than anything derived. A key derived from the slug
 * would be a public value dressed as a random one, and a key derived from
 * `_id` would publish an internal MongoDB identifier into every tenant's page
 * source, where it becomes an input to every future id-guessing attempt
 * (ADR-019 §9).
 *
 * base64url (RFC 4648 §5) contains no `+`, `/`, or `=`, so the value is safe
 * in a URL, a header, and an HTML attribute without escaping — the three
 * places it will live.
 *
 * The 256 bits are not secrecy: the key is published. They are what makes it
 * unguessable, and what makes collision retry a branch that never executes.
 */
export function generateWidgetKey(): string {
  return `${WIDGET_KEY_PREFIX}${randomBytes(WIDGET_KEY_BYTES).toString("base64url")}`;
}

/**
 * The exact shape `generateWidgetKey` produces: the prefix, then base64url
 * characters for however many bytes it emits.
 *
 * Derived from the constants rather than written as a literal, so raising
 * `WIDGET_KEY_BYTES` cannot leave the validator rejecting the generator's own
 * output. base64url of N bytes is `ceil(N * 4 / 3)` characters with no
 * padding.
 */
const WIDGET_KEY_LENGTH = Math.ceil((WIDGET_KEY_BYTES * 4) / 3);
const WIDGET_KEY_PATTERN = new RegExp(`^${WIDGET_KEY_PREFIX}[A-Za-z0-9_-]{${WIDGET_KEY_LENGTH}}$`);

/**
 * Whether a string could be a widget key at all.
 *
 * Used by the request schema so a malformed value is refused at the HTTP
 * boundary as a shape failure, before any database lookup. That distinction
 * is safe to expose: it depends only on the submitted string's form, never on
 * whether any tenant exists (ADR-019 §12).
 */
export function isWellFormedWidgetKey(value: string): boolean {
  return WIDGET_KEY_PATTERN.test(value);
}

/**
 * Characters that make a value a wildcard pattern rather than an origin.
 *
 * Wildcards are prohibited in every spelling — neither `*` nor
 * `https://*.example.com` is accepted (ADR-019 §10). A wildcard subdomain is
 * exactly as strong as the weakest subdomain a tenant has ever pointed at a
 * third-party service, and dangling-subdomain takeover is common enough that
 * "any host under our domain" is not a boundary. A tenant with fifty
 * storefronts lists fifty origins.
 *
 * Checked before parsing, because `new URL("https://*.example.com")` parses
 * happily — `*` is a legal host character as far as the URL spec is
 * concerned — and would otherwise be stored as an origin that matches nothing
 * and quietly disables a tenant's widget.
 */
const WILDCARD_CHARACTERS = /[*?]/;

/**
 * Canonicalizes an origin, or returns `null` if the value is not one.
 *
 * An ORIGIN is `scheme://host[:port]` and nothing else. Anything carrying a
 * path, a query, a fragment, or userinfo is a URL, and storing a URL in an
 * origin list produces a comparison that can never match — the browser sends
 * an origin, so an entry with a trailing `/path` is a silently dead rule.
 *
 * `URL.origin` does the normalization: it lowercases scheme and host, and
 * drops a default port, so `HTTPS://Shop.Example.com:443` and
 * `https://shop.example.com` cannot both be stored as distinct entries that
 * mean the same thing. Applied on both sides — configuration and request —
 * so the comparison is between two canonical forms.
 *
 * Only `http:` and `https:` are accepted. A `file:` or a custom scheme
 * serializes its origin as the string "null", which would make every
 * sandboxed frame in the world match one tenant's list.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (WILDCARD_CHARACTERS.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Userinfo, a path beyond "/", a query, or a fragment all mean the caller
  // supplied a URL rather than an origin. A bare "/" is tolerated because
  // `new URL("https://example.com")` produces one and nobody typed it.
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;

  // Serializes to the literal "null" for opaque origins, which must never
  // become a stored rule.
  if (url.origin === "null") return null;

  return url.origin;
}

/** Whether a configured value is a usable origin. The schema validator's predicate. */
export function isValidOrigin(value: string): boolean {
  return normalizeOrigin(value) !== null;
}
