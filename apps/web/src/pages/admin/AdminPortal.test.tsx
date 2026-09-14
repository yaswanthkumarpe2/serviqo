import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { AppRoutes } from "@/routes/AppRoutes";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The private operations console (ADR-032).
 *
 * Rendered through `AppRoutes` rather than by mounting the page directly,
 * because what is being tested is mostly the ROUTING: who reaches the console,
 * who is turned away, and where each of them lands. Mounting `AdminPortalPage`
 * by hand would skip the guard that is the subject.
 *
 * None of this is the security boundary. Every request the console makes is
 * re-authorized server-side by `requirePlatformAdmin`, and `platformAdmin.test.ts`
 * on the server is where that is proved. These tests are about what a browser
 * shows.
 */

const session: Session = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  accessToken: "header.payload.signature",
};

const ORGANIZATIONS = [
  {
    id: "org-acme",
    name: "Acme Corp",
    slug: "acme-corp",
    status: "active",
    hasWidgetKey: true,
    allowedOriginCount: 2,
    memberCount: 4,
    conversationCount: 17,
    owner: { id: "u9", name: "Grace Hopper", email: "grace@example.com" },
    createdAt: "2026-08-01T09:30:00.000Z",
  },
  {
    // The tenant an operator is actually here to find: installed nowhere.
    id: "org-orphan",
    name: "Orphan Ltd",
    slug: "orphan-ltd",
    status: "active",
    hasWidgetKey: false,
    allowedOriginCount: 0,
    memberCount: 1,
    conversationCount: 0,
    owner: null,
    createdAt: "2026-08-14T09:30:00.000Z",
  },
];

const USERS = [
  {
    id: "u1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    status: "active",
    emailVerifiedAt: "2026-08-01T09:30:00.000Z",
    platformRole: "admin",
    membershipCount: 1,
    createdAt: "2026-07-28T14:00:00.000Z",
  },
  {
    id: "u2",
    name: "Pending Person",
    email: "pending@example.com",
    status: "active",
    emailVerifiedAt: null,
    platformRole: "none",
    membershipCount: 0,
    createdAt: "2026-09-02T14:00:00.000Z",
  },
];

/** The whole app at one address, with whatever session the test wants. */
function renderAt(path: string, initialSession: Session | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialSession={initialSession}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Stubs an account that holds the grant, with a populated console behind it. */
function stubAdmin() {
  return stubAuthFetch({
    currentUser: { platformRole: "admin" },
    platformOrganizations: ORGANIZATIONS,
    platformUsers: USERS,
  });
}

beforeEach(() => {
  stubAuthFetch();
});

describe("the private sign-in page", () => {
  it("renders at /control/login for an anonymous visitor", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/control/login", null);

    expect(await screen.findByRole("heading", { name: "Operations console" })).toBeDefined();
  });

  /*
    The two login pages are separate surfaces (ADR-032 §14). If the private one
    ever started rendering the public one's copy, the sign-up invitation would
    be the visible symptom.
  */
  it("offers no sign-up, no password reset, and no way back to the site", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/control/login", null);
    await screen.findByRole("heading", { name: "Operations console" });

    expect(screen.queryByText(/create one/i)).toBeNull();
    expect(screen.queryByText(/forgot password/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /back to site/i })).toBeNull();
  });

  it("says nothing about who qualifies", async () => {
    stubAuthFetch({ refresh: 401 });

    const { container } = renderAt("/control/login", null);
    await screen.findByRole("heading", { name: "Operations console" });

    expect(container.textContent).not.toMatch(/admin|staff|platform role/i);
  });

  it("keeps itself out of the search index", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/control/login", null);
    await screen.findByRole("heading", { name: "Operations console" });

    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
  });

  it("sends an admin who is already signed in straight to the console", async () => {
    stubAdmin();

    renderAt("/control/login", session);

    expect(await screen.findByRole("heading", { name: "Everything, everywhere" })).toBeDefined();
  });
});

describe("the console guard", () => {
  it("sends an anonymous visitor to the private sign-in page, not the public one", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/control", null);

    expect(await screen.findByRole("heading", { name: "Operations console" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Sign in to Serviqo" })).toBeNull();
  });

  /*
    An ordinary signed-in user who types the address lands on their own
    dashboard — silently. A message explaining the refusal would confirm that
    something is behind this URL, which is the one thing an unlisted page must
    not do.
  */
  it("sends an agent to their workspace without explaining why", async () => {
    stubAuthFetch();

    renderAt("/control", session);

    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Everything, everywhere" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/permission|not allowed|admin only/i);
  });

  it("renders the console for an account the server says holds the grant", async () => {
    stubAdmin();

    renderAt("/control", session);

    expect(await screen.findByRole("heading", { name: "Everything, everywhere" })).toBeDefined();
  });

  /*
    The guard must not act on "not yet known". Treating an unread grant as no
    grant would bounce every admin to the dashboard for a frame on every load.
  */
  it("shows neither the console nor a redirect while the grant is still unread", () => {
    stubAdmin();

    renderAt("/control", session);

    expect(screen.queryByRole("heading", { name: "Everything, everywhere" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Welcome back, Ada" })).toBeNull();
  });
});

describe("the console", () => {
  it("reports the platform totals the server sent", async () => {
    stubAdmin();

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    /*
      The heading renders while the three reads are still in flight, so the
      figures are awaited rather than read immediately — 3 organizations, 41
      conversations and 260 messages, from PLATFORM_OVERVIEW.
    */
    expect(await screen.findByText("260")).toBeDefined();
    expect(screen.getByText("41")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("lists every tenant with its owner", async () => {
    stubAdmin();

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    expect(await screen.findByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("grace@example.com")).toBeDefined();
  });

  /*
    A tenant with no owner and no widget key is a broken tenant, and the
    console exists to surface exactly that rather than render it as an
    ordinary row.
  */
  it("flags a tenant that nobody owns and nothing can reach", async () => {
    stubAdmin();

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    expect(await screen.findByText("Orphan Ltd")).toBeDefined();
    expect(screen.getByText("No active owner")).toBeDefined();
    expect(screen.getByText("No key")).toBeDefined();
  });

  it("marks an account that never verified its address", async () => {
    stubAdmin();

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    const row = (await screen.findByText("pending@example.com")).closest("tr");

    /*
      Scoped to the row rather than the page. "Unverified" is also the label of
      a figure in the account-health panel above, and a page-wide match would
      pass even if the row itself said nothing.
    */
    expect(row?.textContent).toContain("Unverified");
  });

  it("presents the access token as a bearer credential on every admin call", async () => {
    const fetchMock = stubAdmin();

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    await waitFor(() => {
      const adminCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/v1/admin/"));
      expect(adminCalls.length).toBe(3);

      for (const [, init] of adminCalls) {
        const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toBe(`Bearer ${session.accessToken}`);
      }
    });
  });

  it("never renders the access token", async () => {
    const { container } = (stubAdmin(), renderAt("/control", session));
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    expect(container.textContent).not.toContain(session.accessToken);
  });

  /*
    The line ADR-032 draws, asserted from the client side too: the console
    shows volume and never content. Nothing here reads a message body because
    the API sends none, and this is the test that fails if one starts arriving
    and someone renders it.
  */
  it("requests only the three summary endpoints, never a conversation", async () => {
    const fetchMock = stubAdmin();

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    await waitFor(() => {
      const adminCalls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/admin/"));
      expect(adminCalls.length).toBe(3);
      for (const url of adminCalls) {
        expect(url).not.toContain("/messages");
        expect(url).not.toContain("/conversations/");
      }
    });
  });

  /*
    The three reads fail independently, so a console whose tenant list broke
    still shows the totals it did receive. An operator opening this page is
    usually looking at something already broken; a blank screen is the least
    useful response available.
  */
  it("keeps the figures it did receive when one list fails", async () => {
    /*
      An overview the client cannot read — a well-formed envelope with the
      wrong contents, which is what `fetchPlatformOverview` refuses. The two
      lists still answer normally.
    */
    stubAuthFetch({
      currentUser: { platformRole: "admin" },
      platformOverview: {},
      platformUsers: USERS,
    });

    renderAt("/control", session);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    // The overview could not be read, so the accounts it DID get still render.
    expect(await screen.findByText("pending@example.com")).toBeDefined();
    expect(screen.getByRole("alert")).toBeDefined();
  });
});

/**
 * Nothing links here (ADR-032 §14).
 *
 * Unlisted is a product decision and not a security control — the server
 * refuses unauthorized callers regardless — but the decision is worth holding
 * onto, and a link added in passing is exactly how it would be lost.
 */
describe("discoverability", () => {
  it("is advertised nowhere on the public sign-in page", async () => {
    stubAuthFetch({ refresh: 401 });

    const { container } = renderAt("/login", null);
    await screen.findByRole("heading", { name: "Sign in to Serviqo" });

    expect(container.innerHTML).not.toContain("/control");
    expect(container.textContent).not.toMatch(/operations console/i);
  });

  it("is advertised nowhere on the agent workspace", async () => {
    stubAuthFetch({ currentUser: { kind: "agent" } });

    const { container } = renderAt("/agent", session);
    await screen.findByRole("heading", { name: "Welcome back, Ada" });

    expect(container.innerHTML).not.toContain("/control");
  });
});
