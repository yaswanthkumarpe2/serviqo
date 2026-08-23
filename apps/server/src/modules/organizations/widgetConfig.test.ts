import { describe, expect, it } from "vitest";

import { WIDGET_KEY_PREFIX } from "../../config/constants";
import { generateWidgetKey, isValidOrigin, isWellFormedWidgetKey, normalizeOrigin } from "./widgetConfig";

describe("generateWidgetKey", () => {
  it("produces a key its own validator accepts", () => {
    expect(isWellFormedWidgetKey(generateWidgetKey())).toBe(true);
  });

  it("carries the prefix that makes it self-describing", () => {
    expect(generateWidgetKey().startsWith(WIDGET_KEY_PREFIX)).toBe(true);
  });

  it("is base64url, so it needs no escaping in a URL, header, or attribute", () => {
    const key = generateWidgetKey();
    expect(key.slice(WIDGET_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).not.toContain("+");
    expect(key).not.toContain("/");
    expect(key).not.toContain("=");
  });

  /*
    256 bits. Not for secrecy — the key is published in every tenant's page
    source — but so it cannot be guessed into, and so collision retry is a
    branch that never executes (ADR-019 §9).
  */
  it("does not repeat across many generations", () => {
    const keys = new Set(Array.from({ length: 2000 }, generateWidgetKey));
    expect(keys.size).toBe(2000);
  });

  it("encodes at least 256 bits", () => {
    // 43 base64url characters carry 32 bytes with no padding.
    expect(generateWidgetKey().slice(WIDGET_KEY_PREFIX.length)).toHaveLength(43);
  });
});

describe("isWellFormedWidgetKey", () => {
  it("rejects a key with no prefix", () => {
    const withoutPrefix = generateWidgetKey().slice(WIDGET_KEY_PREFIX.length);
    expect(isWellFormedWidgetKey(withoutPrefix)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["prefix only", "wk_"],
    ["too short", "wk_abc"],
    ["too long", `wk_${"a".repeat(44)}`],
    ["standard base64 padding", `wk_${"a".repeat(42)}=`],
    ["standard base64 plus", `wk_${"a".repeat(42)}+`],
    ["a slug", "acme-corp"],
    ["an ObjectId", "507f1f77bcf86cd799439011"],
    ["whitespace inside", `wk_${"a".repeat(21)} ${"a".repeat(21)}`],
  ])("rejects %s", (_label, value) => {
    expect(isWellFormedWidgetKey(value)).toBe(false);
  });

  /*
    A widget key is a random base64url string and is therefore CASE-SENSITIVE.
    Lowercasing one the way a slug is lowercased would silently fail to find
    three quarters of all keys.
  */
  it("treats case as significant", () => {
    const key = `wk_A${"a".repeat(42)}`;
    expect(isWellFormedWidgetKey(key)).toBe(true);
    expect(key.toLowerCase()).not.toBe(key);
  });
});

describe("normalizeOrigin", () => {
  it.each([
    ["an https origin", "https://shop.example.com", "https://shop.example.com"],
    ["an http origin", "http://localhost:5173", "http://localhost:5173"],
    ["a non-default port", "https://shop.example.com:8443", "https://shop.example.com:8443"],
    ["surrounding whitespace", "  https://shop.example.com  ", "https://shop.example.com"],
  ])("accepts %s", (_label, input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  /*
    One origin must not be storable in two spellings, or the request-time
    comparison becomes a coin flip on how a tenant typed it.
  */
  it("lowercases the scheme and host", () => {
    expect(normalizeOrigin("HTTPS://Shop.Example.COM")).toBe("https://shop.example.com");
  });

  it("drops a default port so it cannot be stored twice", () => {
    expect(normalizeOrigin("https://shop.example.com:443")).toBe("https://shop.example.com");
    expect(normalizeOrigin("http://shop.example.com:80")).toBe("http://shop.example.com");
  });

  it("tolerates the bare trailing slash new URL() produces", () => {
    expect(normalizeOrigin("https://shop.example.com/")).toBe("https://shop.example.com");
  });

  /*
    A URL stored where an origin belongs produces a rule that can never match
    — the browser sends an origin — which is a silently dead security control.
  */
  it.each([
    ["a path", "https://shop.example.com/embed"],
    ["a query string", "https://shop.example.com?tenant=acme"],
    ["a fragment", "https://shop.example.com#chat"],
    ["userinfo", "https://user:pass@shop.example.com"],
  ])("rejects %s, because that is a URL and not an origin", (_label, value) => {
    expect(normalizeOrigin(value)).toBeNull();
  });

  /*
    Wildcards are prohibited in every spelling (ADR-019 §10). A wildcard
    subdomain is exactly as strong as the weakest subdomain a tenant has ever
    pointed at a third-party service.
  */
  it.each([
    ["a bare star", "*"],
    ["a scheme-wide star", "https://*"],
    ["a subdomain wildcard", "https://*.example.com"],
    ["a suffix wildcard", "https://shop.*"],
    ["a question mark", "https://shop?.example.com"],
  ])("rejects %s", (_label, value) => {
    expect(normalizeOrigin(value)).toBeNull();
  });

  it.each([
    ["a non-http scheme", "ftp://files.example.com"],
    ["a file url", "file:///etc/passwd"],
    ["a javascript url", "javascript:alert(1)"],
    ["a data url", "data:text/html,<h1>x</h1>"],
    ["the literal null a sandboxed frame sends", "null"],
    ["a bare hostname", "shop.example.com"],
    ["nonsense", "not an origin"],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, value) => {
    expect(normalizeOrigin(value)).toBeNull();
  });

  it("agrees with isValidOrigin", () => {
    expect(isValidOrigin("https://shop.example.com")).toBe(true);
    expect(isValidOrigin("https://*.example.com")).toBe(false);
    expect(isValidOrigin("https://shop.example.com/embed")).toBe(false);
  });
});
