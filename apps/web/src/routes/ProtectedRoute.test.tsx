import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
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

/**
 * The dashboard now loads its identity from `/me` (ADR-015), so every test
 * that renders it makes a request the blanket 401 in `tests/setup.ts` cannot
 * answer. Individual tests below still override this when the point is what
 * happens on a specific failure.
 *
 * Deliberately no `vi.unstubAllGlobals()` teardown: `tests/setup.ts` installs
 * `matchMedia` once at module load, and unstubbing between tests would remove
 * it. `fetch` needs none — setup re-stubs it before each test, and this hook
 * overrides that.
 */
beforeEach(() => {
  stubAuthFetch();
});

/** The welcome heading, once `/me` has answered. */
const welcome = () => screen.findByRole("heading", { name: "Welcome back, Ada" });

describe("ProtectedRoute", () => {
  // The redirect now waits for the startup refresh (ADR-012): until it
  // settles, "not authenticated" only means "not yet known".
  it("sends an unauthenticated visitor to the sign-in page", async () => {
    // No cookie to restore from, which is what an anonymous browser gets.
    stubAuthFetch({ refresh: 401 });

    renderDashboard(null);

    expect(await screen.findByText("Sign-in page")).toBeDefined();
    expect(screen.queryByText(/welcome/i)).toBeNull();
  });

  it("renders the protected page when a session exists", async () => {
    renderDashboard(session);

    expect(await welcome()).toBeDefined();
  });

  /*
    The flicker this slice removes. Redirecting before the refresh answers
    would bounce a signed-in user to /login on every reload, then bounce them
    back — so while the restore runs, neither the destination nor the sign-in
    page may render.
  */
  it("shows neither the page nor the sign-in redirect while restoring", () => {
    stubAuthFetch({ refresh: 401 });

    renderDashboard(null);

    expect(screen.queryByText("Sign-in page")).toBeNull();
    expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });

  it("renders the protected page once the refresh restores a session", async () => {
    // The default stub restores a session AND answers /me, which is the whole
    // reload path: cookie -> access token -> identity.
    renderDashboard(null);

    expect(await welcome()).toBeDefined();
    expect(screen.queryByText("Sign-in page")).toBeNull();
  });
});

describe("DashboardPage", () => {
  it("shows the signed-in user's name and email", async () => {
    renderDashboard(session);

    expect(await welcome()).toBeDefined();
    expect(screen.getByText("ada@example.com")).toBeDefined();
  });

  /*
    The three labelled placeholder metrics this page used to close with are
    gone (ADR-032 §15). CONTRIBUTING.md requires demo data to say what it is;
    shipping none satisfies that more cheaply, and the aggregate endpoint that
    would have made those figures real is its own slice.
  */
  it("shows no placeholder metrics", () => {
    renderDashboard(session);

    expect(screen.queryByText("SAMPLE DATA")).toBeNull();
    expect(screen.queryByText("Total conversations")).toBeNull();
    expect(screen.queryByText("Open tickets")).toBeNull();
    expect(screen.queryByText("Waiting customers")).toBeNull();
  });

  it("never renders the access token", async () => {
    const { container } = renderDashboard(session);
    await welcome();

    expect(container.textContent).not.toContain(session.accessToken);
  });

  it("signing out clears the session and returns to the sign-in page", async () => {
    const user = userEvent.setup();
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

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

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

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

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    expect(screen.getByText("Sign-in page")).toBeDefined();
    release(undefined);
    vi.unstubAllGlobals();
  });

  // A failed request must not strand someone in a session they asked to end.
  it("still signs out when the logout request fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderDashboard(session);

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    expect(screen.getByText("Sign-in page")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
    vi.unstubAllGlobals();
  });
  // ---- logout all devices (ADR-014) ----

  describe("signing out of all devices", () => {
    const allDevicesButton = () => screen.getByRole("button", { name: /sign out of all devices/i });

    function stubOk() {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      } as Response);
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("offers the control alongside the ordinary sign out", () => {
      renderDashboard(session);

      expect(allDevicesButton()).toBeDefined();
      expect(screen.getByRole("button", { name: /^sign out$/i })).toBeDefined();
    });

    it("calls the logout-all endpoint", async () => {
      const user = userEvent.setup();
      const fetchMock = stubOk();
      renderDashboard(session);

      await user.click(allDevicesButton());

      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/auth/logout-all"))).toBe(true);
      vi.unstubAllGlobals();
    });

    // The two controls must not be wired to each other's endpoint.
    it("does not call the single-session logout endpoint", async () => {
      const user = userEvent.setup();
      const fetchMock = stubOk();
      renderDashboard(session);

      await user.click(allDevicesButton());

      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/auth/logout"))).toBe(false);
      vi.unstubAllGlobals();
    });

    it("clears the session and returns to the sign-in page", async () => {
      const user = userEvent.setup();
      stubOk();
      renderDashboard(session);

      await user.click(allDevicesButton());

      expect(screen.getByText("Sign-in page")).toBeDefined();
      expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
      vi.unstubAllGlobals();
    });

    // No partially authenticated state: the redirect does not wait on the wire.
    it("redirects before the request answers", async () => {
      const user = userEvent.setup();
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) =>
          String(url).endsWith("/auth/logout-all")
            ? pending.then(() => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) }))
            : Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false, error: {} }) }),
        ),
      );
      renderDashboard(session);

      await user.click(allDevicesButton());

      expect(screen.getByText("Sign-in page")).toBeDefined();
      release(undefined);
      vi.unstubAllGlobals();
    });

    it("still signs the browser out when the request fails", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      renderDashboard(session);

      await user.click(allDevicesButton());

      expect(screen.getByText("Sign-in page")).toBeDefined();
      expect(screen.queryByRole("heading", { name: /welcome/i })).toBeNull();
      vi.unstubAllGlobals();
    });
  });
});
