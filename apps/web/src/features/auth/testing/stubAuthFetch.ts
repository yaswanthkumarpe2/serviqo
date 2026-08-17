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

/** One membership as `/auth/me` reports it (ADR-017 §9). */
export interface StubMembership {
  membershipId: string;
  role: string;
  organization: { id: string; name: string; slug: string; status: string };
}

/** Builds a membership without restating the organization shape each time. */
export function stubMembership(
  id: string,
  name: string,
  role = "owner",
  status = "active",
): StubMembership {
  return {
    membershipId: `m-${id}`,
    role,
    organization: { id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), status },
  };
}

export interface StubAuthFetchOptions {
  /** How `/auth/me` answers. `"ok"` returns `currentUser`; `401` exercises the refusal path. */
  me?: "ok" | 401;
  /** How `/auth/refresh` answers. `401` is what an anonymous browser gets. */
  refresh?: "ok" | 401;
  /** Overrides the user `/auth/me` reports, for tests that assert on the identity itself. */
  currentUser?: Partial<typeof CURRENT_USER>;
  /**
   * What `/auth/me` reports for `memberships`. Defaults to none — the state a
   * user who has registered and not onboarded is actually in (ADR-017 §9).
   */
  memberships?: StubMembership[];
}

/**
 * Installs the stub and hands back the mock, so a test can assert on which
 * calls were made and in what order.
 *
 * `logout` and `logout-all` always succeed: no test in this suite is about
 * them failing except the ones that stub `fetch` themselves.
 */
export function stubAuthFetch({
  me = "ok",
  refresh = "ok",
  currentUser = {},
  memberships = [],
}: StubAuthFetchOptions = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);

    /*
      Organization context (ADR-017 §8). Answers 200 for any organization the
      stubbed `/me` listed, and 404 for anything else — which is exactly what
      the server does for a tenant the caller is not an active member of, and
      is deliberately indistinguishable from one that does not exist.
    */
    const contextMatch = /\/api\/v1\/organizations\/([^/?]+)$/.exec(path);
    if (contextMatch) {
      const requested = decodeURIComponent(contextMatch[1]!);
      const membership = memberships.find((m) => m.organization.id === requested);
      return Promise.resolve(
        membership
          ? jsonResponse(200, {
              success: true,
              data: { organization: { ...membership.organization, createdAt: "2026-08-17T10:00:00.000Z" }, role: membership.role },
            })
          : jsonResponse(404, {
              success: false,
              error: { code: "NOT_FOUND", message: "Organization not found" },
            }),
      );
    }

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
          ? jsonResponse(200, {
              success: true,
              data: { user: { ...CURRENT_USER, ...currentUser }, memberships },
            })
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
