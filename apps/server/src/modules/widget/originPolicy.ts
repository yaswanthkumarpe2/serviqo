import { normalizeOrigin } from "../organizations/widgetConfig";

/**
 * The request-time allowed-origin decision (ADR-019 §10).
 *
 * `widgetConfig.ts` decides whether a CONFIGURED value is a usable origin.
 * This decides whether an INCOMING request's `Origin` header is one the
 * tenant permits. The split matters: configuration is validated once when a
 * tenant sets it, and this runs on every public request.
 */

/** Why a request's origin was refused. Reaches the log, never a response body. */
export type OriginRefusal = "origin_not_allowed" | "origin_malformed";

export type OriginDecision = { allowed: true } | { allowed: false; reason: OriginRefusal };

const ALLOWED: OriginDecision = { allowed: true };

/**
 * Decides whether this request may open a widget session for this tenant.
 *
 * | `Origin` header          | `allowedOrigins` | Outcome  |
 * |--------------------------|------------------|----------|
 * | present, matches         | non-empty        | allowed  |
 * | present, no match        | any              | refused  |
 * | present, `null`/unparseable | any           | refused  |
 * | present                  | empty            | refused  |
 * | **absent**               | any              | allowed  |
 *
 * The last row is the one that needs defending, because it reads like a
 * bypass and is not.
 *
 * An absent `Origin` means the caller is not a browser making a cross-origin
 * request — it is `curl`, a server, a native app, or a test. Refusing it
 * would buy nothing: a non-browser caller can set the header to any value it
 * likes, so the header only ever constrains the one caller that CANNOT lie
 * about it. This list exists to stop a browser on an unapproved website from
 * embedding a tenant's widget, and against that threat the header is always
 * present and always truthful, because browsers set it on cross-origin POST
 * and refuse to let script override it.
 *
 * An EMPTY `allowedOrigins` therefore means "no website may embed this
 * widget", never "every website may" — the default is closed. A newly created
 * organization starts closed and can still be exercised by non-browser
 * callers while being embeddable nowhere.
 *
 * The header never selects a tenant. It is compared against a list already
 * loaded for a tenant already resolved from the widget key — the concrete
 * meaning of "do not trust an Origin supplied by the customer": the value is
 * a claim to be checked, never an input to a lookup.
 */
export function decideOrigin(
  header: string | undefined,
  allowedOrigins: string[],
  firstPartyOrigin: string | null = null,
): OriginDecision {
  if (header === undefined) return ALLOWED;

  /*
    Both sides go through the same canonicalization, so the comparison is
    between two canonical forms. `normalizeOrigin` returns null for the
    literal "null" a sandboxed iframe or a `file://` page sends, for a
    non-http(s) scheme, and for anything carrying a path — none of which a
    browser produces for a legitimate embed.
  */
  const origin = normalizeOrigin(header);
  if (origin === null) return { allowed: false, reason: "origin_malformed" };

  /*
    Exact match against the stored list. Deliberately not a suffix or
    subdomain comparison: `endsWith(".example.com")` also matches
    `evil-example.com` and `example.com.attacker.test`, which is how
    hand-written origin checks fail. Wildcards are rejected at configuration
    time (`widgetConfig.ts`), so no entry here can be a pattern.

    A linear scan over an array a tenant maintains by hand. Fifty storefronts
    is fifty comparisons of short strings.
  */
  /*
    Serviqo's own origin is always allowed (ADR-038 §2). It is where every
    organisation's hosted chat link is served from, so without this an
    organisation could not use its own link until it added Serviqo to its
    embed list — and every organisation would have to add the same entry.

    It widens nothing an attacker can use. The Origin header is a claim, and a
    non-browser caller can already send any value; the check exists to stop a
    third-party PAGE embedding a tenant's widget, and Serviqo's own page is
    not a third party.
  */
  if (firstPartyOrigin !== null && origin === firstPartyOrigin) return ALLOWED;

  const matches = allowedOrigins.some((allowed) => normalizeOrigin(allowed) === origin);

  return matches ? ALLOWED : { allowed: false, reason: "origin_not_allowed" };
}
