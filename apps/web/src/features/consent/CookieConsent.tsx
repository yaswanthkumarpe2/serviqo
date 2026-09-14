import { useState } from "react";

import { Button } from "@/components/ui/Button";

import { readConsentChoice, writeConsentChoice } from "./cookieConsentStorage";

import type { ConsentChoice } from "./cookieConsentStorage";

import "./CookieConsent.css";

/**
 * The cookie notice (ADR-035 §6).
 *
 * A banner that states what Serviqo stores and offers to accept or decline,
 * shown once until a choice is recorded.
 *
 * **What it does NOT do is turn anything off, and the copy says so.** Serviqo
 * sets exactly one cookie — the `HttpOnly` refresh cookie that keeps you signed
 * in (ADR-011 §12) — and there is no analytics, advertising or third-party
 * tracking to decline. A "Reject" that silently did nothing while implying
 * otherwise would be the dishonest version of this banner; a "Reject" that
 * disabled the sign-in cookie would break the product for anyone who pressed
 * it. So the choice is recorded, the banner goes away, and the text is plain
 * about the fact that declining changes nothing today.
 *
 * That is worth keeping rather than replacing with a link, because it is the
 * component the moment a third-party script does arrive: `hasAcceptedCookies`
 * in `cookieConsentStorage` is the gate such a script would be mounted behind,
 * and it already defaults to "not accepted".
 */

export function CookieConsent() {
  /**
   * Resolved once, in a LAZY initializer rather than in an effect.
   *
   * The effect version had to start hidden and then set state to appear, which
   * is a synchronous setState inside an effect — a cascading render React's own
   * lint rule refuses, and one that flashes nothing into view for a frame. A
   * lazy initializer runs exactly once, before the first paint, so a visitor
   * who dismissed this months ago never sees it flicker.
   *
   * `readConsentChoice` cannot throw; it swallows a blocked `localStorage` and
   * returns null, which shows the notice. Showing it once too often is the
   * right way to be wrong here.
   */
  const [isVisible, setIsVisible] = useState(() => readConsentChoice() === null);

  if (!isVisible) return null;

  function choose(choice: ConsentChoice) {
    writeConsentChoice(choice);
    setIsVisible(false);
  }

  return (
    /*
      `role="region"` with a label rather than `role="dialog"`. A dialog implies
      the rest of the page is inert and should trap focus, and this notice
      blocks nothing — a visitor may read the whole site without answering it.
      Claiming the stronger role would make a screen reader promise behaviour
      this deliberately does not have.
    */
    <section className="consent" role="region" aria-label="Cookie notice">
      <div className="consent__inner">
        <div className="consent__text">
          <p className="consent__title">Cookies on Serviqo</p>
          <p className="consent__body">
            We use one cookie, and only to keep you signed in. There is no analytics, advertising or third-party
            tracking here &mdash; so declining does not change what we store, and signing out removes it.
          </p>
        </div>

        <div className="consent__actions">
          <Button variant="secondary" size="sm" onClick={() => choose("declined")}>
            Decline
          </Button>
          <Button variant="primary" size="sm" onClick={() => choose("accepted")}>
            Accept
          </Button>
        </div>
      </div>
    </section>
  );
}
