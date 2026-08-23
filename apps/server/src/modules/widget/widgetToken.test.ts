import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  ACCESS_TOKEN_AUDIENCE,
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_TTL_MS,
} from "../../config/constants";
import { env } from "../../lib/env";
import { issueAccessToken, verifyAccessToken } from "../auth/accessToken";
import { issueWidgetToken, verifyWidgetToken } from "./widgetToken";

const CUSTOMER_ID = "507f1f77bcf86cd799439011";
const ORGANIZATION_ID = "507f191e810c19729de860ea";
const OTHER_ORGANIZATION_ID = "5ff1f77bcf86cd7994390110".slice(0, 24);

const widgetKey = () => new TextEncoder().encode(env.JWT_WIDGET_SECRET);
const accessKey = () => new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/** Mints a token claim-by-claim, so one property at a time can be made wrong. */
async function mint({
  key = widgetKey(),
  alg = "HS256",
  sub = CUSTOMER_ID,
  org = ORGANIZATION_ID as unknown,
  issuer = WIDGET_TOKEN_ISSUER,
  audience = WIDGET_TOKEN_AUDIENCE,
  expiresAt = Math.floor((Date.now() + WIDGET_TOKEN_TTL_MS) / 1000),
}: {
  key?: Uint8Array;
  alg?: string;
  sub?: string;
  org?: unknown;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
} = {}): Promise<string> {
  return new SignJWT({ org })
    .setProtectedHeader({ alg, typ: "JWT" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(expiresAt)
    .sign(key);
}

describe("issueWidgetToken", () => {
  it("issues a token its own verifier accepts", async () => {
    const { token } = await issueWidgetToken({ customerId: CUSTOMER_ID, organizationId: ORGANIZATION_ID });

    await expect(verifyWidgetToken(token)).resolves.toEqual({
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
    });
  });

  it("reports its own lifetime so a client need not parse it", async () => {
    const { expiresInSeconds } = await issueWidgetToken({
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(expiresInSeconds).toBe(Math.floor(WIDGET_TOKEN_TTL_MS / 1000));
  });

  /*
    This token lives in a page Serviqo does not control, on a device Serviqo
    does not own, readable by any script on that page (ADR-010 §8). Personal
    data placed in it is personal data published to the tenant's website.
  */
  it("carries no personal data and no authorization in its payload", async () => {
    const { token } = await issueWidgetToken({ customerId: CUSTOMER_ID, organizationId: ORGANIZATION_ID });
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "org", "sub"]);
    for (const forbidden of ["email", "name", "role", "permissions", "sid", "userId", "phone"]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it("binds the organization in a claim the server minted", async () => {
    const { token } = await issueWidgetToken({ customerId: CUSTOMER_ID, organizationId: ORGANIZATION_ID });
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

    expect(payload.sub).toBe(CUSTOMER_ID);
    expect(payload.org).toBe(ORGANIZATION_ID);
    expect(payload.aud).toBe(WIDGET_TOKEN_AUDIENCE);
  });
});

describe("verifyWidgetToken", () => {
  it("accepts a well-formed token", async () => {
    await expect(verifyWidgetToken(await mint())).resolves.toEqual({
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
    });
  });

  it("rejects a token signed with a different key", async () => {
    const foreign = new TextEncoder().encode("a-completely-different-key-of-sufficient-length");
    await expect(verifyWidgetToken(await mint({ key: foreign }))).resolves.toBeNull();
  });

  it("rejects a token whose signature has been tampered with", async () => {
    const token = await mint();
    const [header, payload, signature] = token.split(".");
    const flipped = signature!.slice(0, -1) + (signature!.endsWith("A") ? "B" : "A");

    await expect(verifyWidgetToken(`${header}.${payload}.${flipped}`)).resolves.toBeNull();
  });

  it("rejects a token whose payload has been edited", async () => {
    const token = await mint();
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: CUSTOMER_ID, org: OTHER_ORGANIZATION_ID, iss: WIDGET_TOKEN_ISSUER }),
    ).toString("base64url");

    await expect(verifyWidgetToken(`${header}.${forged}.${signature}`)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await mint({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifyWidgetToken(expired)).resolves.toBeNull();
  });

  it("rejects a token that expires while it is held", async () => {
    vi.useFakeTimers();
    try {
      const { token } = await issueWidgetToken({ customerId: CUSTOMER_ID, organizationId: ORGANIZATION_ID });
      await expect(verifyWidgetToken(token)).resolves.not.toBeNull();

      vi.setSystemTime(Date.now() + WIDGET_TOKEN_TTL_MS + 60_000);
      await expect(verifyWidgetToken(token)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a wrong issuer", async () => {
    await expect(verifyWidgetToken(await mint({ issuer: "not-serviqo" }))).resolves.toBeNull();
  });

  it("rejects a wrong audience", async () => {
    await expect(verifyWidgetToken(await mint({ audience: "serviqo-something-else" }))).resolves.toBeNull();
  });

  /*
    The classic forgery: strip the signature, announce there isn't one, be
    believed. `jose` honours a token's own `alg` header unless the verifier
    pins one (ADR-015 §3).
  */
  it("rejects an unsigned alg:none token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: CUSTOMER_ID,
        org: ORGANIZATION_ID,
        iss: WIDGET_TOKEN_ISSUER,
        aud: WIDGET_TOKEN_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");

    await expect(verifyWidgetToken(`${header}.${payload}.`)).resolves.toBeNull();
    await expect(verifyWidgetToken(`${header}.${payload}.x`)).resolves.toBeNull();
  });

  it("rejects a token signed with a different HMAC algorithm", async () => {
    await expect(verifyWidgetToken(await mint({ alg: "HS512" }))).resolves.toBeNull();
  });

  /*
    A malformed subject reaching Mongoose raises a CastError, which
    errorHandler turns into a generic 500 — a client credential answered as a
    server fault.
  */
  it.each([
    ["not hex", "zzzzzzzzzzzzzzzzzzzzzzzz"],
    ["too short", "507f1f77bcf86cd79943901"],
    ["too long", "507f1f77bcf86cd799439011a"],
    ["a mongo operator", '{"$ne":null}'],
    ["empty", ""],
  ])("rejects a %s subject", async (_label, sub) => {
    await expect(verifyWidgetToken(await mint({ sub }))).resolves.toBeNull();
  });

  it.each([
    ["not a string", 12345],
    ["an object", { $ne: null }],
    ["malformed", "not-an-object-id"],
    ["empty", ""],
  ])("rejects a token whose org claim is %s", async (_label, org) => {
    await expect(verifyWidgetToken(await mint({ org }))).resolves.toBeNull();
  });

  /*
    Built without the helper: an `org: undefined` argument would take the
    helper's default and silently test the valid case instead. The claim has
    to be genuinely absent from the payload.
  */
  it("rejects a token with no org claim at all", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(CUSTOMER_ID)
      .setIssuer(WIDGET_TOKEN_ISSUER)
      .setAudience(WIDGET_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor((Date.now() + WIDGET_TOKEN_TTL_MS) / 1000))
      .sign(widgetKey());

    await expect(verifyWidgetToken(token)).resolves.toBeNull();
  });

  it.each([
    ["empty", ""],
    ["not a JWT", "not-a-token"],
    ["two segments", "aaa.bbb"],
    ["a bearer header", "Bearer aaa.bbb.ccc"],
  ])("rejects %s without throwing", async (_label, token) => {
    await expect(verifyWidgetToken(token)).resolves.toBeNull();
  });
});

/*
  The boundary this whole slice exists to hold (ADR-010 §5, ADR-019 §8).

  Two independent controls separate the two credential formats, and either
  alone would be sufficient: a different signing key, and a different
  audience.
*/
describe("the staff/widget credential boundary", () => {
  it("refuses a staff access token at the widget verifier", async () => {
    const { token } = await issueAccessToken({ userId: CUSTOMER_ID, sessionId: ORGANIZATION_ID });

    await expect(verifyWidgetToken(token)).resolves.toBeNull();
  });

  it("refuses a widget token at the staff verifier", async () => {
    const { token } = await issueWidgetToken({ customerId: CUSTOMER_ID, organizationId: ORGANIZATION_ID });

    await expect(verifyAccessToken(token)).resolves.toBeNull();
  });

  /*
    The stronger of the two controls, isolated. Even a token carrying the
    CORRECT widget audience fails if it was signed with the staff key — so the
    separation holds even if an audience check were one day written wrongly.
  */
  it("refuses a widget-audience token signed with the staff key", async () => {
    const wrongKey = await mint({ key: accessKey() });

    await expect(verifyWidgetToken(wrongKey)).resolves.toBeNull();
  });

  /*
    And the converse: the correct widget KEY with the staff AUDIENCE fails
    too, so the audience claim is doing real work rather than being decorative.
  */
  it("refuses a staff-audience token signed with the widget key", async () => {
    const wrongAudience = await mint({ audience: ACCESS_TOKEN_AUDIENCE });

    await expect(verifyWidgetToken(wrongAudience)).resolves.toBeNull();
  });

  it("keeps the two secrets genuinely distinct", () => {
    expect(env.JWT_WIDGET_SECRET).not.toBe(env.JWT_ACCESS_SECRET);
  });

  it("keeps the two audiences distinct", () => {
    expect(WIDGET_TOKEN_AUDIENCE).not.toBe(ACCESS_TOKEN_AUDIENCE);
  });
});
