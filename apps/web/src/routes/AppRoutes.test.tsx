import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { AppRoutes } from "@/routes/AppRoutes";

import type { Session } from "@/features/auth/AuthContext";

const session: Session = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  accessToken: "header.payload.signature",
};

function renderAt(path: string, initialSession: Session | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialSession={initialSession}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The dashboard's welcome heading, once `/me` has answered (ADR-015). */
const welcome = () => screen.findByRole("heading", { name: "Welcome, Ada Lovelace" });

/**
 * Anonymous by default here, unlike ProtectedRoute's suite: most cases below
 * are about where an unauthenticated visitor lands. The ones that need a
 * session say so.
 *
 * Deliberately no `vi.unstubAllGlobals()` teardown. `tests/setup.ts` installs
 * `matchMedia` once at module load — the landing page reads it during render —
 * so unstubbing between tests would remove it for every test after the first.
 * `fetch` needs no teardown either: setup re-stubs it before each test, and
 * this hook overrides that.
 */
beforeEach(() => {
  stubAuthFetch({ refresh: 401 });
});

describe("AppRoutes", () => {
  it("keeps the landing page at /", () => {
    renderAt("/");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Customer support");
  });

  it("still links Sign in to /login from the landing navbar", () => {
    renderAt("/");

    const signIn = screen.getAllByRole("link", { name: /^sign in$/i });
    expect(signIn.length).toBeGreaterThan(0);
    for (const link of signIn) {
      expect(link.getAttribute("href")).toBe("/login");
    }
  });

  // Both of these now wait for the startup refresh to settle (ADR-012).
  it("serves the sign-in page at /login", async () => {
    renderAt("/login");

    expect(await screen.findByRole("heading", { name: /sign in to serviqo/i })).toBeDefined();
  });

  it("redirects an unauthenticated visit to /dashboard back to /login", async () => {
    renderAt("/dashboard");

    expect(await screen.findByRole("heading", { name: /sign in to serviqo/i })).toBeDefined();
  });

  it("serves the dashboard once a session exists", async () => {
    stubAuthFetch();

    renderAt("/dashboard", session);

    expect(await welcome()).toBeDefined();
  });

  // Landing on the form you have already completed is a dead end.
  it("sends an authenticated visitor away from /login", async () => {
    stubAuthFetch();

    renderAt("/login", session);

    expect(await welcome()).toBeDefined();
  });

  it("returns an unknown path to the landing page", () => {
    renderAt("/no-such-page");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Customer support");
  });

  // ---- the startup restore (ADR-012) ----

  describe("while the startup refresh is in flight", () => {
    it("does not show the sign-in form at /login", () => {
      renderAt("/login");

      expect(screen.queryByRole("heading", { name: /sign in to serviqo/i })).toBeNull();
      expect(screen.getByRole("status")).toBeDefined();
    });

    /*
      The landing page is public marketing and renders the same either way, so
      it is deliberately not held behind the restore — an anonymous visitor
      never waits on an auth request that cannot change what they see.
    */
    it("still serves the landing page immediately", () => {
      renderAt("/");

      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Customer support");
    });
  });

  describe("when the refresh restores a session", () => {
    // Reloading the dashboard is the case this whole slice exists for.
    it("keeps a reloaded visitor on /dashboard", async () => {
      stubAuthFetch();

      renderAt("/dashboard");

      expect(await welcome()).toBeDefined();
    });

    it("sends a restored visitor away from /login without showing the form", async () => {
      stubAuthFetch();

      renderAt("/login");

      expect(await welcome()).toBeDefined();
      expect(screen.queryByRole("heading", { name: /sign in to serviqo/i })).toBeNull();
    });
  });
});
