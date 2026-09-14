/**
 * Client-side checks for the sign-up and verification forms.
 *
 * Same posture as `loginValidation.ts`: these save a round trip and point at
 * the offending field, and the server remains the only authority. Its
 * `VALIDATION_ERROR` details render through the identical path.
 *
 * Unlike login, the password IS length-checked here. That is not a
 * contradiction of `loginValidation.ts`'s reasoning — the opposite. At login,
 * stating the policy would tell an unauthenticated visitor what it is while
 * telling a legitimate user nothing they can act on, because a short password
 * is simply wrong. At registration the person is CHOOSING a password, so the
 * rule has to be visible or they cannot comply with it, and the server would
 * reject them after a round trip that taught them nothing.
 */

/**
 * Mirrors `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` in the server's
 * `config/constants.ts`.
 *
 * Duplicated rather than shared because `packages/validation` does not exist
 * and one form does not justify creating it. The duplication is safe in one
 * direction only: the server re-checks every value, so a drift here can
 * produce a needless client-side rejection but can never let a bad password
 * through. If a third consumer appears, that is the moment to extract it.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Mirrors `EMAIL_VERIFICATION_CODE_LENGTH` on the server (ADR-030). */
export const VERIFICATION_CODE_LENGTH = 6;

export interface SignUpFieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

export interface VerifyFieldErrors {
  email?: string;
  code?: string;
}

/**
 * Deliberately permissive, matching `loginValidation.ts`: something, an @,
 * something with a dot. Rejecting an unusual-but-valid address is a worse
 * failure than letting one reach a server that validates it properly.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignUp(values: { name: string; email: string; password: string }): SignUpFieldErrors {
  const errors: SignUpFieldErrors = {};

  if (values.name.trim().length === 0) {
    errors.name = "Name is required";
  }

  const email = values.email.trim();
  if (email.length === 0) {
    errors.email = "Email is required";
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = "Enter a valid email address";
  }

  /*
    Not trimmed, and measured in UTF-16 units the way the server does. A
    password is a sequence of characters the person chose, including any
    spaces at either end — silently trimming one would let someone register a
    password they cannot subsequently type.
  */
  if (values.password.length === 0) {
    errors.password = "Password is required";
  } else if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }

  return errors;
}

/**
 * Checks the verification form.
 *
 * The code is shape-checked before submission for a reason that is not
 * cosmetic: the server destroys a code after a small number of WRONG
 * attempts, and refusing a malformed value here keeps a typo from spending
 * one of them. The server refuses the same shapes at its own boundary before
 * any lookup, so this is a courtesy rather than the control.
 */
export function validateVerification(values: { email: string; code: string }): VerifyFieldErrors {
  const errors: VerifyFieldErrors = {};

  const email = values.email.trim();
  if (email.length === 0) {
    errors.email = "Email is required";
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = "Enter a valid email address";
  }

  const code = values.code.trim();
  if (code.length === 0) {
    errors.code = "Enter the code from your email";
  } else if (!/^[0-9]+$/.test(code)) {
    errors.code = "The code is digits only";
  } else if (code.length !== VERIFICATION_CODE_LENGTH) {
    errors.code = `The code is ${VERIFICATION_CODE_LENGTH} digits`;
  }

  return errors;
}

export interface ResetPasswordFieldErrors extends VerifyFieldErrors {
  newPassword?: string;
}

/**
 * Checks the reset form (ADR-036): the verification checks for the address and
 * the code, plus the sign-up length rule for the new password.
 *
 * The length rule is stated here, not withheld as login withholds it, for
 * sign-up's reason — the person is choosing a password and cannot comply with a
 * policy they are not shown. It matters more than usual on this form: the
 * server checks length before it touches the code, so a short password is
 * refused without spending the code, but only this check saves the round trip.
 */
export function validateResetPassword(values: {
  email: string;
  code: string;
  newPassword: string;
}): ResetPasswordFieldErrors {
  const errors: ResetPasswordFieldErrors = validateVerification(values);

  if (values.newPassword.length === 0) {
    errors.newPassword = "Choose a new password";
  } else if (values.newPassword.length < PASSWORD_MIN_LENGTH) {
    errors.newPassword = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  } else if (values.newPassword.length > PASSWORD_MAX_LENGTH) {
    errors.newPassword = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }

  return errors;
}

/** Checks the forgot-password form, which is only an address. */
export function validateForgotPassword(values: { email: string }): Pick<VerifyFieldErrors, "email"> {
  const email = values.email.trim();
  if (email.length === 0) return { email: "Email is required" };
  if (!EMAIL_PATTERN.test(email)) return { email: "Enter a valid email address" };
  return {};
}

export function hasSignUpErrors(errors: SignUpFieldErrors | VerifyFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
