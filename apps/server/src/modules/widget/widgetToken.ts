import { SignJWT, jwtVerify } from "jose";

import { WIDGET_TOKEN_AUDIENCE, WIDGET_TOKEN_ISSUER, WIDGET_TOKEN_TTL_MS } from "../../config/constants";
import { env } from "../../lib/env";

/**
 * Widget visitor-token issuance and verification (ADR-019 §8).
 *
 * Serviqo's SECOND credential format, and deliberately not a variant of the
 * first. It is the parallel of `modules/auth/accessToken.ts` and shares
 * nothing with it — not the key, not the audience, not the subject's
 * collection, and not the verifier. ADR-010 §8 fixed why: a staff credential
 * grants the dashboard across every organization its owner belongs to, while
 * this one lives inside a third-party website, in a page Serviqo does not
 * control, and is handed to anyone who opens it.
 *
 * Issuer and verifier live in one file for the reason `accessToken.ts` gives:
 * a verifier that lives elsewhere is one that can disagree with the issuer,
 * silently.
 */

/**
 * Symmetric HS256, matching the access token — one service both signs and
 * verifies these.
 *
 * That the two formats share an ALGORITHM is not a weakness, because they do
 * not share a KEY. A staff token presented to `verifyWidgetToken` fails at
 * the signature, before any claim is examined.
 */
const ALGORITHM = "HS256";

/**
 * Encoded once and reused. `env` validates at boot, so this cannot be absent,
 * too short, or equal to `JWT_ACCESS_SECRET` by the time anything calls it.
 */
let cachedSigningKey: Uint8Array | undefined;

function signingKey(): Uint8Array {
  cachedSigningKey ??= new TextEncoder().encode(env.JWT_WIDGET_SECRET);
  return cachedSigningKey;
}

/** The `org` claim: which tenant this visitor exists inside. */
const ORGANIZATION_CLAIM = "org";

export interface WidgetTokenSubject {
  /** Becomes `sub`. The `Customer` this token identifies. */
  customerId: string;
  /**
   * Becomes `org`. The tenant that customer belongs to.
   *
   * Present because a `Customer` is meaningless without its organization, and
   * because it is what lets a resumed session be checked against the tenant
   * the widget key independently resolved. It is a BINDING, never a selector:
   * nothing looks a tenant up by this claim (ADR-019 §8).
   */
  organizationId: string;
}

export interface IssuedWidgetToken {
  token: string;
  /** Seconds until expiry, so a client can plan without parsing the token. */
  expiresInSeconds: number;
}

/**
 * Signs a visitor token for one customer in one organization.
 *
 * The claim set is minimal and carries NO personal data: no email, no name,
 * no phone, nothing the visitor typed. Two reasons, and the second is
 * specific to this credential:
 *
 * - A JWT is signed, not encrypted, and routinely reaches logs, proxy traces,
 *   and error trackers — the reason `accessToken.ts` gives for its own claim
 *   set.
 * - This token lives in a page Serviqo does not control, on a device Serviqo
 *   does not own, readable by any script on that page (ADR-010 §8). Personal
 *   data placed here is personal data published to the tenant's website.
 *
 * It carries no role and no permission either, for a stronger reason than the
 * access token's: a customer holds no position inside the organization at all
 * (ADR-010 §2), so there is no role that could correctly appear.
 */
export async function issueWidgetToken({
  customerId,
  organizationId,
}: WidgetTokenSubject): Promise<IssuedWidgetToken> {
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + WIDGET_TOKEN_TTL_MS;

  // `iat`/`exp` are NumericDate — seconds, not milliseconds.
  const token = await new SignJWT({ [ORGANIZATION_CLAIM]: organizationId })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(customerId)
    .setIssuer(WIDGET_TOKEN_ISSUER)
    .setAudience(WIDGET_TOKEN_AUDIENCE)
    .setIssuedAt(Math.floor(issuedAtMs / 1000))
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(signingKey());

  return { token, expiresInSeconds: Math.floor(WIDGET_TOKEN_TTL_MS / 1000) };
}

/**
 * A 24-character hex ObjectId — the same guard `accessToken.ts`,
 * `refreshToken.ts`, and `requireOrganization.ts` apply, for the same reason:
 * `findOne` raises a `CastError` on a malformed value, and a `CastError`
 * reaching `errorHandler` becomes a generic 500 — a client credential
 * answered as a server fault.
 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * The identity a verified widget token asserts.
 *
 * Not an authorization, and less of one than `AccessTokenPrincipal`: it says
 * which customer is calling and inside which tenant, and grants nothing
 * further. Whether that customer may reach a particular conversation is a
 * resource-level question ADR-010 §2 kept off the RBAC axis entirely.
 */
export interface WidgetPrincipal {
  /** From `sub`. */
  customerId: string;
  /** From `org`. */
  organizationId: string;
}

/**
 * Verifies a widget token and returns the identity it asserts, or `null` if
 * it asserts nothing trustworthy.
 *
 * Checks, in one call so a later edit cannot skip one: the HS256 signature
 * under the WIDGET key, `iss`, `aud`, `exp`/`nbf`, that `sub` is a
 * well-formed ObjectId, and that `org` is one too.
 *
 * `algorithms` is pinned and that is load-bearing (ADR-015 §3). Left
 * unpinned, `jose` honours whatever the token's own header claims —
 * including `alg: "none"`, which is the classic forgery: strip the signature,
 * announce there isn't one, be believed.
 *
 * A STAFF access token fails here twice over — wrong key first, wrong
 * audience second — and either alone would be sufficient (ADR-019 §8). The
 * converse holds in `verifyAccessToken`, which is signed with a different key
 * and demands `serviqo-dashboard`.
 *
 * Returns `null` for every failure rather than throwing, exactly as
 * `verifyAccessToken` does: `jose` raises a different error class per failure
 * mode, each naming the claim that failed, and letting those propagate would
 * put "expired" and "wrong audience" one `instanceof` away from a response
 * body (ADR-015 §2).
 *
 * Note what this does NOT do: it does not confirm the customer still exists,
 * and it does not decide the token applies to the tenant at hand. Both are
 * the caller's, because both need a database and a tenant already resolved
 * from the widget key — the token's `org` claim is compared against that,
 * never trusted to select it.
 */
export async function verifyWidgetToken(token: string): Promise<WidgetPrincipal | null> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];

  try {
    ({ payload } = await jwtVerify(token, signingKey(), {
      algorithms: [ALGORITHM],
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
    }));
  } catch {
    // The token is not logged here, valid or not: it is a credential. The
    // caller records why a session was not resumed, never what was presented.
    return null;
  }

  // Both claims are minted by `issueWidgetToken` above, so a token whose
  // signature validates always carries them. Checked anyway — the shape of
  // the payload is not what the signature attests to, and a malformed `sub`
  // reaching Mongoose would be a 500.
  const sub = payload.sub;
  const organizationId = payload[ORGANIZATION_CLAIM];
  if (typeof sub !== "string" || !OBJECT_ID_PATTERN.test(sub)) return null;
  if (typeof organizationId !== "string" || !OBJECT_ID_PATTERN.test(organizationId)) return null;

  return { customerId: sub, organizationId };
}
