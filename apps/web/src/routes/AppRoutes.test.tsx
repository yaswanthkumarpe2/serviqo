import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

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

  it("serves the sign-in page at /login", () => {
    renderAt("/login");

    expect(screen.getByRole("heading", { name: /sign in to serviqo/i })).toBeDefined();
  });

  it("redirects an unauthenticated visit to /dashboard back to /login", () => {
    renderAt("/dashboard");

    expect(screen.getByRole("heading", { name: /sign in to serviqo/i })).toBeDefined();
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
});
