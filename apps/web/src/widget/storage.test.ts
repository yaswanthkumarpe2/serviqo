import { afterEach, describe, expect, it, vi } from "vitest";

import { clearStoredToken, loadStoredToken, loadVisitorKey, storeToken, storeVisitorKey } from "./storage";

describe("widget visitor storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("returns null when nothing has been stored for this widget key", () => {
    expect(loadStoredToken("wk_never_stored")).toBeNull();
    expect(loadVisitorKey("wk_never_stored")).toBeNull();
  });

  it("round-trips a stored token and visitor key", () => {
    storeToken("wk_abc", "TOKEN_VALUE");
    storeVisitorKey("wk_abc", "VISITOR_KEY");

    expect(loadStoredToken("wk_abc")).toBe("TOKEN_VALUE");
    expect(loadVisitorKey("wk_abc")).toBe("VISITOR_KEY");
  });

  /*
    ADR-038 §3: customers never sign in, so the browser's memory is their only
    continuity. sessionStorage forgot them whenever the tab closed.
  */
  it("uses localStorage, so a visitor who closes the tab can come back", () => {
    storeToken("wk_scope", "TOKEN_VALUE");
    storeVisitorKey("wk_scope", "VISITOR_KEY");

    expect(window.localStorage.getItem("serviqo_widget_token::wk_scope")).toBe("TOKEN_VALUE");
    expect(window.localStorage.getItem("serviqo_widget_visitor::wk_scope")).toBe("VISITOR_KEY");
    expect(window.sessionStorage.getItem("serviqo_widget_token::wk_scope")).toBeNull();
  });

  it("namespaces storage by widget key, so two organisations never collide", () => {
    storeToken("wk_tenant_a", "TOKEN_A");
    storeToken("wk_tenant_b", "TOKEN_B");
    storeVisitorKey("wk_tenant_a", "KEY_A");

    expect(loadStoredToken("wk_tenant_a")).toBe("TOKEN_A");
    expect(loadStoredToken("wk_tenant_b")).toBe("TOKEN_B");
    expect(loadVisitorKey("wk_tenant_b")).toBeNull();
  });

  it("clears a refused token but keeps the visitor key that recovers from it", () => {
    storeToken("wk_abc", "TOKEN_VALUE");
    storeVisitorKey("wk_abc", "VISITOR_KEY");

    clearStoredToken("wk_abc");

    expect(loadStoredToken("wk_abc")).toBeNull();
    expect(loadVisitorKey("wk_abc")).toBe("VISITOR_KEY");
  });

  it("returns null rather than throwing when storage reads throw", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(loadStoredToken("wk_abc")).toBeNull();
    expect(loadVisitorKey("wk_abc")).toBeNull();

    spy.mockRestore();
  });

  it("does not throw when storage writes throw", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(() => storeToken("wk_abc", "TOKEN_VALUE")).not.toThrow();
    expect(() => storeVisitorKey("wk_abc", "VISITOR_KEY")).not.toThrow();

    spy.mockRestore();
  });
});
