import { SignJWT } from "jose";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_MS,
} from "../../config/constants";
import { env } from "../../lib/env";

/**
 * Access-token issuance (ADR-011 §1–2).
 *
 * Issuance only. There is deliberately no `verifyAccessToken` here: nothing
 * consumes an access token yet, and a verifier written before its first
 * caller is a security-critical function nobody exercises. It belongs to the
 * slice that first protects a route.
 */

/**
 * Symmetric HS256, because one service both signs and verifies these tokens.
 * A second service needing to verify them would force asymmetric keys and a
 * key-distribution decision; nothing here assumes that never happens.
 */
const ALGORITHM = "HS256";

/**
 * Encoded once and reused. `env` is validated at boot, so this cannot be
 * absent or too short by the time anything calls it (ADR-011 §11).
 */
let cachedSigningKey: Uint8Array | undefined;

function signingKey(): Uint8Array {
  cachedSigningKey ??= new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  return cachedSigningKey;
}

export interface AccessTokenSubject {
  /** Becomes `sub`. */
  userId: string;
  /**
   * Becomes `sid`. Present so revocation and logout have a durable
   * identifier to address later — this slice never reads it back.
   */
  sessionId: string;
}

export interface IssuedAccessToken {
  token: string;
  /** Seconds until expiry, so a client can schedule a refresh without parsing the token. */
  expiresInSeconds: number;
}

/**
 * Signs a short-lived access token for one organization user's session.
 *
 * The claim set is deliberately minimal. No `email`, `name`,
 * `organizationId`, `role`, or `permissions`:
 *
 * - A JWT is signed, not encrypted, and routinely reaches logs, proxy
 *   traces, and error trackers. Personal data does not belong in one.
 * - Organization access is resolved per request through Membership
 *   (ADR-004 §8). A role baked in here would keep working for the token's
 *   full lifetime after an admin revoked it — the staleness that decision
 *   exists to prevent.
 *
 * `aud` pins the token to the dashboard principal type (ADR-010 §5), so a
 * future customer/visitor credential can never verify as a staff one.
 */
export async function issueAccessToken({ userId, sessionId }: AccessTokenSubject): Promise<IssuedAccessToken> {
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + ACCESS_TOKEN_TTL_MS;

  // `iat`/`exp` are NumericDate — seconds, not milliseconds.
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(Math.floor(issuedAtMs / 1000))
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(signingKey());

  return { token, expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}
