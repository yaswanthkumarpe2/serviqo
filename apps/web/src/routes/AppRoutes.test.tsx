import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
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

  it("serves the dashboard once a session exists", () => {
    renderAt("/dashboard", session);

    expect(screen.getByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
  });

  // Landing on the form you have already completed is a dead end.
  it("sends an authenticated visitor away from /login", () => {
    renderAt("/login", session);

    expect(screen.getByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
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
    function stubRestoredSession() {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              success: true,
              data: { user: session.user, accessToken: "RESTORED_ACCESS_TOKEN", expiresIn: 900 },
            }),
        } as Response),
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Reloading the dashboard is the case this whole slice exists for.
    it("keeps a reloaded visitor on /dashboard", async () => {
      stubRestoredSession();

      renderAt("/dashboard");

      expect(await screen.findByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
    });

    it("sends a restored visitor away from /login without showing the form", async () => {
      stubRestoredSession();

      renderAt("/login");

      expect(await screen.findByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: /sign in to serviqo/i })).toBeNull();
    });
  });
});
