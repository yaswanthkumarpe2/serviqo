import { z } from "zod";

import {
  EMAIL_VERIFICATION_CODE_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../../config/constants";
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
 * Verification takes the ADDRESS and the CODE (ADR-030 §5).
 *
 * The email is not decoration and not a convenience — it is what makes a
 * six-digit code usable at all. A 43-character link secret identified a
 * single token on its own; `481920` does not, because a million codes are
 * shared among every pending account. The address is the routing half, the
 * code is the secret half, and consumption matches on both together.
 *
 * `code` is shape-checked here so a typo — five digits, a stray space, a
 * letter — is refused at the HTTP boundary as a 400 before any lookup runs.
 * That matters beyond tidiness: a malformed submission must not spend one of
 * the small number of guesses a real code is allowed, or a fumbling user
 * would lock themselves out faster than an attacker.
 *
 * Refusing on shape leaks nothing. It depends only on the submitted string,
 * never on whether the account exists or has a code outstanding
 * (ADR-007 §4).
 */
export const verifyEmailSchema = z.object({
  email: emailField,
  code: z
    .string()
    .trim()
    .length(EMAIL_VERIFICATION_CODE_LENGTH, `Code must be ${EMAIL_VERIFICATION_CODE_LENGTH} digits`)
    .regex(/^[0-9]+$/, "Code must be digits only"),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
