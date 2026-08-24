import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveWidgetConfig } from "./config";

/**
 * `document.currentScript` is a read-only, spec-defined accessor tied to an
 * actively-executing classic script — jsdom does not let a test assign it
 * directly. Every test here therefore exercises the fallback path
 * (`config.ts`'s attribute-selector query), which is also what a real page
 * falls back to when `currentScript` is unavailable (ADR-021 §4). Both paths
 * share the same widget-key and src-resolution logic after the element is
 * found, so this covers the behavior that actually matters.
 */
describe("resolveWidgetConfig", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    document.querySelectorAll("script[data-serviqo-widget-key]").forEach((el) => el.remove());
  });

  function appendScript(attrs: { src?: string; widgetKey?: string }): HTMLScriptElement {
    const script = document.createElement("script");
    if (attrs.src !== undefined) script.src = attrs.src;
    if (attrs.widgetKey !== undefined) script.setAttribute("data-serviqo-widget-key", attrs.widgetKey);
    document.body.appendChild(script);
    return script;
  }

  it("resolves the widget key and an absolute API origin from the script's own src", () => {
    appendScript({ src: "https://cdn.example.com/widget.js", widgetKey: "wk_abc123" });

    const config = resolveWidgetConfig();

    expect(config).toEqual({ widgetKey: "wk_abc123", apiBase: "https://cdn.example.com/api/v1/widget" });
  });

  it("resolves a relative src against the current document", () => {
    appendScript({ src: "/widget.js", widgetKey: "wk_relative" });

    const config = resolveWidgetConfig();

    expect(config).not.toBeNull();
    expect(config!.apiBase).toBe(`${window.location.origin}/api/v1/widget`);
  });

  it("trims whitespace around the widget key", () => {
    appendScript({ src: "https://cdn.example.com/widget.js", widgetKey: "  wk_padded  " });

    expect(resolveWidgetConfig()!.widgetKey).toBe("wk_padded");
  });

  it("returns null and warns when no script tag carries the attribute at all", () => {
    expect(resolveWidgetConfig()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns null and warns when the attribute is present but empty", () => {
    appendScript({ src: "https://cdn.example.com/widget.js", widgetKey: "" });

    expect(resolveWidgetConfig()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns null when the script tag has no src to resolve an origin from", () => {
    appendScript({ widgetKey: "wk_no_src" });

    expect(resolveWidgetConfig()).toBeNull();
  });

  it("picks the last matching script when more than one is present", () => {
    appendScript({ src: "https://first.example.com/widget.js", widgetKey: "wk_first" });
    appendScript({ src: "https://second.example.com/widget.js", widgetKey: "wk_second" });

    expect(resolveWidgetConfig()!.widgetKey).toBe("wk_second");
  });
});
