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
  /*
    What the server reports for very nearly everyone (ADR-032 §6). Present
    here rather than omitted so the default stub matches the real payload —
    a test that wants the operations console overrides it through
    `currentUser`.
  */
  platformRole: "none",
  /*
    Which staff surface this account belongs on (ADR-037). Defaults to
    `agent`, matching the server's default — every account is invited staff —
    and a test that wants the operations console overrides it through
    `currentUser`.
  */
  kind: "agent",
  createdAt: "2026-07-28T14:00:00.000Z",
};

/** What the login/refresh endpoints report — deliberately narrower than `/me`. */
export const SESSION_USER = {
  id: CURRENT_USER.id,
  name: CURRENT_USER.name,
  email: CURRENT_USER.email,
  // Login reports the kind so the client can route without a second request
  // (ADR-034 §1).
  kind: CURRENT_USER.kind,
};

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
  /** What `GET /admin/overview` reports, for console tests (ADR-032 §3). */
  platformOverview?: unknown;
  /** What `GET /admin/organizations` reports. */
  platformOrganizations?: unknown[];
  /** What `GET /admin/users` reports. */
  platformUsers?: unknown[];
}

/** A readable overview, so console tests do not each restate the shape. */
export const PLATFORM_OVERVIEW = {
  totals: { organizations: 3, users: 7, customers: 12, conversations: 41, messages: 260 },
  users: { verified: 5, unverified: 2, disabled: 0, platformAdmins: 1 },
  conversations: { open: 9, closed: 32, unassigned: 4 },
};

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
  platformOverview = PLATFORM_OVERVIEW,
  platformOrganizations = [],
  platformUsers = [],
}: StubAuthFetchOptions = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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

    /*
      The platform console (ADR-032 §3). Answered here rather than left to the
      catch-all below, because that returns `{ data: {} }` — which
      `fetchPlatformOverview` correctly rejects as unreadable, so every console
      test would otherwise assert against an error state.

      Refused with 403 unless the stubbed `/me` says this account holds the
      grant, which is what the server does and what lets a test exercise the
      refusal by changing one field.
    */
    if (path.includes("/api/v1/admin/")) {
      const isAdmin = { ...CURRENT_USER, ...currentUser }.platformRole === "admin";
      if (!isAdmin) {
        return Promise.resolve(
          jsonResponse(403, {
            success: false,
            error: { code: "INSUFFICIENT_PERMISSION", message: "You do not have permission to perform this action" },
          }),
        );
      }

      const method = init?.method ?? "GET";

      // Console writes (ADR-039): answered with plausible results so a test can
      // assert on the request it made and on what the page shows afterwards.
      if (method === "POST" && path.endsWith("/admin/organizations")) {
        const body = JSON.parse(String(init?.body)) as { name: string; owner: { name: string; email: string } };
        const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            data: {
              organization: {
                id: "org-new",
                name: body.name,
                slug,
                status: "active",
                widgetUrl: `http://localhost:5173/widget/${slug}`,
                createdAt: "2026-09-14T10:00:00.000Z",
              },
              owner: {
                membershipId: "m-new",
                userId: "u-new",
                name: body.owner.name,
                email: body.owner.email,
                role: "owner",
                status: "active",
                verified: false,
                joinedAt: "2026-09-14T10:00:00.000Z",
              },
              accountCreated: true,
            },
          }),
        );
      }
      if (method === "PATCH" && path.endsWith("/status")) {
        return Promise.resolve(jsonResponse(200, { success: true, data: { organization: {} } }));
      }
      if (method === "POST" && path.endsWith("/members")) {
        const body = JSON.parse(String(init?.body)) as { name: string; email: string; role: string };
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            data: { member: { ...body, membershipId: "m-x", userId: "u-x", status: "active", verified: false }, accountCreated: true },
          }),
        );
      }

      if (path.endsWith("/overview")) {
        return Promise.resolve(jsonResponse(200, { success: true, data: platformOverview }));
      }
      if (path.includes("/admin/organizations")) {
        return Promise.resolve(
          jsonResponse(200, { success: true, data: { organizations: platformOrganizations, total: platformOrganizations.length } }),
        );
      }
      if (path.includes("/admin/users")) {
        return Promise.resolve(
          jsonResponse(200, { success: true, data: { users: platformUsers, total: platformUsers.length } }),
        );
      }
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
