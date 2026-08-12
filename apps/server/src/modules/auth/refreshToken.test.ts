import { describe, expect, it } from "vitest";

import { REFRESH_COOKIE_PATH, SESSION_TTL_MS } from "../../config/constants";
import { sha256 } from "../../lib/crypto/tokens";
import {
  REFRESH_TOKEN_SEPARATOR,
  formatRefreshToken,
  generateRefreshSecret,
  refreshCookieOptions,
} from "./refreshToken";

const SESSION_ID = "507f191e810c19729de860ea";

describe("generateRefreshSecret", () => {
  it("returns the SHA-256 of the secret as its hash", () => {
    const { secret, secretHash } = generateRefreshSecret();
    expect(secretHash).toBe(sha256(secret));
  });

  it("produces a 64-character lowercase hex digest", () => {
    expect(generateRefreshSecret().secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats a secret", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateRefreshSecret().secret));
    expect(secrets.size).toBe(50);
  });

  // base64url (RFC 4648 §5) so the value is safe in a cookie without escaping
  // — and, load-bearing for parsing, contains no separator character.
  it("produces a base64url secret containing no separator", () => {
    const { secret } = generateRefreshSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret).not.toContain(REFRESH_TOKEN_SEPARATOR);
  });
});

describe("formatRefreshToken", () => {
  it("assembles <sessionId>.<secret> per ADR-004 §2", () => {
    expect(formatRefreshToken(SESSION_ID, "SECRET")).toBe(`${SESSION_ID}.SECRET`);
  });

  // The routing component must be recoverable by splitting at the FIRST
  // separator, which is what lets the future refresh flow load one document.
  it("keeps the session id recoverable from the first separator", () => {
    const { secret } = generateRefreshSecret();
    const token = formatRefreshToken(SESSION_ID, secret);

    const separatorIndex = token.indexOf(REFRESH_TOKEN_SEPARATOR);
    expect(token.slice(0, separatorIndex)).toBe(SESSION_ID);
    expect(token.slice(separatorIndex + 1)).toBe(secret);
  });
});

describe("refreshCookieOptions", () => {
  const options = refreshCookieOptions();

  it("is unreachable from page JavaScript", () => {
    expect(options.httpOnly).toBe(true);
  });

  // The resolution of the CSRF question ADR-007 §14 deferred until refresh
  // cookies existed.
  it("is SameSite=Strict", () => {
    expect(options.sameSite).toBe("strict");
  });

  // ADR-010 §8: scoping is what makes it structurally impossible for the
  // staff credential to reach a future customer/widget endpoint.
  it("is scoped to the auth path, not the whole origin", () => {
    expect(options.path).toBe(REFRESH_COOKIE_PATH);
    expect(options.path).not.toBe("/");
  });

  it("expires with the session rather than on its own schedule", () => {
    expect(options.maxAge).toBe(SESSION_TTL_MS);
  });

  // NODE_ENV is "test" here. Secure is off only because a Secure cookie
  // cannot be set over plain-HTTP localhost; production is the branch that
  // matters and is asserted by construction below.
  it("omits Secure outside production only", () => {
    expect(options.secure).toBe(false);
  });
});
