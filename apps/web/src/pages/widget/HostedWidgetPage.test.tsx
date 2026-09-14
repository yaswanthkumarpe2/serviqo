import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeSocketHarness } from "@/widget/testing/fakeSocket";

import { HostedWidgetPage } from "./HostedWidgetPage";

/**
 * An organisation's chat link, as a customer opens it (ADR-038 §6).
 *
 * What matters here is the handoff: the slug in the URL decides the
 * organisation, the page asks the server which widget key that is, and the
 * widget opens an anonymous session with exactly that key — with nothing a
 * customer has to sign in to, and no way to name a different organisation.
 */

const ENTRY = { name: "CentralService", widgetKey: "wk_centralservice" };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubServer(directory: () => Response | Promise<Response> = () => jsonResponse(200, { success: true, data: ENTRY })) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/widget/organizations/")) return Promise.resolve(directory());
    if (path.endsWith("/session")) {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          data: { token: "TOKEN_1", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null, phone: null } },
        }),
      );
    }
    if (path.endsWith("/conversations") && init?.method === "POST") {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          data: { id: "6a8c0fbf909d5192a6bbd66f", status: "open", createdAt: "x", lastMessageAt: "x" },
        }),
      );
    }
    if (path.includes("/messages")) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  const harness = createFakeSocketHarness();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/widget/:slug" element={<HostedWidgetPage widgetOptions={{ socketFactory: harness.factory }} />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, harness };
}

function widgetShadow(): ShadowRoot | null {
  return document.querySelector("[data-serviqo-widget-host]")?.shadowRoot ?? null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("HostedWidgetPage", () => {
  it("looks up the organisation named by the link, and shows its name", async () => {
    const fetchMock = stubServer();
    renderAt("/widget/centralservice");

    expect(await screen.findByText("CentralService")).toBeDefined();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/widget/organizations/centralservice");
  });

  it("opens an anonymous chat with that organisation's widget key, without asking anyone to sign in", async () => {
    const fetchMock = stubServer();
    const { unmount } = renderAt("/widget/centralservice");

    await waitFor(() => expect(widgetShadow()?.querySelector(".chat")).toBeTruthy());

    const sessionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/session"))!;
    expect(JSON.parse(String((sessionCall[1] as RequestInit).body))).toEqual({ widgetKey: "wk_centralservice" });
    expect(screen.queryByText(/sign in|log in|password/i)).toBeNull();

    unmount();
  });

  it("sends no credentials on the public lookup", async () => {
    const fetchMock = stubServer();
    renderAt("/widget/centralservice");

    await screen.findByText("CentralService");

    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe("omit");
  });

  it("says plainly when a link leads nowhere", async () => {
    stubServer(() => jsonResponse(404, { success: false, error: { message: "This chat is not available." } }));
    renderAt("/widget/no-such-organisation");

    expect(await screen.findByRole("heading", { name: /this chat isn.t available/i })).toBeDefined();
    expect(widgetShadow()).toBeNull();
  });

  it("offers a retry when the server could not be reached, and recovers", async () => {
    let failures = 1;
    stubServer(() => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return jsonResponse(200, { success: true, data: ENTRY });
    });
    const user = userEvent.setup();
    renderAt("/widget/centralservice");

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("CentralService")).toBeDefined();
  });

  it("removes the chat when the page goes away", async () => {
    stubServer();
    const { unmount } = renderAt("/widget/centralservice");
    await waitFor(() => expect(widgetShadow()).not.toBeNull());

    unmount();

    expect(document.querySelector("[data-serviqo-widget-host]")).toBeNull();
  });
});
