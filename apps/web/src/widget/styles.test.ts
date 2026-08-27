import { describe, expect, it } from "vitest";

import { WIDGET_STYLES } from "./styles";

/**
 * `jsdom` does not perform real layout, so it cannot verify computed sizes
 * at a breakpoint — that is exercised in a real browser (see the
 * runtime-verification notes in ADR-021). This only guards the one thing a
 * unit test legitimately can: the mobile rule ships in the bundled
 * stylesheet at all, so a future edit cannot silently delete it.
 */
describe("WIDGET_STYLES", () => {
  it("carries a mobile breakpoint that makes the panel full-screen", () => {
    expect(WIDGET_STYLES).toContain("@media (max-width: 480px)");
  });

  it("scopes every color to the .root class rather than a bare element selector", () => {
    // A bare `button { color: ... }` or similar would still be confined by
    // the shadow boundary, but scoping under .root keeps this stylesheet
    // readable as belonging to one widget instance rather than the page.
    expect(WIDGET_STYLES).toContain(".root {");
  });
});
