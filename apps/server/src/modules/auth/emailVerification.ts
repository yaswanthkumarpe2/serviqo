import {
  EMAIL_VERIFICATION_CODE_LENGTH,
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
} from "../../config/constants";
import { generateNumericCode } from "../../lib/crypto/otp";
import { sha256 } from "../../lib/crypto/tokens";
import { env } from "../../lib/env";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";

import type { Types } from "mongoose";

/**
 * The single place email-verification credentials are minted (ADR-008 §7,
 * ADR-030).
 *
 * Registration and resend both issue these. Two copies of this logic would
 * be two chances for one to drift on TTL, on hashing, or — most dangerously
 * — on code length, which is half of what bounds a guessing attack.
 *
 * Since ADR-030 the credential is a six-digit code carried in the BODY of
 * the email rather than a secret carried in a URL. The URL below still
 * exists, but it now points at the page where the code is typed and holds
 * no secret at all.
 */

/**
 * Mints a verification CODE for `userId` and returns the digits.
 *
 * Only the SHA-256 hash reaches MongoDB (ADR-005 §1). The returned code
 * exists solely in the caller's memory and in the outgoing email; it must
 * never be logged, persisted in the clear, returned to a client, or placed
 * in a domain event. Six digits are far easier to leak into a log line than
 * a wall of base64, so that rule is stricter here in practice than it was
 * for a link.
 *
 * Expiry is computed from server time, never from anything client-supplied,
 * and `EMAIL_VERIFICATION_TOKEN_TTL_MS` is ten minutes rather than the
 * twenty-four hours a link had — a code's lifetime is one of the two terms
 * bounding a guessing attack (ADR-030 §3).
 *
 * The caller must invalidate outstanding codes before calling this, so a
 * user never holds two valid codes at once. Both callers do.
 */
export async function issueVerificationCode(userId: Types.ObjectId): Promise<string> {
  const code = generateNumericCode(EMAIL_VERIFICATION_CODE_LENGTH);

  await accountTokenRepository.create({
    userId,
    purpose: "email_verification",
    tokenHash: sha256(code),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
  });

  return code;
}

/**
 * Builds the page where the recipient types their code.
 *
 * Constructed through the URL API, never string concatenation: `CLIENT_URL`
 * is operator-supplied, and a trailing slash or stray component would
 * otherwise produce a malformed link.
 *
 * Carries the ADDRESS and no secret — the whole point of ADR-030 is that the
 * credential travels in the body of the mail for a human to read and retype,
 * not in a URL. That removes a class of leak a link had: this URL is safe in
 * a referrer header, a browser history, a proxy log, or a pasted screenshot,
 * because possessing it grants nothing.
 *
 * The email prefill is a convenience so the recipient types six digits
 * instead of six digits and an address. It authorizes nothing: the code is
 * still checked against whatever address is submitted.
 */
export function buildVerificationUrl(email: string): string {
  const url = new URL("/verify-email", env.CLIENT_URL);
  url.searchParams.set("email", email);
  return url.toString();
}
