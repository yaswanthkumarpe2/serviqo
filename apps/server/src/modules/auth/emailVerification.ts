import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "../../config/constants";
import { generateSecret, sha256 } from "../../lib/crypto/tokens";
import { env } from "../../lib/env";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";

import type { Types } from "mongoose";

/**
 * The single place email-verification credentials are minted and linked
 * (ADR-008 §7).
 *
 * Registration and resend both issue these. Two copies of this logic would
 * be two chances for one to drift on TTL, on hashing, or — most dangerously
 * — on where the secret sits in the URL.
 */

/**
 * Minimal structural type for the logger auth services need.
 *
 * Declared here rather than importing Pino's, so a controller can pass
 * `req.log` (carrying the requestId) and a test can pass a capture function,
 * without the production logger being weakened or reconfigured.
 */
export interface AuthLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Names a failure without carrying its message.
 *
 * A Mongo error's text can quote the offending document — for a duplicate
 * key that includes the indexed value — so only the constructor name is ever
 * logged. It distinguishes "database unreachable" from "constraint violated"
 * during triage and carries no data.
 */
export function failureType(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}

/**
 * Mints a verification token for `userId` and returns the raw secret.
 *
 * Only the SHA-256 hash reaches MongoDB (ADR-005 §1). The returned secret
 * exists solely in the caller's memory and in the outgoing email link; it
 * must never be logged, persisted, returned to a client, or placed in a
 * domain event.
 *
 * Expiry is computed from server time, never from anything client-supplied.
 */
export async function issueVerificationToken(userId: Types.ObjectId): Promise<string> {
  const rawSecret = generateSecret();

  await accountTokenRepository.create({
    userId,
    purpose: "email_verification",
    tokenHash: sha256(rawSecret),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
  });

  return rawSecret;
}

/**
 * Builds the emailed verification link.
 *
 * Constructed through the URL API, never string concatenation: `CLIENT_URL`
 * is operator-supplied, and a trailing slash or stray component would
 * otherwise produce a malformed link.
 *
 * The secret goes in the query string and must stay there. `lib/email/
 * redaction.ts` classifies the exact pathname `/verify-email` and reports
 * only whether a `token` parameter was present; a path-segment form would
 * classify as "unknown" and is precisely the shape that module was hardened
 * against.
 */
export function buildVerificationUrl(rawSecret: string): string {
  const url = new URL("/verify-email", env.CLIENT_URL);
  url.searchParams.set("token", rawSecret);
  return url.toString();
}
