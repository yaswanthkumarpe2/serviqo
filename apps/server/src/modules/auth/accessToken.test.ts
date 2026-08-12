import { jwtVerify, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_MS,
} from "../../config/constants";
import { env } from "../../lib/env";
import { issueAccessToken } from "./accessToken";

const USER_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f191e810c19729de860ea";

const key = () => new TextEncoder().encode(env.JWT_ACCESS_SECRET);

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
