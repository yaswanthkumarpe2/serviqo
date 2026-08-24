/**
 * Visitor token persistence (ADR-021 §6).
 *
 * `sessionStorage`, never `localStorage`: cleared when the tab closes, which
 * bounds the token's practical exposure tighter than its 24-hour `exp` claim
 * does on its own (ADR-019 §8's stated cost — "it cannot be revoked before
 * it expires" — is not widened here). A bare in-memory variable was
 * considered and rejected: it would not survive a reload, which is exactly
 * the case ADR-019 §6 built the resumable token for.
 *
 * Namespaced by widget key so one tenant's stored token is never read as
 * belonging to another, even if a single tab's storage were ever shared
 * across embeds of two different tenants on one page.
 */

const STORAGE_PREFIX = "serviqo_widget_token::";

/**
 * Reads a previously-stored visitor token for this widget key, or `null` if
 * none exists or storage is unavailable.
 *
 * `sessionStorage` access can throw — private-browsing modes in some
 * browsers, or a sandboxed iframe without `allow-storage-access-by-user-activation`
 * — and none of that is a reason to break the widget. A visitor who cannot
 * store a token simply never resumes; the anonymous default path still
 * works (ADR-019 §7).
 */
export function loadStoredToken(widgetKey: string): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + widgetKey);
  } catch {
    return null;
  }
}

/** Stores a freshly-issued visitor token, best-effort (see `loadStoredToken`). */
export function storeToken(widgetKey: string, token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + widgetKey, token);
  } catch {
    // Best-effort. A visitor loses resumability across a reload, not the
    // ability to open a session right now.
  }
}

/**
 * Discards a stored token the server has refused (ADR-024 §8).
 *
 * Keeping a rejected credential would make every retry — and every reload
 * for the rest of the tab's life — fail identically, with the widget
 * dutifully re-presenting something it has already been told is no good.
 * Clearing it means the next attempt takes ADR-019 §6's anonymous path,
 * which is also the correct outcome for the most likely cause: an expired
 * token.
 *
 * Best-effort for the same storage reasons as the two above.
 */
export function clearStoredToken(widgetKey: string): void {
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + widgetKey);
  } catch {
    // Nothing to recover from: a token that cannot be removed from storage
    // that cannot be read is not a token that will be presented.
  }
}
