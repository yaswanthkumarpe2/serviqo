/**
 * Client-side checks for the sign-in form.
 *
 * These exist to save a round trip and point at the offending field — the
 * server remains the only authority, and its `VALIDATION_ERROR` details are
 * rendered the same way these are.
 *
 * The password is checked for presence ONLY. Applying the registration
 * length policy here would duplicate a rule the server deliberately does not
 * apply at login (ADR-011 §3) and would tell an unauthenticated visitor what
 * the policy is. A short password is wrong, not malformed.
 */

export interface LoginFieldErrors {
  email?: string;
  password?: string;
}

/**
 * Deliberately permissive: something, an @, something with a dot. Rejecting
 * unusual-but-valid addresses is a worse failure here than letting one reach
 * a server that will validate it properly anyway.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLogin(values: { email: string; password: string }): LoginFieldErrors {
  const errors: LoginFieldErrors = {};

  const email = values.email.trim();
  if (email.length === 0) {
    errors.email = "Email is required";
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = "Enter a valid email address";
  }

  // Not trimmed: leading and trailing whitespace can be intentional in a
  // password, so only a genuinely empty field is a client-side failure.
  if (values.password.length === 0) {
    errors.password = "Password is required";
  }

  return errors;
}

export function hasFieldErrors(errors: LoginFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
