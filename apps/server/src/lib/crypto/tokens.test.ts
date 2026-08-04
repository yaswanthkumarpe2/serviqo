import { describe, expect, it } from "vitest";

import { REFRESH_SECRET_BYTES } from "../../config/constants";
import { generateSecret, sha256, timingSafeEqualHex } from "./tokens";

describe("generateSecret", () => {
  it("produces a secret with the configured entropy", () => {
    const secret = generateSecret();
    expect(Buffer.from(secret, "base64url")).toHaveLength(REFRESH_SECRET_BYTES);
  });

  it("produces the expected base64url length for 32 bytes", () => {
    // 32 bytes -> 43 base64url characters (padding stripped).
    expect(generateSecret()).toHaveLength(43);
  });

  it("is not deterministic", () => {
    const secrets = new Set(Array.from({ length: 100 }, () => generateSecret()));
    expect(secrets.size).toBe(100);
  });

  it("emits url- and cookie-safe characters only", () => {
    for (let i = 0; i < 50; i += 1) {
      const secret = generateSecret();
      expect(secret).not.toContain("+");
      expect(secret).not.toContain("/");
      expect(secret).not.toContain("=");
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("sha256", () => {
  it("is deterministic", () => {
    expect(sha256("serviqo-token-value")).toBe(sha256("serviqo-token-value"));
  });

  it("produces different digests for different inputs", () => {
    expect(sha256("token-a")).not.toBe(sha256("token-b"));
  });

  it("produces a 64-character lowercase hex digest", () => {
    expect(sha256("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known digest for a fixed input", () => {
    // Guards against an accidental algorithm or encoding change.
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("does not contain the input value", () => {
    const value = "plaintext-secret-value";
    expect(sha256(value)).not.toContain(value);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for identical digests", () => {
    const digest = sha256("same-input");
    expect(timingSafeEqualHex(digest, digest)).toBe(true);
  });

  it("returns true for equal digests derived independently", () => {
    expect(timingSafeEqualHex(sha256("shared"), sha256("shared"))).toBe(true);
  });

  it("returns false for different digests", () => {
    expect(timingSafeEqualHex(sha256("one"), sha256("two"))).toBe(false);
  });

  it("returns false for digests differing in a single character", () => {
    const digest = sha256("baseline");
    const tampered = `${digest.slice(0, -1)}${digest.endsWith("a") ? "b" : "a"}`;
    expect(timingSafeEqualHex(digest, tampered)).toBe(false);
  });

  it("returns false for different-length input instead of throwing", () => {
    // crypto.timingSafeEqual throws on length mismatch; the guard must absorb it.
    expect(() => timingSafeEqualHex(sha256("value"), "short")).not.toThrow();
    expect(timingSafeEqualHex(sha256("value"), "short")).toBe(false);
  });

  it("handles empty and malformed input safely", () => {
    expect(timingSafeEqualHex("", "")).toBe(true);
    expect(timingSafeEqualHex(sha256("value"), "")).toBe(false);
    expect(timingSafeEqualHex("", sha256("value"))).toBe(false);
    expect(timingSafeEqualHex("not-hex", "not-hex")).toBe(true);
  });
});
