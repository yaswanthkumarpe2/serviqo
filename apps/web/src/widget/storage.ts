/**
 * What the widget remembers about a visitor between visits (ADR-021 §6,
 * ADR-038 §3).
 *
 * Two values, both namespaced by widget key so one organisation's credential
 * is never read as belonging to another, even on a page that embeds two:
 *
 * - The visitor TOKEN: a one-day signed credential that opens a session
 *   without a database lookup of the key.
 * - The visitor KEY: a 256-bit secret issued once, whose hash the server
 *   stores. It is what lets somebody who comes back next week continue the
 *   same conversation without ever holding an account.
 *
 * `localStorage`, not `sessionStorage`, since ADR-038. Customers never sign
 * in, so this browser's memory IS their continuity: `sessionStorage` forgot
 * them the moment the tab closed and turned every return visit into a new
 * anonymous customer with an empty thread. The cost is that a shared computer
 * keeps the conversation reachable for the next person at that browser, which
 * is the same property every "remember me" chat has; clearing site data ends
 * it.
 *
 * Every access is wrapped. Storage throws rather than returning null in
 * private modes, sandboxed iframes and browsers that block site data, and none
 * of that is a reason to break the chat — a visitor who cannot store anything
 * simply never resumes (ADR-019 §7).
 */

const TOKEN_PREFIX = "serviqo_widget_token::";
const VISITOR_KEY_PREFIX = "serviqo_widget_visitor::";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort: the visitor loses continuity, not the chat in front of them.
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to recover: a value that cannot be removed cannot be read either.
  }
}

/** A previously stored visitor token for this widget key, or `null`. */
export function loadStoredToken(widgetKey: string): string | null {
  return read(TOKEN_PREFIX + widgetKey);
}

/** Stores a freshly-issued visitor token. */
export function storeToken(widgetKey: string, token: string): void {
  write(TOKEN_PREFIX + widgetKey, token);
}

/**
 * Discards a token the server has refused (ADR-024 §8), so every retry does
 * not re-present a credential already rejected. The visitor KEY is kept: an
 * expired token is the ordinary reason for a refusal, and the key is exactly
 * what recovers from it.
 */
export function clearStoredToken(widgetKey: string): void {
  remove(TOKEN_PREFIX + widgetKey);
}

/** The visitor key this browser holds for this widget key, or `null` (ADR-038 §3). */
export function loadVisitorKey(widgetKey: string): string | null {
  return read(VISITOR_KEY_PREFIX + widgetKey);
}

/** Stores the visitor key the server issued. It is sent only once. */
export function storeVisitorKey(widgetKey: string, visitorKey: string): void {
  write(VISITOR_KEY_PREFIX + widgetKey, visitorKey);
}
