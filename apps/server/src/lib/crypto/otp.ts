import { randomInt } from "node:crypto";

/**
 * Numeric one-time codes for email verification (ADR-030 §2).
 *
 * Deliberately its own module rather than a function in `tokens.ts`. That
 * module's header states its scope — "these values are credentials: different
 * security tier, different review expectations" — and it is right, but a
 * six-digit code is a DIFFERENT kind of credential from a 256-bit secret and
 * the difference is the whole design problem here.
 *
 * A `generateSecret()` value has ~256 bits of entropy: guessing it is not a
 * threat anyone models. A six-digit code has about 20 bits — one in a
 * million — which is guessable by a patient attacker and trivially guessable
 * by a fast one. A code is therefore only as strong as the two things that
 * bound guessing: how long it lives, and how many attempts it survives.
 * Those live in `constants.ts` beside this, and neither is optional.
 *
 * The code is emailed to prove control of an inbox, not to authorize anything
 * on its own. It is stored only as a SHA-256 hash, exactly like every other
 * account-action credential (ADR-005 §1).
 */

/** The digits a code may contain. Base ten, because a human retypes this. */
const RADIX = 10;

/**
 * Mints a uniformly random numeric code of `length` digits.
 *
 * Built digit by digit through `crypto.randomInt`, which rejection-samples
 * internally and is therefore free of the modulo bias that
 * `randomBytes(n) % 1000000` would introduce. Bias matters here in a way it
 * would not for a 256-bit secret: with only a million possibilities, a skew
 * that makes some codes more likely measurably shortens a guessing attack.
 *
 * Leading zeros are preserved because the result is assembled as a string —
 * `042931` is a legitimate code, and a numeric type would silently turn it
 * into a five-digit one, halving the space for every code that starts with a
 * zero.
 */
export function generateNumericCode(length: number): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, RADIX));
  }
  return code;
}

/**
 * Whether a submitted value could be a code at all.
 *
 * Used by the request schema so a malformed submission is refused at the HTTP
 * boundary as a shape failure, before any database lookup and before the
 * attempt counter is touched. That distinction is safe to expose: it depends
 * only on the submitted string, never on whether any account or code exists.
 *
 * Refusing these early is also what stops a client's typo from consuming one
 * of the small number of attempts a real code is allowed.
 */
export function isWellFormedCode(value: string, length: number): boolean {
  return value.length === length && /^[0-9]+$/.test(value);
}
