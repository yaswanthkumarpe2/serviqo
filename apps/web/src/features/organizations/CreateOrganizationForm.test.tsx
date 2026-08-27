import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, callsTo, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { CreateOrganizationForm } from "./CreateOrganizationForm";

import type { Session } from "@/features/auth/AuthContext";

/** An obvious sentinel — if it reaches the DOM or storage, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

const CREATED = {
  organization: {
    id: "org1",
    name: "Acme Corp",
    slug: "acme-corp",
    status: "active",
    createdAt: "2026-08-17T10:00:00.000Z",
  },
  role: "owner",
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/**
 * Routes `/organizations` on top of the shared auth stub, so the provider's
 * own calls keep behaving while this test controls the one that matters.
 */
function stubOrganizations(
  outcome: { status: number; body: unknown } = { status: 201, body: { success: true, data: CREATED } },
) {
  const base = stubAuthFetch();
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/v1/organizations")) {
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderForm() {
  return render(
    <AuthProvider initialSession={session}>
      <CreateOrganizationForm />
    </AuthProvider>,
  );
}

const nameInput = () => screen.getByLabelText(/organization name/i);
const createButton = () => screen.getByRole("button", { name: /^create$/i });

/*
  No `vi.unstubAllGlobals()` teardown: `tests/setup.ts` installs `matchMedia`
  once at module load, and `fetch` is re-stubbed before every test regardless.
*/
beforeEach(() => {
  stubAuthFetch();
});

describe("CreateOrganizationForm", () => {
  it("submits the typed name to the organizations endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = stubOrganizations();
    renderForm();

    await user.type(nameInput(), "Acme Corp");
    await user.click(createButton());

    await waitFor(() => expect(callsTo(fetchMock, "/api/v1/organizations")).toHaveLength(1));
    const [, init] = callsTo(fetchMock, "/api/v1/organizations")[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Acme Corp" });
  });

  it("presents the access token as a bearer credential", async () => {
    const user = userEvent.setup();
    const fetchMock = stubOrganizations();
    renderForm();

    await user.type(nameInput(), "Acme");
    await user.click(createButton());

    await waitFor(() => expect(callsTo(fetchMock, "/api/v1/organizations")).toHaveLength(1));
    const [, init] = callsTo(fetchMock, "/api/v1/organizations")[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  /*
    The slug and the owner role are derived server-side (ADR-016 §1, §5), so
    the client must never send either — and never invent them for display.
  */
  it("sends no slug, ownerUserId, or role", async () => {
    const user = userEvent.setup();
    const fetchMock = stubOrganizations();
    renderForm();

    await user.type(nameInput(), "Acme");
    await user.click(createButton());

    await waitFor(() => expect(callsTo(fetchMock, "/api/v1/organizations")).toHaveLength(1));
    const [, init] = callsTo(fetchMock, "/api/v1/organizations")[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["name"]);
  });

  it("trims the submitted name", async () => {
    const user = userEvent.setup();
    const fetchMock = stubOrganizations();
    renderForm();

    await user.type(nameInput(), "   Acme Corp   ");
    await user.click(createButton());

    await waitFor(() => expect(callsTo(fetchMock, "/api/v1/organizations")).toHaveLength(1));
    const [, init] = callsTo(fetchMock, "/api/v1/organizations")[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ name: "Acme Corp" });
  });

  it("shows what the server created, including the slug it derived", async () => {
    const user = userEvent.setup();
    stubOrganizations();
    renderForm();

    await user.type(nameInput(), "Acme Corp");
    await user.click(createButton());

    expect(await screen.findByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("/acme-corp")).toBeDefined();
    expect(screen.getByText("owner")).toBeDefined();
  });

  // The slug is the part the user did not choose; inventing it client-side
  // would be a guess that silently disagrees with the server.
  it("renders the server's slug rather than one derived locally", async () => {
    const user = userEvent.setup();
    stubOrganizations({
      status: 201,
      body: { success: true, data: { ...CREATED, organization: { ...CREATED.organization, slug: "acme-corp-7" } } },
    });
    renderForm();

    await user.type(nameInput(), "Acme Corp");
    await user.click(createButton());

    expect(await screen.findByText("/acme-corp-7")).toBeDefined();
    expect(screen.queryByText("/acme-corp")).toBeNull();
  });

  it("clears the field after a success", async () => {
    const user = userEvent.setup();
    stubOrganizations();
    renderForm();

    await user.type(nameInput(), "Acme Corp");
    await user.click(createButton());

    await screen.findByText("/acme-corp");
    expect((nameInput() as HTMLInputElement).value).toBe("");
  });

  describe("submission guards", () => {
    it("disables the button until a name is typed", async () => {
      renderForm();

      expect(createButton()).toHaveProperty("disabled", true);
    });

    it("does not submit a whitespace-only name", async () => {
      const user = userEvent.setup();
      const fetchMock = stubOrganizations();
      renderForm();

      await user.type(nameInput(), "   ");

      expect(createButton()).toHaveProperty("disabled", true);
      expect(callsTo(fetchMock, "/api/v1/organizations")).toHaveLength(0);
    });

    it("submits once even when the button is clicked twice", async () => {
      const user = userEvent.setup();
      const fetchMock = stubOrganizations();
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.dblClick(createButton());

      await waitFor(() => expect(callsTo(fetchMock, "/api/v1/organizations").length).toBeGreaterThan(0));
      expect(callsTo(fetchMock, "/api/v1/organizations")).toHaveLength(1);
    });
  });

  describe("failures", () => {
    it("reports a server-described failure", async () => {
      const user = userEvent.setup();
      stubOrganizations({
        status: 409,
        body: {
          success: false,
          error: { code: "ORGANIZATION_SLUG_UNAVAILABLE", message: "Try a different name." },
        },
      });
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      expect(await screen.findByRole("alert")).toBeDefined();
      expect(screen.getByRole("alert").textContent).toContain("Try a different name.");
    });

    it("reports a validation failure", async () => {
      const user = userEvent.setup();
      stubOrganizations({
        status: 400,
        body: {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Request validation failed" },
        },
      });
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      expect(await screen.findByRole("alert")).toBeDefined();
    });

    it("keeps the typed name so it can be corrected and retried", async () => {
      const user = userEvent.setup();
      stubOrganizations({
        status: 409,
        body: { success: false, error: { code: "ORGANIZATION_SLUG_UNAVAILABLE", message: "Taken." } },
      });
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      await screen.findByRole("alert");
      expect((nameInput() as HTMLInputElement).value).toBe("Acme");
    });

    it("re-enables the button after a failure", async () => {
      const user = userEvent.setup();
      stubOrganizations({
        status: 500,
        body: { success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong" } },
      });
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      await screen.findByRole("alert");
      expect(createButton()).toHaveProperty("disabled", false);
    });

    it("reports a transport failure without echoing it", async () => {
      const user = userEvent.setup();
      const base = stubAuthFetch();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (String(url).endsWith("/api/v1/organizations")) {
            return Promise.reject(new TypeError("Failed to fetch internal-host:5432"));
          }
          return base(url, init) as Promise<Response>;
        }),
      );
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toContain("internal-host");
    });

    /*
      A 401 that survived authorizedFetch's refresh-and-replay means the
      provider already cleared the session and ProtectedRoute is redirecting.
      An error message would flash and vanish.
    */
    it("shows no error for a 401, which is a sign-out rather than a failure", async () => {
      const user = userEvent.setup();
      stubOrganizations({
        status: 401,
        body: { success: false, error: { code: "INVALID_ACCESS_TOKEN", message: "Authentication required" } },
      });
      renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      await waitFor(() => expect(createButton()).toHaveProperty("disabled", false));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("creates nothing to display when the request fails", async () => {
      const user = userEvent.setup();
      stubOrganizations({
        status: 500,
        body: { success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong" } },
      });
      const { container } = renderForm();

      await user.type(nameInput(), "Acme");
      await user.click(createButton());

      await screen.findByRole("alert");
      expect(container.querySelector(".orgForm__created")).toBeNull();
    });
  });

  // ADR-011 §1: the access token is memory-only.
  it("writes nothing to localStorage or sessionStorage", async () => {
    const user = userEvent.setup();
    stubOrganizations();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = renderForm();

    await user.type(nameInput(), "Acme Corp");
    await user.click(createButton());
    await screen.findByText("/acme-corp");

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(container.textContent).not.toContain(ACCESS_TOKEN);
    setItem.mockRestore();
  });
});
