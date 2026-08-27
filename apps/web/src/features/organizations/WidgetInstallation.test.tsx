import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, callsTo, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { WidgetInstallation } from "./WidgetInstallation";

import type { Session } from "@/features/auth/AuthContext";

/** An obvious sentinel — if it reaches the DOM or storage, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";
const ORGANIZATION_ID = "org-acme";
const WIDGET_KEY = "wk_" + "a".repeat(43);
const ROTATED_KEY = "wk_" + "b".repeat(43);

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

interface StubOutcomes {
  get?: { status: number; body: unknown };
  put?: { status: number; body: unknown };
  rotate?: { status: number; body: unknown };
}

const CONFIG_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/widget-config`;

function defaultSettings(overrides: { widgetKey?: string; allowedOrigins?: string[] } = {}) {
  return {
    success: true,
    data: { widgetKey: overrides.widgetKey ?? WIDGET_KEY, allowedOrigins: overrides.allowedOrigins ?? [] },
  };
}

/** Routes widget-config calls on top of the shared auth stub, matching `CreateOrganizationForm.test.tsx`'s pattern. */
function stubWidgetConfig(outcomes: StubOutcomes = {}) {
  const base = stubAuthFetch();
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (path.endsWith(`${CONFIG_PATH}/origins`) && method === "PUT") {
      const outcome = outcomes.put ?? { status: 200, body: defaultSettings({ allowedOrigins: ["https://shop.example.com"] }) };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.endsWith(`${CONFIG_PATH}/rotate-key`) && method === "POST") {
      const outcome = outcomes.rotate ?? { status: 200, body: defaultSettings({ widgetKey: ROTATED_KEY }) };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.endsWith(CONFIG_PATH) && method === "GET") {
      const outcome = outcomes.get ?? { status: 200, body: defaultSettings() };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderWidgetInstallation() {
  return render(
    <AuthProvider initialSession={session}>
      <WidgetInstallation organizationId={ORGANIZATION_ID} />
    </AuthProvider>,
  );
}

beforeEach(() => {
  stubAuthFetch();
});

describe("WidgetInstallation", () => {
  describe("loading and success", () => {
    it("shows a loading state before the settings arrive", () => {
      stubWidgetConfig();
      renderWidgetInstallation();

      expect(screen.getByRole("status").textContent).toMatch(/loading widget installation/i);
    });

    it("displays the widget key", async () => {
      stubWidgetConfig();
      renderWidgetInstallation();

      expect(await screen.findByDisplayValue(WIDGET_KEY)).toBeDefined();
    });

    it("builds the embed snippet from the widget key and the current origin", async () => {
      stubWidgetConfig();
      renderWidgetInstallation();

      const snippet = (await screen.findByLabelText(/embed snippet/i)) as HTMLTextAreaElement;
      expect(snippet.value).toContain(WIDGET_KEY);
      expect(snippet.value).toContain(window.location.origin);
      expect(snippet.value).not.toContain("localhost:5173");
    });

    it("shows the configured origins", async () => {
      stubWidgetConfig({ get: { status: 200, body: defaultSettings({ allowedOrigins: ["https://shop.example.com"] }) } });
      renderWidgetInstallation();

      expect(await screen.findByText("https://shop.example.com")).toBeDefined();
    });

    it("says explicitly when no origin is allowed", async () => {
      stubWidgetConfig({ get: { status: 200, body: defaultSettings({ allowedOrigins: [] }) } });
      renderWidgetInstallation();

      expect(await screen.findByText(/no origins allowed yet/i)).toBeDefined();
    });

    it("requests the widget-config endpoint for the given organization", async () => {
      const fetchMock = stubWidgetConfig();
      renderWidgetInstallation();

      await waitFor(() => expect(callsTo(fetchMock, CONFIG_PATH)).toHaveLength(1));
    });

    it("presents the access token as a bearer credential", async () => {
      const fetchMock = stubWidgetConfig();
      renderWidgetInstallation();

      await screen.findByDisplayValue(WIDGET_KEY);
      const [, init] = callsTo(fetchMock, CONFIG_PATH)[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    });
  });

  describe("permission and error states", () => {
    it("shows a permission message on a 403", async () => {
      stubWidgetConfig({
        get: { status: 403, body: { success: false, error: { code: "INSUFFICIENT_PERMISSION", message: "Forbidden" } } },
      });
      renderWidgetInstallation();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/do not have permission/i);
    });

    it("shows a generic error for a server failure", async () => {
      stubWidgetConfig({
        get: { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong" } } },
      });
      renderWidgetInstallation();

      expect(await screen.findByRole("alert")).toBeDefined();
    });

    it("reports a transport failure without echoing it", async () => {
      const base = stubAuthFetch();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (String(url).endsWith(CONFIG_PATH)) return Promise.reject(new TypeError("Failed to fetch internal-host:5432"));
          return base(url, init) as Promise<Response>;
        }),
      );
      renderWidgetInstallation();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toContain("internal-host");
    });

    it("never renders the access token", async () => {
      stubWidgetConfig();
      const { container } = renderWidgetInstallation();

      await screen.findByDisplayValue(WIDGET_KEY);
      expect(container.textContent).not.toContain(ACCESS_TOKEN);
    });
  });

  describe("copy behaviour", () => {
    it("copies the widget key to the clipboard", async () => {
      const user = userEvent.setup();
      // user-event's own setup() installs its in-memory Clipboard polyfill
      // onto `navigator.clipboard` — jsdom itself implements none — so the
      // spy is attached only after `setup()` has run, to the real object it
      // just created rather than one this test would otherwise be clobbered.
      vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /^copy$/i }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(WIDGET_KEY);
      expect(await screen.findByText(/^copied!$/i)).toBeDefined();
    });

    it("copies the embed snippet, including the widget key", async () => {
      const user = userEvent.setup();
      vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /copy snippet/i }));

      const [copied] = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(copied).toContain(WIDGET_KEY);
    });
  });

  describe("allowed-origin management", () => {
    it("adds a typed origin to the draft list", async () => {
      const user = userEvent.setup();
      stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByText(/no origins allowed yet/i);

      await user.type(screen.getByLabelText(/add an origin/i), "https://new.example.com");
      await user.click(screen.getByRole("button", { name: /^add$/i }));

      expect(screen.getByText("https://new.example.com")).toBeDefined();
    });

    it("does not add the same origin twice", async () => {
      const user = userEvent.setup();
      stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByText(/no origins allowed yet/i);
      const input = screen.getByLabelText(/add an origin/i);

      await user.type(input, "https://new.example.com");
      await user.click(screen.getByRole("button", { name: /^add$/i }));
      await user.type(input, "https://new.example.com");
      await user.click(screen.getByRole("button", { name: /^add$/i }));

      expect(screen.getAllByText("https://new.example.com")).toHaveLength(1);
    });

    it("removes an origin from the draft list", async () => {
      const user = userEvent.setup();
      stubWidgetConfig({ get: { status: 200, body: defaultSettings({ allowedOrigins: ["https://shop.example.com"] }) } });
      renderWidgetInstallation();
      await screen.findByText("https://shop.example.com");

      await user.click(screen.getByRole("button", { name: /remove https:\/\/shop\.example\.com/i }));

      expect(screen.queryByText("https://shop.example.com")).toBeNull();
      expect(screen.getByText(/no origins allowed yet/i)).toBeDefined();
    });

    it("disables Save changes until the draft differs from what was loaded", async () => {
      stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByText(/no origins allowed yet/i);

      expect(screen.getByRole("button", { name: /save changes/i })).toHaveProperty("disabled", true);
    });

    it("sends the full draft list on save", async () => {
      const user = userEvent.setup();
      const fetchMock = stubWidgetConfig({
        put: { status: 200, body: defaultSettings({ allowedOrigins: ["https://new.example.com"] }) },
      });
      renderWidgetInstallation();
      await screen.findByText(/no origins allowed yet/i);

      await user.type(screen.getByLabelText(/add an origin/i), "https://new.example.com");
      await user.click(screen.getByRole("button", { name: /^add$/i }));
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => expect(callsTo(fetchMock, `${CONFIG_PATH}/origins`)).toHaveLength(1));
      const [, init] = callsTo(fetchMock, `${CONFIG_PATH}/origins`)[0] as [string, RequestInit];
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({ allowedOrigins: ["https://new.example.com"] });
    });

    it("shows confirmation after a successful save", async () => {
      const user = userEvent.setup();
      stubWidgetConfig({ put: { status: 200, body: defaultSettings({ allowedOrigins: ["https://new.example.com"] }) } });
      renderWidgetInstallation();
      await screen.findByText(/no origins allowed yet/i);

      await user.type(screen.getByLabelText(/add an origin/i), "https://new.example.com");
      await user.click(screen.getByRole("button", { name: /^add$/i }));
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      expect(await screen.findByText(/^saved\.$/i)).toBeDefined();
    });

    it("reports a server-described validation failure", async () => {
      const user = userEvent.setup();
      stubWidgetConfig({
        put: {
          status: 400,
          body: {
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "Request validation failed",
              details: [{ field: "allowedOrigins.0", message: "must be an http(s) origin with no path" }],
            },
          },
        },
      });
      renderWidgetInstallation();
      await screen.findByText(/no origins allowed yet/i);

      await user.type(screen.getByLabelText(/add an origin/i), "not-an-origin");
      await user.click(screen.getByRole("button", { name: /^add$/i }));
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/must be an http\(s\) origin/i);
    });
  });

  describe("key rotation", () => {
    it("requires an explicit confirmation before rotating", async () => {
      const user = userEvent.setup();
      const fetchMock = stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /^rotate key$/i }));

      expect(screen.getByText(/immediately invalidates/i)).toBeDefined();
      expect(callsTo(fetchMock, `${CONFIG_PATH}/rotate-key`)).toHaveLength(0);
    });

    it("cancels without rotating", async () => {
      const user = userEvent.setup();
      const fetchMock = stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /^rotate key$/i }));
      await user.click(screen.getByRole("button", { name: /^cancel$/i }));

      expect(screen.queryByText(/immediately invalidates/i)).toBeNull();
      expect(callsTo(fetchMock, `${CONFIG_PATH}/rotate-key`)).toHaveLength(0);
    });

    it("rotates the key after confirmation and displays the new one", async () => {
      const user = userEvent.setup();
      const fetchMock = stubWidgetConfig();
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /^rotate key$/i }));
      await user.click(screen.getByRole("button", { name: /yes, rotate the key/i }));

      await waitFor(() => expect(callsTo(fetchMock, `${CONFIG_PATH}/rotate-key`)).toHaveLength(1));
      expect(await screen.findByDisplayValue(ROTATED_KEY)).toBeDefined();
      expect(screen.queryByDisplayValue(WIDGET_KEY)).toBeNull();
    });

    it("reports a rotation failure and keeps the old key displayed", async () => {
      const user = userEvent.setup();
      stubWidgetConfig({
        rotate: { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong" } } },
      });
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /^rotate key$/i }));
      await user.click(screen.getByRole("button", { name: /yes, rotate the key/i }));

      expect(await screen.findByRole("alert")).toBeDefined();
      expect(screen.getByDisplayValue(WIDGET_KEY)).toBeDefined();
    });
  });

  describe("credential hygiene", () => {
    it("writes nothing to localStorage or sessionStorage", async () => {
      const user = userEvent.setup();
      stubWidgetConfig();
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      renderWidgetInstallation();
      await screen.findByDisplayValue(WIDGET_KEY);

      await user.click(screen.getByRole("button", { name: /^rotate key$/i }));
      await user.click(screen.getByRole("button", { name: /yes, rotate the key/i }));
      await screen.findByDisplayValue(ROTATED_KEY);

      expect(setItem).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      setItem.mockRestore();
    });
  });
});
