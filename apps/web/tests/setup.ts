import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom implements no media queries, and `usePrefersReducedMotion` reads one
 * during render — so any test that mounts the landing page would throw
 * before asserting anything.
 *
 * Reports "no preference", the browser default, so components under test
 * take their ordinary path rather than the reduced-motion shortcut.
 * `useReveal` already guards `IntersectionObserver`, which jsdom also lacks,
 * so nothing else needs stubbing.
 */
vi.stubGlobal(
  "matchMedia",
  (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList,
);

/**
 * React Testing Library does not auto-clean when `globals: false`, so the
 * teardown is registered explicitly. Without it, a second render finds two
 * matching elements and queries fail for reasons unrelated to the assertion.
 */
afterEach(() => {
  cleanup();
});
