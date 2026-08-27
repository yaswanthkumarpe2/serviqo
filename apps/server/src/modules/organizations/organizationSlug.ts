/**
 * Slug generation and reserved-slug policy (ADR-016 §5–6).
 *
 * `organization.model.ts` deferred both of these here by name: it refuses to
 * "turn an arbitrary string into a valid slug" because that is "exactly the
 * kind of surprising silent transformation persistence should not perform",
 * and it defers "blocking slugs like `api`/`admin`/`login`" to the creation
 * service. This is that service's half.
 *
 * Kept separate from the service so the transformation is testable without a
 * database — it is pure string work, and the rules below are the kind that
 * are easiest to get wrong and cheapest to pin down.
 */

/**
 * Route segments a tenant may not occupy.
 *
 * Lives in this module rather than `config/constants.ts`, whose ownership rule
 * is that "a value lives here when more than one layer needs it". One service
 * reads this list.
 *
 * `widget` and `public` are reserved deliberately: ADR-010 §5 reserved a
 * customer-traffic namespace that does not exist yet, and a tenant that took
 * the segment first would collide with it on the day it ships.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // current and planned application routes
  "api",
  "app",
  "admin",
  "auth",
  "login",
  "logout",
  "register",
  "signup",
  "signin",
  "dashboard",
  "settings",
  "account",
  "help",
  "support",
  "docs",
  "status",
  "health",
  // reserved for customer-facing traffic (ADR-010 §5)
  "widget",
  "public",
  "customer",
  "customers",
  "chat",
  // infrastructure and vanity segments that routinely become routes
  "www",
  "cdn",
  "static",
  "assets",
  "mail",
  "billing",
  "security",
  "about",
  "blog",
  "serviqo",
]);

/**
 * Bound on the generated base, leaving room for a numeric suffix without the
 * combined slug growing without limit. Not a database constraint — the schema
 * has no maxlength on slug — but a URL segment nobody can read is not a
 * useful identifier.
 */
const MAX_BASE_LENGTH = 48;

/**
 * Used when a name yields no usable characters at all — "~~~", or a name in a
 * script the ASCII fold below erases entirely.
 *
 * Falling back is deliberate rather than rejecting. A name is presentation
 * data belonging to its owner (the reasoning `auth.validation.ts` applies to
 * person names); it should not have to be Latin script to be a tenant. The
 * resulting slug is unhelpful, and that is strictly better than refusing to
 * create the organization.
 */
const FALLBACK_BASE = "org";

/** Matches the schema's own `SLUG_PATTERN` in organization.model.ts. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Derives the preferred slug from a display name.
 *
 * NFKD-folds so accented characters decompose, drops the combining marks that
 * decomposition leaves behind (`café` → `cafe`), lowercases, and collapses
 * every run of non-alphanumeric characters into a single hyphen.
 *
 * The result is deliberately lossy and never reversible. It is a URL segment
 * derived from the name, not an encoding of it — the name remains the
 * authoritative display value and is stored unchanged.
 */
export function slugifyOrganizationName(name: string): string {
  const folded = name
    .normalize("NFKD")
    // Combining marks left by the decomposition above.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Every run of anything that is not [a-z0-9] becomes one hyphen. Applied
    // after folding so "Ünïcodé Ltd." reaches "unicode-ltd" rather than
    // losing the whole first word.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    // The slice can leave a trailing hyphen when the cut lands on one.
    .replace(/-+$/g, "");

  return folded.length > 0 ? folded : FALLBACK_BASE;
}

/**
 * The candidate sequence for a base: `acme`, `acme-2`, `acme-3`, …
 *
 * `attempt` is 0-indexed; attempt 0 is the bare base, so the suffixes a user
 * sees start at 2 rather than 1 — `acme-1` reads like the first of several
 * when it is actually the second.
 */
export function slugCandidate(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}

/**
 * Whether a slug may not be used, for either of the two reasons that are the
 * same reason (ADR-016 §6).
 *
 * Only the reserved half lives here — "already stored" is a database question
 * the service asks separately. Kept as one exported predicate so the caller
 * reads `isReservedSlug(x) || taken`, and neither condition can be checked in
 * one place and forgotten in another.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/**
 * Guards the generator against its own output.
 *
 * The schema validates `slug` with `SLUG_PATTERN`, so a generator that
 * disagreed with it would surface as a Mongoose `ValidationError` from
 * persistence — a 500 on a perfectly valid name. Checking here costs one
 * regex and turns that class of bug into a caught, testable condition.
 */
export function isWellFormedSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}
