import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";

import { WidgetAppearanceSettings } from "./WidgetAppearanceSettings";

import type { Session } from "@/features/auth/AuthContext";

/** The chat appearance & hours form (ADR-040 §1). */

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: "TOKEN",
};

const APPEARANCE = {
  accentColor: "#14684A",
  title: null,
  welcomeMessage: null,
  awayMessage: null,
  businessHours: { enabled: false, timezone: "UTC", days: [null, null, null, null, null, null, null] },
};

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stub(readStatus = 200) {
  const base = stubAuthFetch();
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/widget-config/appearance") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return Promise.resolve(json(200, { success: true, data: { widgetKey: "wk", allowedOrigins: [], appearance: body } }));
    }
    if (path.endsWith("/widget-config")) {
      return Promise.resolve(
        readStatus === 200
          ? json(200, { success: true, data: { widgetKey: "wk", allowedOrigins: [], appearance: APPEARANCE } })
          : json(readStatus, { success: false, error: { code: "INSUFFICIENT_PERMISSION", message: "no" } }),
      );
    }
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSettings() {
  return render(
    <AuthProvider initialSession={session}>
      <WidgetAppearanceSettings organizationId="org-1" organizationName="CentralService" />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WidgetAppearanceSettings", () => {
  it("previews the organisation's name as the title until one is set", async () => {
    stub();
    renderSettings();

    expect(await screen.findByText("CentralService")).toBeDefined();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Chat title"), "Help desk");
    expect(screen.getByText("Help desk")).toBeDefined();
  });

  it("switches the preview between the available and away messages", async () => {
    stub();
    const user = userEvent.setup();
    renderSettings();

    await user.type(await screen.findByLabelText("Message while you’re away"), "Back at nine");
    await user.click(screen.getByRole("button", { name: "Away" }));

    expect(screen.getByText("Back at nine")).toBeDefined();
  });

  it("saves colour, messages and business hours together", async () => {
    const fetchMock = stub();
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Use #7C3AED" }));
    await user.type(screen.getByLabelText("Message while you’re available"), "Hi there");
    await user.click(screen.getByLabelText("Only show as available during business hours"));
    await user.click(screen.getByLabelText("Monday"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/saved/i));
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    const body = JSON.parse(String((put[1] as RequestInit).body));
    expect(body.accentColor).toBe("#7C3AED");
    expect(body.welcomeMessage).toBe("Hi there");
    expect(body.businessHours.enabled).toBe(true);
    expect(body.businessHours.days[1]).toEqual({ open: "09:00", close: "17:00" });
  });

  it("disables saving until something changed", async () => {
    stub();
    renderSettings();

    expect(((await screen.findByRole("button", { name: "Save changes" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows nothing to a role that cannot manage the organisation", async () => {
    stub(403);
    const { container } = renderSettings();

    await waitFor(() => expect(screen.queryByText(/Loading chat appearance/)).toBeNull());
    expect(container.textContent).toBe("");
  });
});
