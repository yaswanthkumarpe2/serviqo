import { afterEach, describe, expect, it, vi } from "vitest";

import { loadStoredToken, storeToken } from "./storage";

describe("widget token storage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("returns null when nothing has been stored for this widget key", () => {
    expect(loadStoredToken("wk_never_stored")).toBeNull();
  });

  it("round-trips a stored token", () => {
    storeToken("wk_abc", "TOKEN_VALUE");
    expect(loadStoredToken("wk_abc")).toBe("TOKEN_VALUE");
  });

  it("uses sessionStorage rather than localStorage (ADR-021 §6)", () => {
    storeToken("wk_scope", "TOKEN_VALUE");
    expect(window.sessionStorage.getItem("serviqo_widget_token::wk_scope")).toBe("TOKEN_VALUE");
    expect(window.localStorage.getItem("serviqo_widget_token::wk_scope")).toBeNull();
  });

  it("namespaces storage by widget key, so two tenants never collide in one tab", () => {
    storeToken("wk_tenant_a", "TOKEN_A");
    storeToken("wk_tenant_b", "TOKEN_B");

    expect(loadStoredToken("wk_tenant_a")).toBe("TOKEN_A");
    expect(loadStoredToken("wk_tenant_b")).toBe("TOKEN_B");
  });

  it("returns null rather than throwing when sessionStorage.getItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(loadStoredToken("wk_abc")).toBeNull();

    spy.mockRestore();
  });

  it("does not throw when sessionStorage.setItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(() => storeToken("wk_abc", "TOKEN_VALUE")).not.toThrow();

    spy.mockRestore();
  });
});
