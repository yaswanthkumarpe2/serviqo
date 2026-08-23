import { describe, expect, it } from "vitest";

import { decideOrigin } from "./originPolicy";

const ALLOWED = ["https://shop.example.com", "https://help.example.com"];

describe("decideOrigin", () => {
  describe("with a configured list", () => {
    it("allows an origin on the list", () => {
      expect(decideOrigin("https://shop.example.com", ALLOWED)).toEqual({ allowed: true });
    });

    it("allows the second entry, not only the first", () => {
      expect(decideOrigin("https://help.example.com", ALLOWED)).toEqual({ allowed: true });
    });

    it("refuses an origin that is not on the list", () => {
      expect(decideOrigin("https://evil.example.net", ALLOWED)).toEqual({
        allowed: false,
        reason: "origin_not_allowed",
      });
    });

    /*
      Both sides go through the same canonicalization, so a tenant who typed
      their origin in a different case still matches the browser's.
    */
    it("compares canonical forms on both sides", () => {
      expect(decideOrigin("HTTPS://Shop.Example.com", ALLOWED)).toEqual({ allowed: true });
      expect(decideOrigin("https://shop.example.com:443", ALLOWED)).toEqual({ allowed: true });
      expect(decideOrigin("https://shop.example.com", ["HTTPS://SHOP.EXAMPLE.COM:443"])).toEqual({ allowed: true });
    });

    /*
      The classic hand-written-origin-check failure. `endsWith(".example.com")`
      also matches `evil-example.com`, and a prefix check matches
      `example.com.attacker.test`.
    */
    it.each([
      ["a lookalike suffix", "https://evilshop.example.com"],
      ["a hyphen lookalike", "https://shop-example.com"],
      ["a domain suffixed onto another", "https://shop.example.com.attacker.test"],
      ["a subdomain of an allowed host", "https://a.shop.example.com"],
      ["a different scheme", "http://shop.example.com"],
      ["a different port", "https://shop.example.com:8443"],
    ])("refuses %s", (_label, origin) => {
      expect(decideOrigin(origin, ALLOWED)).toEqual({ allowed: false, reason: "origin_not_allowed" });
    });

    it.each([
      ["the literal null a sandboxed iframe sends", "null"],
      ["a file origin", "file://"],
      ["nonsense", "not an origin"],
      ["a URL rather than an origin", "https://shop.example.com/embed"],
    ])("refuses %s as malformed", (_label, origin) => {
      expect(decideOrigin(origin, ALLOWED)).toEqual({ allowed: false, reason: "origin_malformed" });
    });
  });

  /*
    An empty list means CLOSED — no website may embed this widget — never
    "every website may". The default a new organization starts with is
    therefore safe (ADR-019 §10).
  */
  describe("with an empty list", () => {
    it("refuses every browser origin", () => {
      expect(decideOrigin("https://shop.example.com", [])).toEqual({
        allowed: false,
        reason: "origin_not_allowed",
      });
    });

    it("does not treat empty as a wildcard", () => {
      for (const origin of ["https://a.test", "http://localhost:3000", "https://anything.example"]) {
        expect(decideOrigin(origin, [])).toEqual({ allowed: false, reason: "origin_not_allowed" });
      }
    });
  });

  /*
    The row that reads like a bypass and is not (ADR-019 §10).

    An absent Origin means the caller is not a browser making a cross-origin
    request. Refusing it would buy nothing — a non-browser caller can set the
    header to any value it likes, so the header only constrains the one caller
    that CANNOT lie about it, and browsers always send it on cross-origin
    POST.
  */
  describe("with no Origin header", () => {
    it("allows the request when a list is configured", () => {
      expect(decideOrigin(undefined, ALLOWED)).toEqual({ allowed: true });
    });

    it("allows the request when the list is empty", () => {
      expect(decideOrigin(undefined, [])).toEqual({ allowed: true });
    });
  });

  /*
    Configuration rejects wildcards, so no stored entry can be a pattern. This
    proves that even if one were written directly into the database, it would
    match nothing rather than match everything.
  */
  it("treats a stored wildcard as matching nothing rather than everything", () => {
    expect(decideOrigin("https://shop.example.com", ["*"])).toEqual({
      allowed: false,
      reason: "origin_not_allowed",
    });
    expect(decideOrigin("https://shop.example.com", ["https://*.example.com"])).toEqual({
      allowed: false,
      reason: "origin_not_allowed",
    });
  });
});
