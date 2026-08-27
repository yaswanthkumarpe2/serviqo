import { SignJWT, jwtVerify, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_MS,
} from "../../config/constants";
import { env } from "../../lib/env";
import { issueAccessToken, verifyAccessToken } from "./accessToken";

const USER_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f191e810c19729de860ea";

const key = () => new TextEncoder().encode(env.JWT_ACCESS_SECRET);

interface TokenOverrides {
  sub?: string;
  sid?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  signingKey?: Uint8Array;
  /** Drops `sid` entirely. A separate flag because `sid: undefined` would only trigger the default. */
  omitSid?: boolean;
}

/**
 * Mints a token with the claims spelled out, so a test can vary exactly one
 * of them. Defaults reproduce what `issueAccessToken` produces.
 */
async function signToken(overrides: TokenOverrides = {}): Promise<string> {
  const {
    sub = USER_ID,
    sid = SESSION_ID,
    issuer = ACCESS_TOKEN_ISSUER,
    audience = ACCESS_TOKEN_AUDIENCE,
    expiresIn = "15m",
    signingKey = key(),
    omitSid = false,
  } = overrides;

  return new SignJWT(omitSid ? {} : { sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signingKey);
}

describe("issueAccessToken", () => {
  it("produces a token that verifies against the configured secret", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });

    const { payload } = await jwtVerify(token, key(), {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });

    expect(payload.sub).toBe(USER_ID);
    expect(payload.sid).toBe(SESSION_ID);
  });

  it("signs with HS256", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    expect(decodeProtectedHeader(token).alg).toBe("HS256");
  });

  // ADR-010 §5: a customer/visitor credential must never verify as a staff
  // one. The audience claim is the control that makes that impossible.
  it("pins the token to the dashboard audience", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });

    await expect(jwtVerify(token, key(), { audience: "serviqo-widget" })).rejects.toThrow();
  });

  it("rejects verification under a different secret", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    const wrongKey = new TextEncoder().encode("a-completely-different-secret-of-length");

    await expect(jwtVerify(token, wrongKey)).rejects.toThrow();
  });

  it("expires after the configured lifetime", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    const { payload } = await jwtVerify(token, key());

    const lifetimeSeconds = payload.exp! - payload.iat!;
    expect(lifetimeSeconds).toBe(Math.floor(ACCESS_TOKEN_TTL_MS / 1000));
  });

  it("reports the lifetime in seconds so a client need not parse the token", async () => {
    const { expiresInSeconds } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    expect(expiresInSeconds).toBe(Math.floor(ACCESS_TOKEN_TTL_MS / 1000));
  });

  // A JWT is signed, not encrypted, and reaches logs and proxy traces. It
  // carries an identity, never personal data or authorization state.
  it("carries no personal data and no authorization state", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    const { payload } = await jwtVerify(token, key());

    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "sid", "sub"]);
  });

  // ADR-004 §8: a role baked into a token keeps working after it is revoked.
  it("omits organization and role claims entirely", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    const { payload } = await jwtVerify(token, key());

    expect(payload.organizationId).toBeUndefined();
    expect(payload.role).toBeUndefined();
    expect(payload.permissions).toBeUndefined();
    expect(payload.email).toBeUndefined();
    expect(payload.name).toBeUndefined();
  });
});

describe("verifyAccessToken", () => {
  it("accepts a token this module issued and reports its subject", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });

    await expect(verifyAccessToken(token)).resolves.toEqual({ userId: USER_ID, sessionId: SESSION_ID });
  });

  // The pairing that matters: whatever the issuer produces, the verifier
  // accepts. A verifier that lives apart from its issuer is one that can
  // disagree with it silently (ADR-015 §1).
  it("round-trips with the issuer across a fresh token", async () => {
    const first = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    const second = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });

    await expect(verifyAccessToken(first.token)).resolves.not.toBeNull();
    await expect(verifyAccessToken(second.token)).resolves.not.toBeNull();
  });

  describe("refusals", () => {
    it("refuses a token signed with a different secret", async () => {
      const token = await signToken({
        signingKey: new TextEncoder().encode("a-completely-different-secret-of-length"),
      });

      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });

    it("refuses a token whose payload was altered after signing", async () => {
      const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
      const [header, , signature] = token.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({
          sub: "507f1f77bcf86cd799439099",
          sid: SESSION_ID,
          iss: ACCESS_TOKEN_ISSUER,
          aud: ACCESS_TOKEN_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString("base64url");

      await expect(verifyAccessToken(`${header}.${forgedPayload}.${signature}`)).resolves.toBeNull();
    });

    it("refuses an expired token", async () => {
      // Negative lifetime: issued and expired before this line returns.
      const token = await signToken({ expiresIn: "-1s" });

      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });

    it("refuses a token from another issuer", async () => {
      const token = await signToken({ issuer: "not-serviqo" });

      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });

    /*
      ADR-010 §5's control, and the only test here that can fail before a
      customer credential exists. Signed with the CORRECT key — the exact
      shape a future widget token would take — so the audience claim is the
      single thing standing between it and a staff route.
    */
    it("refuses a correctly-signed token minted for another audience", async () => {
      const token = await signToken({ audience: "serviqo-widget" });

      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });

    /*
      The classic JWT forgery: strip the signature, announce there isn't one,
      be believed. Pinning `algorithms` is what makes this impossible
      (ADR-015 §3).
    */
    it("refuses an unsigned token claiming alg: none", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: USER_ID,
          sid: SESSION_ID,
          iss: ACCESS_TOKEN_ISSUER,
          aud: ACCESS_TOKEN_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString("base64url");

      await expect(verifyAccessToken(`${header}.${payload}.`)).resolves.toBeNull();
    });

    it("refuses a subject that is not an ObjectId, rather than passing it to Mongoose", async () => {
      const token = await signToken({ sub: "not-an-object-id" });

      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });

    it("refuses a token with no session claim", async () => {
      const token = await signToken({ omitSid: true });

      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });

    it.each([
      ["empty", ""],
      ["not a JWT at all", "gibberish"],
      ["two segments", "aaa.bbb"],
      ["four segments", "aaa.bbb.ccc.ddd"],
    ])("refuses a malformed token (%s) without throwing", async (_label, token) => {
      await expect(verifyAccessToken(token)).resolves.toBeNull();
    });
  });

  /*
    Every refusal is the same `null`. jose raises a different error class per
    failure mode, each naming the claim that failed; the collapse here is what
    keeps "expired" from sitting one instanceof away from a response body
    (ADR-015 §2, §6).
  */
  it("answers every refusal identically, so no branch is distinguishable", async () => {
    const refusals = await Promise.all([
      verifyAccessToken(await signToken({ expiresIn: "-1s" })),
      verifyAccessToken(await signToken({ issuer: "not-serviqo" })),
      verifyAccessToken(await signToken({ audience: "serviqo-widget" })),
      verifyAccessToken(await signToken({ signingKey: new TextEncoder().encode("another-secret-long-enough-here") })),
      verifyAccessToken("gibberish"),
    ]);

    expect(refusals).toEqual([null, null, null, null, null]);
  });

  it("never throws, whatever it is handed", async () => {
    for (const token of ["", ".", "..", "a.b.c", " ", "Bearer something"]) {
      await expect(verifyAccessToken(token)).resolves.toBeNull();
    }
  });
});
