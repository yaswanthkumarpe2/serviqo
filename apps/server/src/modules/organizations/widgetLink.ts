import { env } from "../../lib/env";

/**
 * The organisation's customer chat link (ADR-038 §1).
 *
 * One link per organisation, derived from its slug and nothing else:
 *
 *   https://serviqo.com/widget/centralservice
 *
 * The slug is unique, URL-safe by `SLUG_PATTERN`, generated when the
 * organisation is created, and immutable (`immutable: true` on the model) —
 * which is what lets a link printed on a receipt or pasted into a help page
 * stay correct for the organisation's whole life.
 *
 * The link is NOT a credential and resolves nothing on its own. The page it
 * opens looks the slug up to find the organisation's widget key, and the
 * widget key is what opens a session. Anyone may hold the link; that is what it
 * is for.
 *
 * Built through the URL API against `CLIENT_URL`, never by concatenation: the
 * base is operator-supplied, and a trailing slash or stray path would
 * otherwise produce a malformed link.
 */
export function buildWidgetUrl(slug: string): string {
  return new URL(`/widget/${encodeURIComponent(slug)}`, env.CLIENT_URL).toString();
}
