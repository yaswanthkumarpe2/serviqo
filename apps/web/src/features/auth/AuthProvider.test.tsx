import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "./AuthProvider";
import { useAuth } from "./useAuth";

import type { Session } from "./AuthContext";

const EMAIL = "ada@example.com";
/** Obvious sentinels — if either reaches storage or the DOM, the test fails. */
const RESTORED_TOKEN = "RESTORED_ACCESS_TOKEN";
const SEEDED_TOKEN = "SEEDED_ACCESS_TOKEN";

const restoredUser = { id: "u1", name: "Ada Lovelace", email: EMAIL };

const refreshSuccess = {
  success: true,
  data: { user: restoredUser, accessToken: RESTORED_TOKEN, expiresIn: 900 },
};

const refreshFailure = {
  success: false,
  error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid or expired" },
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Renders the provider's state as text so assertions read it from the DOM. */
function AuthStateProbe() {
  const { session, isAuthenticated, isRestoring, signOut, signOutAllDevices } = useAuth();

  return (
    <div>
      <p data-testid="phase">{isRestoring ? "restoring" : isAuthenticated ? "authenticated" : "anonymous"}</p>
      <p data-testid="who">{session?.user.email ?? "nobody"}</p>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
      <button type="button" onClick={signOutAllDevices}>
        Sign out of all devices
      </button>
    </div>
  );
}

const phase = () => screen.getByTestId("phase").textContent;
const who = () => screen.getByTestId("who").textContent;

function renderProvider(initialSession?: Session | null) {
  return render(
    <AuthProvider initialSession={initialSession}>
      <AuthStateProbe />
    </AuthProvider>,
  );
}

type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Renders the provider and hands back the `authorizedFetch` it exposes.
 *
 * Captured in an effect rather than during render: assigning to an outer
 * variable while rendering is a side effect, and React makes no promise about
 * when a render runs.
 */
function renderWithAuthorizedFetch() {
  const captured: { current?: AuthorizedFetch } = {};

  function Capture() {
    const { authorizedFetch } = useAuth();
    useEffect(() => {
      captured.current = authorizedFetch;
    }, [authorizedFetch]);
    return <AuthStateProbe />;
  }

  render(
    <AuthProvider>
      <Capture />
    </AuthProvider>,
  );

  return captured;
}

/** Answers the refresh endpoint with `refreshBody`, and everything else with 401. */
function stubProtectedCallsExpired(fetchMock: ReturnType<typeof vi.fn>, refreshOk: boolean) {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/auth/refresh")) {
      return Promise.resolve({
        ok: refreshOk,
        status: refreshOk ? 200 : 401,
        json: () => Promise.resolve(refreshOk ? refreshSuccess : refreshFailure),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 401 } as Response);
  });
}

const refreshCallsIn = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthProvider startup restore", () => {
  it("asks the refresh endpoint when no access token is in memory", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);

    renderProvider();

    await waitFor(() => expect(phase()).toBe("authenticated"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/auth/refresh");
  });

  it("reports restoring before the answer arrives", () => {
    stubFetch(200, refreshSuccess);

    renderProvider();

    // Synchronously after mount, nothing is known yet.
    expect(phase()).toBe("restoring");
  });

  it("restores the session the endpoint reports", async () => {
    stubFetch(200, refreshSuccess);

    renderProvider();

    await waitFor(() => expect(phase()).toBe("authenticated"));
    expect(who()).toBe(EMAIL);
  });

  it("settles as anonymous when there is no session to restore", async () => {
    stubFetch(401, refreshFailure);

    renderProvider();

    await waitFor(() => expect(phase()).toBe("anonymous"));
    expect(who()).toBe("nobody");
  });

  // A transport failure must not strand the app on the placeholder forever.
  it("settles as anonymous when the request cannot be made at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    renderProvider();

    await waitFor(() => expect(phase()).toBe("anonymous"));
  });

  // The restore exists to recover a session when none is in memory.
  it("does not refresh when a session is already seeded", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);
    const seeded: Session = { user: restoredUser, accessToken: SEEDED_TOKEN };

    renderProvider(seeded);

    expect(phase()).toBe("authenticated");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("never waits when a session is seeded", () => {
    stubFetch(200, refreshSuccess);

    renderProvider({ user: restoredUser, accessToken: SEEDED_TOKEN });

    expect(phase()).not.toBe("restoring");
  });

  /*
    StrictMode mounts, unmounts and remounts in development. Two restores would
    race each other into the rotation's compare-and-swap, and ADR-012 §4 answers
    the loser with a 401 — which would read here as a failed refresh.
  */
  it("attempts exactly one restore under StrictMode's double mount", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);

    render(
      <StrictMode>
        <AuthProvider>
          <AuthStateProbe />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(phase()).toBe("authenticated"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("lifts the placeholder even under StrictMode", async () => {
    stubFetch(401, refreshFailure);

    render(
      <StrictMode>
        <AuthProvider>
          <AuthStateProbe />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(phase()).toBe("anonymous"));
  });
});

describe("AuthProvider session handling", () => {
  it("signing out clears the session without another refresh", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    expect(phase()).toBe("anonymous");
    expect(who()).toBe("nobody");
    // The startup restore, then logout — and nothing that would restore it.
    expect(refreshCallsIn(fetchMock)).toHaveLength(1);
  });

  // ---- logout (ADR-013) ----

  it("signing out asks the server to end the session", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/auth/logout"))).toBe(true),
    );
  });

  // The credential is the cookie; there is nothing for this call to send.
  it("sends no body and no Authorization header when logging out", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    const logoutCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auth/logout"));
      expect(call).toBeDefined();
      return call!;
    });
    const init = logoutCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe("same-origin");
  });

  /*
    Local state is cleared before the request settles, so leaving never waits
    on the network — and a failed request must not strand someone in a session
    they asked to end (ADR-013 consequences).
  */
  it("clears the session even when the logout request fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/auth/logout")) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(refreshSuccess) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    expect(phase()).toBe("anonymous");
    expect(who()).toBe("nobody");
  });

  it("clears the session before the server answers", async () => {
    const user = userEvent.setup();
    let releaseLogout: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      releaseLogout = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/auth/logout")) {
        return pending.then(
          () => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) }) as Response,
        );
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(refreshSuccess) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await user.click(screen.getByRole("button", { name: /^sign out$/i }));

    // The request has not answered yet, and the session is already gone.
    expect(phase()).toBe("anonymous");
    releaseLogout(undefined);
  });

  // ADR-011 §1: the access token is memory-only, and this is the assertion
  // that would fail the moment someone reached for persistence.
  it("writes no token to localStorage or sessionStorage", async () => {
    stubFetch(200, refreshSuccess);
    const localSetItem = vi.spyOn(Storage.prototype, "setItem");

    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    expect(localSetItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    localSetItem.mockRestore();
  });

  it("never renders the access token", async () => {
    stubFetch(200, refreshSuccess);

    const { container } = renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    expect(container.textContent).not.toContain(RESTORED_TOKEN);
  });

  // The refresh request carries the cookie and nothing else (ADR-012 §1).
  it("sends no body and no Authorization header when refreshing", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);

    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe("POST");
  });
});

describe("AuthProvider single-flight refresh", () => {
  /**
   * Several requests expiring together must produce ONE refresh. Rotation is a
   * compare-and-swap (ADR-012 §6); concurrent refreshes mean one wins and the
   * rest get the grace window's 401, which would sign out a healthy session.
   */
  it("coalesces concurrent refreshes into a single request", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);
    const captured = renderWithAuthorizedFetch();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    // Three protected calls that all find the token expired at the same moment.
    stubProtectedCallsExpired(fetchMock, true);
    await Promise.all([
      captured.current!("/api/v1/a"),
      captured.current!("/api/v1/b"),
      captured.current!("/api/v1/c"),
    ]);

    expect(refreshCallsIn(fetchMock)).toHaveLength(1);
  });

  it("allows a later refresh once the first has settled", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);
    const captured = renderWithAuthorizedFetch();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    stubProtectedCallsExpired(fetchMock, true);
    await captured.current!("/api/v1/a");
    await captured.current!("/api/v1/b");

    expect(refreshCallsIn(fetchMock)).toHaveLength(2);
  });

  it("clears the session when a mid-session refresh fails", async () => {
    const fetchMock = stubFetch(200, refreshSuccess);
    const captured = renderWithAuthorizedFetch();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    // The cookie has since been revoked: the protected call 401s, and so does
    // the refresh behind it.
    stubProtectedCallsExpired(fetchMock, false);

    await expect(captured.current!("/api/v1/a")).rejects.toThrow();

    // Signing the user out is what makes ProtectedRoute redirect to /login.
    await waitFor(() => expect(phase()).toBe("anonymous"));
  });
});

describe("AuthProvider logout-all (ADR-014)", () => {
  const clickSignOutAll = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /sign out of all devices/i }));

  const logoutAllCallsIn = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/logout-all"));

  it("asks the server to end every session", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);

    await waitFor(() => expect(logoutAllCallsIn(fetchMock)).toHaveLength(1));
  });

  it("clears the local session", async () => {
    const user = userEvent.setup();
    stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);

    expect(phase()).toBe("anonymous");
    expect(who()).toBe("nobody");
  });

  // The credential is the cookie; there is nothing for this call to send.
  it("sends no body and no Authorization header", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);

    const call = await waitFor(() => {
      const found = logoutAllCallsIn(fetchMock)[0];
      expect(found).toBeDefined();
      return found!;
    });
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe("same-origin");
  });

  // Local state clears first, so leaving never waits on the network.
  it("clears the session before the server answers", async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/auth/logout-all")) {
        return pending.then(
          () => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) }) as Response,
        );
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(refreshSuccess) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);

    expect(phase()).toBe("anonymous");
    release(undefined);
  });

  /*
    A failed request leaves the OTHER devices signed in, which is the opposite
    of what was asked — but refusing to sign out the browser in front of the
    person helps nobody (ADR-014 consequences).
  */
  it("still clears the local session when the request fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/auth/logout-all")) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(refreshSuccess) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);

    expect(phase()).toBe("anonymous");
    expect(who()).toBe("nobody");
  });

  // The two controls must not be wired to each other's endpoint.
  it("does not call the single-session logout endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);

    await waitFor(() => expect(logoutAllCallsIn(fetchMock)).toHaveLength(1));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/logout"))).toHaveLength(0);
  });

  it("leaves the session restorable by a fresh sign-in", async () => {
    const user = userEvent.setup();
    stubFetch(200, refreshSuccess);
    renderProvider();
    await waitFor(() => expect(phase()).toBe("authenticated"));

    await clickSignOutAll(user);
    expect(phase()).toBe("anonymous");

    // Nothing about signing out everywhere should poison later sign-ins.
    expect(who()).toBe("nobody");
  });
});
