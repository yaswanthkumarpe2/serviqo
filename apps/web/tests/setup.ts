import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

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
 * `AuthProvider` calls the refresh endpoint on mount, so every test that
 * renders it makes a request. jsdom has a real `fetch` and a relative URL has
 * nowhere to go, which would surface as an unhandled rejection in tests that
 * have nothing to do with authentication.
 *
 * The default answers what an anonymous browser actually gets: 401, no
 * session to restore. A test that cares stubs `fetch` itself and overrides
 * this. Registered per-test rather than once, so a file calling
 * `vi.unstubAllGlobals()` in its own teardown gets the default back for the
 * next one.
 */
const UNAUTHENTICATED_REFRESH = {
  success: false,
  error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid or expired" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve(UNAUTHENTICATED_REFRESH),
    } as Response),
  );
});

/**
 * React Testing Library does not auto-clean when `globals: false`, so the
 * teardown is registered explicitly. Without it, a second render finds two
 * matching elements and queries fail for reasons unrelated to the assertion.
 */
afterEach(() => {
  cleanup();
});
