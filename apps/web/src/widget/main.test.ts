import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrap } from "./main";

const MOUNTED_ATTRIBUTE = "data-serviqo-widget-mounted";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function appendScript(widgetKey: string, src = "https://dashboard.example.com/widget.js"): void {
  const script = document.createElement("script");
  script.src = src;
  script.setAttribute("data-serviqo-widget-key", widgetKey);
  document.body.appendChild(script);
}

afterEach(() => {
  document.body.removeAttribute(MOUNTED_ATTRIBUTE);
  document.querySelectorAll("script[data-serviqo-widget-key]").forEach((el) => el.remove());
  document.querySelectorAll("[data-serviqo-widget-host]").forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

describe("bootstrap", () => {
  it("mounts the widget once for a well-formed embed", () => {
    appendScript("wk_once");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(201, { success: true, data: { token: "t", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null } } }),
      ),
    );

    bootstrap();

    expect(document.querySelectorAll("[data-serviqo-widget-host]")).toHaveLength(1);
    expect(document.body.hasAttribute(MOUNTED_ATTRIBUTE)).toBe(true);
  });

  it("does not mount a second widget when called again — the copy-paste-twice case", () => {
    appendScript("wk_twice");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(201, { success: true, data: { token: "t", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null } } }),
      ),
    );

    bootstrap();
    bootstrap();
    bootstrap();

    expect(document.querySelectorAll("[data-serviqo-widget-host]")).toHaveLength(1);
  });

  it("mounts nothing, and does not set the mounted marker, when the embed is misconfigured", () => {
    // No script tag with the attribute at all.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    bootstrap();

    expect(document.querySelectorAll("[data-serviqo-widget-host]")).toHaveLength(0);
    expect(document.body.hasAttribute(MOUNTED_ATTRIBUTE)).toBe(false);
    warn.mockRestore();
  });
});
