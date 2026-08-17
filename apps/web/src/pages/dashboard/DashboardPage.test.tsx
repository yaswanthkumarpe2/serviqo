import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, callsTo, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { ProtectedRoute } from "@/routes/ProtectedRoute";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The dashboard's identity comes from `GET /auth/me` (ADR-015), not from the
 * login response and not from anything hardcoded.
 *
 * The seeded session below deliberately carries a DIFFERENT name and email
 * from what `/me` reports. Any assertion that passes because the component
 * read `session.user` fails here — which is the point of the whole file.
 */

/** What login put in memory. Stale on purpose. */
const STALE_NAME = "Stale Login Name";
const STALE_EMAIL = "stale-login@example.com";
/** An obvious sentinel — if it reaches the DOM or storage, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";

const session: Session = {
  user: { id: "u1", name: STALE_NAME, email: STALE_EMAIL },
  accessToken: ACCESS_TOKEN,
};

function renderDashboard(initialSession: Session | null = session) {
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

const welcome = () => screen.findByRole("heading", { name: `Welcome, ${CURRENT_USER.name}` });

/*
  No `vi.unstubAllGlobals()` teardown: `tests/setup.ts` installs `matchMedia`
  once at module load. `fetch` is re-stubbed before every test regardless.
*/
beforeEach(() => {
  stubAuthFetch();
});

describe("DashboardPage identity", () => {
  it("loads the current user from /auth/me", async () => {
    const fetchMock = stubAuthFetch();

    renderDashboard();
    await welcome();

    expect(callsTo(fetchMock, "/api/v1/auth/me")).toHaveLength(1);
  });

  it("displays the real name and email the server reported", async () => {
    renderDashboard();

    expect(await welcome()).toBeDefined();
    expect(screen.getByText(CURRENT_USER.email)).toBeDefined();
  });

  it("shows the name in the header bar too", async () => {
    const { container } = renderDashboard();
    await welcome();

    expect(container.querySelector(".dash__who")?.textContent).toBe(CURRENT_USER.name);
  });

  /*
    The load-bearing assertion of this file. The seeded session says one thing
    and /me says another; a component reading the session would render the
    stale values and fail here.
  */
  it("does not display the identity carried in the login session", async () => {
    const { container } = renderDashboard();
    await welcome();

    expect(container.textContent).not.toContain(STALE_NAME);
    expect(container.textContent).not.toContain(STALE_EMAIL);
  });

  it("renders whatever the server says, not a fixed name", async () => {
    stubAuthFetch({ currentUser: { name: "Grace Hopper", email: "grace@example.com" } });

    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Welcome, Grace Hopper" })).toBeDefined();
    expect(screen.getByText("grace@example.com")).toBeDefined();
  });

  it("asks for the identity once per mount", async () => {
    const fetchMock = stubAuthFetch();

    renderDashboard();
    await welcome();
    // Settle anything the provider might still be doing.
    await waitFor(() => expect(callsTo(fetchMock, "/api/v1/auth/me")).toHaveLength(1));
  });

  it("presents the access token as a bearer credential", async () => {
    const fetchMock = stubAuthFetch();

    renderDashboard();
    await welcome();

    const [, init] = callsTo(fetchMock, "/api/v1/auth/me")[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe("DashboardPage loading state", () => {
  it("shows a loading state before the answer arrives", () => {
    renderDashboard();

    // Synchronously after mount, nothing real is known yet.
    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryByRole("heading", { name: /^welcome/i })).toBeNull();
  });

  it("announces the wait to a screen reader", () => {
    renderDashboard();

    expect(screen.getByText(/loading your account/i)).toBeDefined();
  });

  // The reason the loading state exists: no invented identity may appear in
  // its place.
  it("displays no name or email while loading", () => {
    const { container } = renderDashboard();

    expect(container.textContent).not.toContain(STALE_NAME);
    expect(container.textContent).not.toContain(STALE_EMAIL);
    expect(container.textContent).not.toContain(CURRENT_USER.name);
    expect(container.textContent).not.toContain(CURRENT_USER.email);
  });

  it("marks the region busy while it loads and not afterwards", async () => {
    const { container } = renderDashboard();
    const welcomeSection = () => container.querySelector(".dash__welcome");

    expect(welcomeSection()?.getAttribute("aria-busy")).toBe("true");

    await welcome();
    expect(welcomeSection()?.getAttribute("aria-busy")).toBe("false");
  });

  it("clears the loading state once the user arrives", async () => {
    renderDashboard();
    await welcome();

    expect(screen.queryByText(/loading your account/i)).toBeNull();
  });
});

describe("DashboardPage when /me is refused", () => {
  /**
   * A 401 the retry could not fix: the access token was rejected, the refresh
   * behind it also failed. `authorizedRequest` refreshes once and replays once
   * (ADR-012 §4); this is what the caller sees after that.
   */
  it("refreshes once when /me answers 401", async () => {
    const fetchMock = stubAuthFetch({ me: 401, refresh: "ok" });

    renderDashboard();

    // The seeded session suppresses the startup restore, so any refresh here
    // is the retry path and nothing else.
    await waitFor(() => expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(1));
  });

  it("replays the request once after refreshing", async () => {
    const fetchMock = stubAuthFetch({ me: 401, refresh: "ok" });

    renderDashboard();

    // Original call, then exactly one replay — never a loop.
    await waitFor(() => expect(callsTo(fetchMock, "/api/v1/auth/me")).toHaveLength(2));
    expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(1);
  });

  it("sends the user to /login when the refusal survives the refresh", async () => {
    stubAuthFetch({ me: 401, refresh: "ok" });

    renderDashboard();

    expect(await screen.findByText("Sign-in page")).toBeDefined();
  });

  it("sends the user to /login when the refresh itself fails", async () => {
    stubAuthFetch({ me: 401, refresh: 401 });

    renderDashboard();

    expect(await screen.findByText("Sign-in page")).toBeDefined();
  });

  it("does not attempt a second refresh when the first fails", async () => {
    const fetchMock = stubAuthFetch({ me: 401, refresh: 401 });

    renderDashboard();
    await screen.findByText("Sign-in page");

    expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(1);
  });

  it("shows no identity on the way out", async () => {
    stubAuthFetch({ me: 401, refresh: 401 });

    const { container } = renderDashboard();
    // Asserted after the redirect has landed, so this cannot pass merely by
    // running before anything resolved.
    await screen.findByText("Sign-in page");

    expect(container.textContent).not.toContain(CURRENT_USER.email);
    expect(container.textContent).not.toContain(CURRENT_USER.name);
    expect(container.textContent).not.toContain(STALE_EMAIL);
  });

  /*
    A transport failure is NOT a sign-out. The session is intact and the token
    may be fine; the request simply did not arrive.
  */
  it("keeps the user signed in and reports a failure the network caused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    renderDashboard();

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByText("Sign-in page")).toBeNull();
  });

  it("invents no identity when the account cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const { container } = renderDashboard();
    await screen.findByRole("alert");

    expect(container.textContent).not.toContain(STALE_NAME);
    expect(container.textContent).not.toContain(STALE_EMAIL);
    expect(container.textContent).not.toContain(CURRENT_USER.email);
  });
});

describe("DashboardPage credential handling", () => {
  // ADR-011 §1: the access token is memory-only, and this is the assertion
  // that fails the moment someone reaches for persistence.
  it("writes nothing to localStorage or sessionStorage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderDashboard();
    await welcome();

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });

  it("stores no part of the current user either", async () => {
    renderDashboard();
    await welcome();

    const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
    expect(stored).not.toContain(CURRENT_USER.email);
    expect(stored).not.toContain(CURRENT_USER.id);
  });

  it("never renders the access token", async () => {
    const { container } = renderDashboard();
    await welcome();

    expect(container.textContent).not.toContain(ACCESS_TOKEN);
  });
});

describe("DashboardPage sample data", () => {
  // CONTRIBUTING.md: demo data must be labelled as demo data. The metrics are
  // still placeholders — only the identity became real in this slice.
  it("still labels the metrics as sample data", async () => {
    renderDashboard();
    await welcome();

    expect(screen.getByText("SAMPLE DATA")).toBeDefined();
    expect(screen.getByText(/these figures are placeholders/i)).toBeDefined();
  });

  it("keeps the sample label off the identity", async () => {
    const { container } = renderDashboard();
    await welcome();

    const welcomeSection = container.querySelector(".dash__welcome");
    expect(welcomeSection?.textContent).not.toMatch(/sample|placeholder/i);
  });
});
