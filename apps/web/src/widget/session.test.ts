import { describe, expect, it, vi } from "vitest";

import { openWidgetSession, WidgetSessionError } from "./session";

const API_BASE = "https://dashboard.example.com/api/v1/widget";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

describe("openWidgetSession", () => {
  it("POSTs to <apiBase>/session with a JSON content type and the input as the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { success: true, data: { token: "t", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openWidgetSession(API_BASE, { widgetKey: "wk_abc" });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/session`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widgetKey: "wk_abc" }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("resolves with the session data on success", async () => {
    const data = {
      token: "TOKEN",
      expiresInSeconds: 86400,
      customer: { id: "c1", name: "Ada", email: null, phone: "+44 20 7946 0958" },
      visitorKey: "V".repeat(43),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data })));

    await expect(openWidgetSession(API_BASE, { widgetKey: "wk_abc" })).resolves.toEqual(data);
    vi.unstubAllGlobals();
  });

  // A server from before ADR-038 sends no phone; the widget still gets a complete customer.
  it("fills in a missing phone as null", async () => {
    const data = { token: "TOKEN", expiresInSeconds: 86400, customer: { id: "c1", name: "Ada", email: null } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data })));

    await expect(openWidgetSession(API_BASE, { widgetKey: "wk_abc" })).resolves.toEqual({
      ...data,
      customer: { ...data.customer, phone: null },
    });
    vi.unstubAllGlobals();
  });

  it("rejects with WidgetSessionError on a refused (403) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, { success: false, error: { code: "WIDGET_SESSION_REFUSED", message: "This chat widget is not available." } }),
      ),
    );

    await expect(openWidgetSession(API_BASE, { widgetKey: "wk_bad" })).rejects.toBeInstanceOf(WidgetSessionError);
    vi.unstubAllGlobals();
  });

  it("rejects with WidgetSessionError when the body does not match the expected shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: { unexpected: true } })));

    await expect(openWidgetSession(API_BASE, { widgetKey: "wk_abc" })).rejects.toBeInstanceOf(WidgetSessionError);
    vi.unstubAllGlobals();
  });

  it("rejects with WidgetSessionError when the response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.reject(new Error("not json")) } as unknown as Response),
    );

    await expect(openWidgetSession(API_BASE, { widgetKey: "wk_abc" })).rejects.toBeInstanceOf(WidgetSessionError);
    vi.unstubAllGlobals();
  });

  it("rejects with WidgetSessionError, not the raw error, when fetch itself throws (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND internal-host.local")));

    const failure = openWidgetSession(API_BASE, { widgetKey: "wk_abc" });
    await expect(failure).rejects.toBeInstanceOf(WidgetSessionError);
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining("internal-host.local") });
    vi.unstubAllGlobals();
  });

  it("includes visitorToken, name, and email only when supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { success: true, data: { token: "t", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await openWidgetSession(API_BASE, { widgetKey: "wk_abc", visitorToken: "prev.token.value", name: "Ada", email: "ada@example.com" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      widgetKey: "wk_abc",
      visitorToken: "prev.token.value",
      name: "Ada",
      email: "ada@example.com",
    });
    vi.unstubAllGlobals();
  });
});
