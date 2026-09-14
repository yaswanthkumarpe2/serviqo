/**
 * Where the cookie choice is remembered (ADR-035 §6).
 *
 * Its own module rather than exports from the component, because a file that
 * exports both a component and a helper breaks React Fast Refresh — the
 * component stops hot-reloading and starts remounting, losing its state on
 * every edit.
 *
 * `localStorage`, not a cookie, which is the small joke and also the right
 * answer: storing consent in a cookie means setting one before consent. The key
 * is per-browser, carries no identifier, and never leaves the device.
 */

const STORAGE_KEY = "serviqo.cookie-consent";

export type ConsentChoice = "accepted" | "declined";

/**
 * Reads the stored choice, or `null` when nobody has chosen.
 *
 * Every access is wrapped, because `localStorage` THROWS rather than returning
 * null in a browser configured to block site data — and a privacy-conscious
 * visitor is exactly the person most likely to have done that. Being unable to
 * render the page for them would be a poor outcome for a privacy notice.
 */
export function readConsentChoice(): ConsentChoice | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "accepted" || stored === "declined" ? stored : null;
  } catch {
    return null;
  }
}

export function writeConsentChoice(choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /*
      Storage is unavailable, so the notice returns on the next visit. Mildly
      annoying and entirely harmless — and far better than an unhandled
      exception thrown by a consent banner.
    */
  }
}

/**
 * Whether the visitor has accepted.
 *
 * Exported for the script that does not exist yet. Nothing is gated on it
 * today, and the point of having it is that when something is, there is one
 * obvious place to ask — and its answer for a visitor who has chosen nothing is
 * already `false`.
 */
export function hasAcceptedCookies(): boolean {
  return readConsentChoice() === "accepted";
}
