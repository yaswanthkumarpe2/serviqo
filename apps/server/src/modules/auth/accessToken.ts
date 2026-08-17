import { SignJWT, jwtVerify } from "jose";

import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_TTL_MS,
} from "../../config/constants";
import { env } from "../../lib/env";

/**
 * Access-token issuance and verification (ADR-011 §1–2, ADR-015 §1).
 *
 * Verification lives here rather than in the middleware that calls it,
 * beside the claim set, the algorithm, and the key it has to agree with.
 * Splitting a token's format from its parser across two modules is the drift
 * `refreshToken.ts` avoided when `parseRefreshToken` landed next to
 * `formatRefreshToken` — a verifier that lives elsewhere is one that can
 * disagree with the issuer, silently.
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

/**
 * A 24-character hex ObjectId, which is exactly what `_id.toString()`
 * produces.
 *
 * Applied to `sub` for the same reason `refreshToken.ts` applies it to a
 * session id: `findById` raises a `CastError` on a malformed value, and a
 * `CastError` reaching errorHandler becomes a generic 500 — a client
 * credential answered as a server fault (ADR-015 §5).
 *
 * A token that reaches this check was signed with Serviqo's own key, so its
 * subject is always well-formed in practice. The guard exists because "in
 * practice" is doing work a regex does more cheaply.
 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * The identity a verified access token asserts. Not an authorization: it says
 * who is calling, never what they may do (ADR-015 §13).
 */
export interface AccessTokenPrincipal {
  /** From `sub`. The `User` this token authenticates. */
  userId: string;
  /**
   * From `sid`. Carried for revocation and audit correlation; deliberately
   * NOT looked up per request — see ADR-015 §8 for why the session is not
   * re-checked and the fifteen-minute window that follows.
   */
  sessionId: string;
}

/**
 * Verifies a bearer access token and returns the identity it asserts, or
 * `null` if it asserts nothing trustworthy.
 *
 * Checks, in one call so none can be skipped by a later edit: the HS256
 * signature under the configured secret, `iss`, `aud`, and `exp`/`nbf`.
 *
 * `algorithms` is pinned and that is load-bearing (ADR-015 §3). Left
 * unpinned, `jose` honours whatever the token's own header claims —
 * including `alg: "none"`, which is the classic forgery: strip the
 * signature, announce there isn't one, be believed. The key is symmetric, so
 * the header must never get to choose.
 *
 * Returns `null` for every failure rather than throwing. `jose` raises a
 * different error class per failure mode, each naming the claim that failed;
 * letting those propagate would put "expired" and "wrong audience" one
 * `instanceof` away from a response body. Collapsing here means the
 * distinction never exists, rather than existing and being carefully unused
 * (ADR-015 §2, §6).
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPrincipal | null> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];

  try {
    ({ payload } = await jwtVerify(token, signingKey(), {
      algorithms: [ALGORITHM],
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    }));
  } catch {
    // The token is not logged here, valid or not: it is a credential. The
    // caller records why a request was refused, never what it presented.
    return null;
  }

  // Both claims are minted by `issueAccessToken` above, so a token this
  // signature validates always carries them. Checked anyway — the shape of
  // the payload is not what the signature attests to, and a `sub` that
  // reached Mongoose malformed would be a 500.
  const { sub, sid } = payload;
  if (typeof sub !== "string" || !OBJECT_ID_PATTERN.test(sub)) return null;
  if (typeof sid !== "string" || !OBJECT_ID_PATTERN.test(sid)) return null;

  return { userId: sub, sessionId: sid };
}
