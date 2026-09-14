import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CookieConsent } from "./CookieConsent";
import { hasAcceptedCookies } from "./cookieConsentStorage";

/**
 * The cookie notice (ADR-035 §6).
 *
 * The assertion that matters most is the one about honesty: this banner must
 * not claim to disable something that does not exist, and must not disable the
 * one cookie the product genuinely needs.
 */

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("the cookie notice", () => {
  it("appears for a visitor who has not chosen", () => {
    render(<CookieConsent />);

    expect(screen.getByRole("region", { name: "Cookie notice" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDefined();
  });

  it("says what is actually stored, and that declining changes nothing", () => {
    render(<CookieConsent />);

    const text = screen.getByRole("region", { name: "Cookie notice" }).textContent ?? "";
    expect(text).toMatch(/one cookie/i);
    expect(text).toMatch(/keep you signed in/i);
    expect(text).toMatch(/no analytics/i);
    expect(text).toMatch(/declining does not change/i);
  });

  it("disappears once accepted, and remembers", async () => {
    const { unmount } = render(<CookieConsent />);

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(screen.queryByRole("region", { name: "Cookie notice" })).toBeNull();
    expect(hasAcceptedCookies()).toBe(true);

    unmount();
    render(<CookieConsent />);
    expect(screen.queryByRole("region", { name: "Cookie notice" })).toBeNull();
  });

  it("disappears once declined, and remembers that too", async () => {
    const { unmount } = render(<CookieConsent />);

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(hasAcceptedCookies()).toBe(false);

    unmount();
    render(<CookieConsent />);
    expect(screen.queryByRole("region", { name: "Cookie notice" })).toBeNull();
  });

  /*
    The honesty assertion. Declining must not break sign-in: the only cookie
    Serviqo sets is the HttpOnly refresh cookie, which this notice has no way to
    touch and must not pretend to. Nothing in this component writes a cookie or
    clears one.
  */
  it("touches no cookie at all", async () => {
    document.cookie = "serviqo_refresh=pretend-session-cookie";

    render(<CookieConsent />);
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(document.cookie).toContain("serviqo_refresh=pretend-session-cookie");
  });

  /*
    A privacy-conscious visitor is exactly the person most likely to have
    blocked site data, and `localStorage` THROWS rather than returning null for
    them. A consent notice that crashed the page for them would be a poor joke.
  */
  it("still renders when localStorage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });

    expect(() => render(<CookieConsent />)).not.toThrow();
    expect(screen.getByRole("region", { name: "Cookie notice" })).toBeDefined();
  });

  it("does not claim to be a dialog", () => {
    render(<CookieConsent />);

    // It blocks nothing and traps no focus, so claiming the role would promise
    // a screen reader behaviour this deliberately does not have.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
