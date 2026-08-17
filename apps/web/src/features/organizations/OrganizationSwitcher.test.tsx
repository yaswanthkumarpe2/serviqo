import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, callsTo, stubAuthFetch, stubMembership } from "@/features/auth/testing/stubAuthFetch";
import { OrganizationSwitcher } from "./OrganizationSwitcher";

import type { Session } from "@/features/auth/AuthContext";
import type { StubMembership } from "@/features/auth/testing/stubAuthFetch";

/** An obvious sentinel — if it reaches the DOM or storage, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

const ACME = stubMembership("org-acme", "Acme Corp", "owner");
const GLOBEX = stubMembership("org-globex", "Globex", "agent");
const INITECH = stubMembership("org-initech", "Initech", "supervisor");

function renderSwitcher(memberships: StubMembership[]) {
  const fetchMock = stubAuthFetch({ memberships });
  render(
    <AuthProvider initialSession={session}>
      <OrganizationSwitcher memberships={memberships} />
    </AuthProvider>,
  );
  return fetchMock;
}

const select = () => screen.getByLabelText(/active organization/i) as HTMLSelectElement;

/*
  No `vi.unstubAllGlobals()` teardown: `tests/setup.ts` installs `matchMedia`
  once at module load, and `fetch` is re-stubbed before every test regardless.
*/
beforeEach(() => {
  stubAuthFetch();
});

describe("OrganizationSwitcher", () => {
  describe("with no memberships", () => {
    it("says so explicitly rather than showing an empty control", () => {
      renderSwitcher([]);

      expect(screen.getByRole("heading", { name: /no organization yet/i })).toBeDefined();
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("requests no organization context", async () => {
      const fetchMock = renderSwitcher([]);

      await waitFor(() => expect(screen.getByRole("heading", { name: /no organization yet/i })).toBeDefined());
      expect(callsTo(fetchMock, "/api/v1/organizations/org-acme")).toHaveLength(0);
    });
  });

  describe("with one membership", () => {
    it("names the organization without offering a choice", async () => {
      renderSwitcher([ACME]);

      expect(await screen.findByText("Acme Corp")).toBeDefined();
      // A select with one option is a control that does nothing.
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("loads and shows the server-confirmed role", async () => {
      renderSwitcher([ACME]);

      expect(await screen.findByText("owner")).toBeDefined();
      expect(screen.getByText("/acme-corp")).toBeDefined();
    });

    it("asks the server for that organization's context", async () => {
      const fetchMock = renderSwitcher([ACME]);

      await screen.findByText("owner");
      expect(callsTo(fetchMock, "/api/v1/organizations/org-acme")).toHaveLength(1);
    });

    it("presents the access token as a bearer credential", async () => {
      const fetchMock = renderSwitcher([ACME]);

      await screen.findByText("owner");
      const [, init] = callsTo(fetchMock, "/api/v1/organizations/org-acme")[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    });
  });

  describe("with several memberships", () => {
    it("offers exactly the organizations the caller belongs to", async () => {
      renderSwitcher([ACME, GLOBEX, INITECH]);

      const options = [...select().options].map((option) => option.textContent);
      expect(options).toEqual(["Acme Corp", "Globex", "Initech"]);
    });

    /*
      The isolation property at the UI layer: options come from /me, so an
      organization the caller does not belong to cannot appear here at all
      (ADR-017 §10).
    */
    it("offers no organization outside the list it was given", async () => {
      renderSwitcher([ACME]);

      await screen.findByText("owner");
      expect(screen.queryByText("Globex")).toBeNull();
      expect(screen.queryByText("Initech")).toBeNull();
    });

    it("selects the first organization by default", async () => {
      renderSwitcher([ACME, GLOBEX]);

      expect(select().value).toBe("org-acme");
      expect(await screen.findByText("owner")).toBeDefined();
    });

    it("loads the newly selected organization's context on switch", async () => {
      const user = userEvent.setup();
      const fetchMock = renderSwitcher([ACME, GLOBEX]);
      await screen.findByText("owner");

      await user.selectOptions(select(), "org-globex");

      await waitFor(() => expect(callsTo(fetchMock, "/api/v1/organizations/org-globex")).toHaveLength(1));
    });

    // Switching changes which id the client puts in URLs, and nothing else.
    it("shows the role the server confirmed for the newly selected organization", async () => {
      const user = userEvent.setup();
      renderSwitcher([ACME, GLOBEX]);
      await screen.findByText("owner");

      await user.selectOptions(select(), "org-globex");

      expect(await screen.findByText("agent")).toBeDefined();
      expect(screen.queryByText("owner")).toBeNull();
      expect(screen.getByText("/globex")).toBeDefined();
    });

    it("changes only the context, never the signed-in identity", async () => {
      const user = userEvent.setup();
      const fetchMock = renderSwitcher([ACME, GLOBEX]);
      await screen.findByText("owner");

      await user.selectOptions(select(), "org-globex");
      await screen.findByText("agent");

      // No re-authentication and no second /me: switching is not a login.
      expect(callsTo(fetchMock, "/auth/me")).toHaveLength(0);
      expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(0);
      expect(callsTo(fetchMock, "/auth/login")).toHaveLength(0);
    });

    it("does not refetch the organization already loaded", async () => {
      const user = userEvent.setup();
      const fetchMock = renderSwitcher([ACME, GLOBEX]);
      await screen.findByText("owner");

      await user.selectOptions(select(), "org-globex");
      await screen.findByText("agent");
      await user.selectOptions(select(), "org-acme");
      await screen.findByText("owner");

      expect(callsTo(fetchMock, "/api/v1/organizations/org-globex")).toHaveLength(1);
    });
  });

  describe("loading and failure states", () => {
    it("shows a loading state before the context arrives", () => {
      renderSwitcher([ACME]);

      // Synchronously after mount, nothing is confirmed yet.
      expect(screen.getByRole("status").textContent).toMatch(/loading organization/i);
    });

    it("marks the context region busy while it loads and not afterwards", async () => {
      const { container } = render(
        <AuthProvider initialSession={session}>
          <OrganizationSwitcher memberships={[ACME]} />
        </AuthProvider>,
      );
      stubAuthFetch({ memberships: [ACME] });
      const region = () => container.querySelector(".orgSwitcher__context");

      expect(region()?.getAttribute("aria-busy")).toBe("true");
      await waitFor(() => expect(region()?.getAttribute("aria-busy")).toBe("false"));
    });

    it("shows no role until the server confirms one", () => {
      renderSwitcher([ACME]);

      expect(screen.queryByText("owner")).toBeNull();
    });

    /*
      A 404 is what the server answers for a tenant the caller cannot enter —
      suspended, membership revoked, or never theirs. It is deliberately
      indistinguishable (ADR-017 §6), so the message claims only what is known.
    */
    it("reports an organization the server refuses", async () => {
      const unlisted = stubMembership("org-gone", "Gone Ltd");
      // `/me` claims it, the context endpoint refuses it — the shape of a
      // membership revoked between the two calls.
      stubAuthFetch({ memberships: [] });
      render(
        <AuthProvider initialSession={session}>
          <OrganizationSwitcher memberships={[unlisted]} />
        </AuthProvider>,
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/no longer available/i);
    });

    it("shows no role for a refused organization", async () => {
      const unlisted = stubMembership("org-gone", "Gone Ltd", "owner");
      stubAuthFetch({ memberships: [] });
      render(
        <AuthProvider initialSession={session}>
          <OrganizationSwitcher memberships={[unlisted]} />
        </AuthProvider>,
      );

      await screen.findByRole("alert");
      // The role /me listed must not be displayed as confirmed.
      expect(screen.queryByText("owner")).toBeNull();
    });

    it("reports a transport failure without echoing it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (String(url).includes("/api/v1/organizations/")) {
            return Promise.reject(new TypeError("Failed to fetch internal-host:5432"));
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) } as Response);
        }),
      );
      render(
        <AuthProvider initialSession={session}>
          <OrganizationSwitcher memberships={[ACME]} />
        </AuthProvider>,
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toContain("internal-host");
    });
  });

  describe("credential and authorization hygiene", () => {
    // ADR-017 §10: a UI that remembered "I am an owner" is a UI that can be
    // edited into one.
    it("stores no role, permission, or organization state", async () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      renderSwitcher([ACME, GLOBEX]);
      await screen.findByText("owner");

      expect(setItem).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      setItem.mockRestore();
    });

    it("keeps nothing in storage after switching", async () => {
      const user = userEvent.setup();
      renderSwitcher([ACME, GLOBEX]);
      await screen.findByText("owner");

      await user.selectOptions(select(), "org-globex");
      await screen.findByText("agent");

      const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
      expect(stored).not.toContain("agent");
      expect(stored).not.toContain("org-globex");
    });

    it("never renders the access token", async () => {
      const { container } = render(
        <AuthProvider initialSession={session}>
          <OrganizationSwitcher memberships={[ACME]} />
        </AuthProvider>,
      );
      stubAuthFetch({ memberships: [ACME] });

      await waitFor(() => expect(container.textContent).not.toContain(ACCESS_TOKEN));
    });

    it("displays no permission list", async () => {
      renderSwitcher([ACME]);
      await screen.findByText("owner");

      // A permission list on screen is one a client could authorize itself
      // from; the server re-proves every request regardless (ADR-017 §10).
      expect(document.body.textContent).not.toContain("organization.read");
      expect(document.body.textContent).not.toContain("member.manage");
    });
  });
});
