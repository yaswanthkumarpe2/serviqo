import { vi } from "vitest";

/**
 * A `fetch` stub that answers the auth endpoints by path.
 *
 * Every test that renders an authenticated tree now makes at least two calls —
 * the provider's startup refresh and the dashboard's `/me` (ADR-015) — so a
 * single blanket `mockResolvedValue` can no longer describe what the server
 * does. Routing by path here keeps that agreement in one place rather than
 * re-derived, slightly differently, in each file.
 *
 * Mirrors `modules/auth/testing/fakeEmailProvider.ts` on the server: a test
 * double lives beside the code it doubles, not in the suite that uses it.
 * Nothing imports this from application code, so it never reaches a bundle.
 */

/** The user shape `/auth/me` returns (ADR-015 §9). */
export const CURRENT_USER = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  status: "active",
  emailVerifiedAt: "2026-08-01T09:30:00.000Z",
  createdAt: "2026-07-28T14:00:00.000Z",
};

/** What the login/refresh endpoints report — deliberately narrower than `/me`. */
export const SESSION_USER = { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email };

/** An obvious sentinel — if it reaches storage or the DOM, the test fails. */
export const RESTORED_TOKEN = "RESTORED_ACCESS_TOKEN";

const REFRESH_SUCCESS = {
  success: true,
  data: { user: SESSION_USER, accessToken: RESTORED_TOKEN, expiresIn: 900 },
};

const UNAUTHENTICATED = {
  success: false,
  error: { code: "INVALID_ACCESS_TOKEN", message: "Authentication required" },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

export interface StubAuthFetchOptions {
  /** How `/auth/me` answers. `"ok"` returns `currentUser`; `401` exercises the refusal path. */
  me?: "ok" | 401;
  /** How `/auth/refresh` answers. `401` is what an anonymous browser gets. */
  refresh?: "ok" | 401;
  /** Overrides the user `/auth/me` reports, for tests that assert on the identity itself. */
  currentUser?: Partial<typeof CURRENT_USER>;
}

/**
 * Installs the stub and hands back the mock, so a test can assert on which
 * calls were made and in what order.
 *
 * `logout` and `logout-all` always succeed: no test in this suite is about
 * them failing except the ones that stub `fetch` themselves.
 */
export function stubAuthFetch({ me = "ok", refresh = "ok", currentUser = {} }: StubAuthFetchOptions = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);

    if (path.endsWith("/auth/refresh")) {
      return Promise.resolve(
        refresh === "ok"
          ? jsonResponse(200, REFRESH_SUCCESS)
          : jsonResponse(401, {
              success: false,
              error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid or expired" },
            }),
      );
    }

    if (path.endsWith("/auth/me")) {
      return Promise.resolve(
        me === "ok"
          ? jsonResponse(200, { success: true, data: { user: { ...CURRENT_USER, ...currentUser } } })
          : jsonResponse(401, UNAUTHENTICATED),
      );
    }

    // logout, logout-all, and anything else this suite does not model.
    return Promise.resolve(jsonResponse(200, { success: true, data: {} }));
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Calls to one endpoint, for asserting how many times it was asked. */
export const callsTo = (fetchMock: ReturnType<typeof vi.fn>, suffix: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
