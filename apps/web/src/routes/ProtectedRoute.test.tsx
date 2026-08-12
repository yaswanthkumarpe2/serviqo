import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { ProtectedRoute } from "@/routes/ProtectedRoute";

import type { Session } from "@/features/auth/AuthContext";

const session: Session = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  accessToken: "header.payload.signature",
};

function renderDashboard(initialSession: Session | null) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AuthProvider initialSession={initialSession}>
        <Routes>
          <Route path="/login" element={<h1>Sign-in page</h1>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute", () => {
  // The redirect now waits for the startup refresh (ADR-012): until it
  // settles, "not authenticated" only means "not yet known".
  it("sends an unauthenticated visitor to the sign-in page", async () => {
    renderDashboard(null);

    expect(await screen.findByText("Sign-in page")).toBeDefined();
    expect(screen.queryByText(/welcome/i)).toBeNull();
  });

  it("renders the protected page when a session exists", () => {
    renderDashboard(session);

    expect(screen.getByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
  });

  /*
    The flicker this slice removes. Redirecting before the refresh answers
    would bounce a signed-in user to /login on every reload, then bounce them
    back — so while the restore runs, neither the destination nor the sign-in
    page may render.
  */
  it("shows neither the page nor the sign-in redirect while restoring", () => {
    renderDashboard(null);

    expect(screen.queryByText("Sign-in page")).toBeNull();
    expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });

  it("renders the protected page once the refresh restores a session", async () => {
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

    renderDashboard(null);

    expect(await screen.findByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
    expect(screen.queryByText("Sign-in page")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("DashboardPage", () => {
  it("shows the signed-in user's name and email", () => {
    renderDashboard(session);

    expect(screen.getByRole("heading", { name: "Welcome, Ada Lovelace" })).toBeDefined();
    expect(screen.getByText("ada@example.com")).toBeDefined();
  });

  it("shows the three placeholder metrics", () => {
    renderDashboard(session);

    expect(screen.getByText("Total conversations")).toBeDefined();
    expect(screen.getByText("Open tickets")).toBeDefined();
    expect(screen.getByText("Waiting customers")).toBeDefined();
  });

  // CONTRIBUTING.md: demo data must be labelled as demo data, never left to
  // read as a working feature.
  it("labels the metrics as sample data", () => {
    renderDashboard(session);

    expect(screen.getByText("SAMPLE DATA")).toBeDefined();
    expect(screen.getByText(/these figures are placeholders/i)).toBeDefined();
  });

  it("never renders the access token", () => {
    const { container } = renderDashboard(session);

    expect(container.textContent).not.toContain(session.accessToken);
  });

  it("signing out clears the session and returns to the sign-in page", async () => {
    const user = userEvent.setup();
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByText("Sign-in page")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
  });

  // ---- logout (ADR-013) ----

  it("signing out asks the server to end the session", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: {} }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/auth/logout"))).toBe(true);
    vi.unstubAllGlobals();
  });

  /*
    The redirect must not wait on the network. `signOut` clears local state
    before its request settles, so the guard re-renders immediately.
  */
  it("redirects before the logout request answers", async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        String(url).endsWith("/auth/logout")
          ? pending.then(() => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) }))
          : Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false, error: {} }) }),
      ),
    );
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByText("Sign-in page")).toBeDefined();
    release(undefined);
    vi.unstubAllGlobals();
  });

  // A failed request must not strand someone in a session they asked to end.
  it("still signs out when the logout request fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.getByText("Sign-in page")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
    vi.unstubAllGlobals();
  });
});
