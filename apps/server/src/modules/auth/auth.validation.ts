import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../../config/constants";
import { isPasswordLengthValid, normalizePassword } from "../../lib/crypto/password";

/**
 * Request schemas for the auth module (ADR-007 §12).
 *
 * These live beside the module rather than in `packages/validation`: that
 * package does not exist, and `apps/web` has no authentication forms until
 * Phase 4. When it does, this file moves — nothing in it imports server
 * internals beyond the password primitives, which move with it.
 */

const NAME_MAX_LENGTH = 100;

/** RFC 5321's maximum forward-path length. */
const EMAIL_MAX_LENGTH = 254;

/**
 * C0 and C1 control characters, including DEL.
 *
 * A display name eventually reaches an email envelope, where a bare CR or LF
 * is a header-injection primitive. Cheap to reject at the boundary now,
 * awkward to retrofit once names are stored.
 *
 * Deliberately narrow: no case folding, no Unicode normalization, no script
 * or presentation restrictions. A name is presentation data belonging to its
 * owner, not an identifier this system canonicalizes.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Trimmed before the format check, so a stray leading space is not reported
 * as a malformed address. Trimming is the ONLY transformation here:
 * `normalizeEmail` in user.model.ts remains the single authority on
 * canonicalization, and a second lowercasing here would be a second
 * authority free to drift from it.
 *
 * Shared by every schema that takes an address, so the length bound and the
 * no-canonicalization rule are stated once.
 */
const emailField = z
  .string()
  .trim()
  .max(EMAIL_MAX_LENGTH, `Email must be at most ${EMAIL_MAX_LENGTH} characters`)
  .pipe(z.email("Email must be a valid email address"));

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(NAME_MAX_LENGTH, `Name must be at most ${NAME_MAX_LENGTH} characters`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), "Name must not contain control characters"),

  email: emailField,

  /**
   * Returned raw — no trim, no case folding, no transformation of any kind.
   * Leading and trailing whitespace can be intentional in a password.
   *
   * Length is checked with the same primitives `hashPassword` enforces,
   * rather than Zod's `.min()`/`.max()`. Zod counts UTF-16 code units;
   * `isPasswordLengthValid` counts code points after NFC. Left to diverge, a
   * six-emoji password (6 code points, 12 code units) would pass this schema
   * and then make `hashPassword` throw — a 500 on valid-looking input.
   * Sharing the primitive is what makes that drift impossible.
   *
   * Measuring the normalized form does not normalize the returned value:
   * NFC ownership stays inside the crypto boundary.
   */
  password: z.string().superRefine((value, ctx) => {
    if (!isPasswordLengthValid(normalizePassword(value))) {
      ctx.addIssue({
        code: "custom",
        message: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
      });
    }
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Login takes an address and a password, and nothing else.
 *
 * The password is checked for presence only — deliberately NOT against the
 * registration policy. A password that is too short is simply wrong, not
 * malformed, and answering it with a 400 that names the length rule would
 * both leak the policy to an unauthenticated caller and split login's single
 * generic failure (ADR-011 §3) into two distinguishable ones.
 *
 * It is also returned raw, like registration's: NFC normalization is the
 * crypto boundary's job, and `verifyPassword` already refuses an over-long
 * value without hashing it.
 */
export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Resend takes the address and nothing else. No password, no name, and
 * deliberately no "reason" or "redirect" field — an unauthenticated endpoint
 * that emails a link should accept the smallest possible input.
 */
export const resendVerificationSchema = z.object({
  email: emailField,
});

export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

/**
 * Generous upper bound on a submitted token. The real secret is 43
 * base64url characters; this only stops an absurd body from reaching the
 * hash function, and `express.json()`'s own limit already caps the request.
 */
const TOKEN_MAX_LENGTH = 512;

/**
 * Verification takes the token and nothing else.
 *
 * Deliberately no charset or length-exactness rule beyond the bound above.
 * A token of the wrong shape should fail the same way a token of the wrong
 * value does — it hashes to something no document matches, producing the
 * single `INVALID_VERIFICATION_TOKEN` response (ADR-009 §1). A dedicated
 * validation error for malformed tokens would carve out a second,
 * distinguishable failure for no benefit.
 *
 * Trimming is safe: base64url contains no whitespace, so trimming can only
 * repair a sloppily-pasted value and can never alter a real secret.
 */
export const verifyEmailSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, "Token is required")
    .max(TOKEN_MAX_LENGTH, `Token must be at most ${TOKEN_MAX_LENGTH} characters`),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
