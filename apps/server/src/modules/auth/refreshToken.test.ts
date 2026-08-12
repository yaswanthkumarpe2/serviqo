import { describe, expect, it } from "vitest";

import { REFRESH_COOKIE_PATH, SESSION_TTL_MS } from "../../config/constants";
import { sha256 } from "../../lib/crypto/tokens";
import {
  REFRESH_TOKEN_SEPARATOR,
  clearRefreshCookieOptions,
  formatRefreshToken,
  generateRefreshSecret,
  parseRefreshToken,
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

describe("parseRefreshToken", () => {
  it("round-trips a token produced by formatRefreshToken", () => {
    const { secret } = generateRefreshSecret();

    expect(parseRefreshToken(formatRefreshToken(SESSION_ID, secret))).toEqual({
      sessionId: SESSION_ID,
      secret,
    });
  });

  // The secret is base64url and contains no separator, but the format's rule
  // is "split at the first one" and a parser must not depend on the alphabet.
  it("splits at the first separator, leaving the rest as the secret", () => {
    expect(parseRefreshToken(`${SESSION_ID}.a.b.c`)).toEqual({ sessionId: SESSION_ID, secret: "a.b.c" });
  });

  it("rejects a token with no separator", () => {
    expect(parseRefreshToken(SESSION_ID)).toBeNull();
    expect(parseRefreshToken("")).toBeNull();
  });

  it("rejects an empty session id or an empty secret", () => {
    expect(parseRefreshToken(".secret")).toBeNull();
    expect(parseRefreshToken(`${SESSION_ID}.`)).toBeNull();
  });

  // ADR-012 §9: findById raises a CastError on a malformed id, which would
  // answer a hand-typed cookie with a 500.
  it("rejects a session id that is not a 24-character hex ObjectId", () => {
    expect(parseRefreshToken("not-an-object-id.secret")).toBeNull();
    expect(parseRefreshToken("507f191e810c19729de860.secret")).toBeNull(); // too short
    expect(parseRefreshToken("507f191e810c19729de860eaff.secret")).toBeNull(); // too long
    expect(parseRefreshToken("507f191e810c19729de860zz.secret")).toBeNull(); // non-hex
  });

  // Mongoose's own isValid() accepts any 12-character string; this must not.
  it("rejects a 12-character session id Mongoose would otherwise cast", () => {
    expect(parseRefreshToken("abcdefghijkl.secret")).toBeNull();
  });

  it("accepts an uppercase hex session id", () => {
    expect(parseRefreshToken(`${SESSION_ID.toUpperCase()}.secret`)).toEqual({
      sessionId: SESSION_ID.toUpperCase(),
      secret: "secret",
    });
  });
});

describe("clearRefreshCookieOptions", () => {
  const clearing = clearRefreshCookieOptions();

  // A browser only replaces a cookie when name, Path, and domain match.
  it("keeps the attributes that identify the cookie being removed", () => {
    expect(clearing.path).toBe(REFRESH_COOKIE_PATH);
    expect(clearing.httpOnly).toBe(true);
    expect(clearing.sameSite).toBe("strict");
    expect(clearing.secure).toBe(refreshCookieOptions().secure);
  });

  // res.cookie recomputes `expires` from maxAge whenever it is present, which
  // would re-issue the cookie for another seven days at the moment the server
  // meant to destroy it.
  it("drops maxAge so clearCookie's past expiry survives", () => {
    expect(clearing.maxAge).toBeUndefined();
    expect("maxAge" in clearing).toBe(false);
  });

  it("does not mutate the options used to set the cookie", () => {
    clearRefreshCookieOptions();
    expect(refreshCookieOptions().maxAge).toBe(SESSION_TTL_MS);
  });
});
