import { BrandMark } from "@/components/ui/icons";

import "./AuthRestoring.css";

/**
 * Shown while the startup refresh decides whether this browser has a session.
 *
 * It exists to stop a signed-in user seeing the sign-in form for a frame on
 * every reload. Rendering the form and then replacing it is the flicker; so is
 * rendering a spinner that appears and vanishes inside 100ms, which is why the
 * stylesheet keeps this invisible for the first quarter second. A restore that
 * completes quickly — the normal case on a local network — shows nothing at
 * all.
 *
 * `role="status"` announces the wait to a screen reader without stealing
 * focus, which `role="alert"` would.
 */
export function AuthRestoring() {
  return (
    <div className="authRestoring" role="status" aria-live="polite">
      <span className="authRestoring__mark" aria-hidden="true">
        <BrandMark />
      </span>
      <p className="authRestoring__text">Restoring your session…</p>
    </div>
  );
}
