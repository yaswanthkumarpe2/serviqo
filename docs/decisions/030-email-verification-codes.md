# ADR-030: Email Verification by Six-Digit Code

**Status:** Accepted
**Date:** 2026-09-10
**Recorded:** 2026-09-14. This is a **reconstruction**. The decision shipped in [PR #4](https://github.com/yaswanthkumarpe2/serviqo/pull/4) (`74320c3`), and about fifteen source files cite this ADR by section, but the document itself was never committed. It is rebuilt from that PR's description and from the implementation. Section numbers match the existing citations; nothing is recorded here that the code does not already do.
**Phase:** 2 (Authentication)
**Amends:** [ADR-005](./005-account-action-token-lifecycle.md) §2 (the `tokenHash` index was unique), [ADR-008](./008-resend-verification-and-silent-responses.md) and [ADR-009](./009-email-verification-consumption.md) (verification was a link carrying a secret)
**Related:** [ADR-007](./007-registration-flow-and-account-enumeration.md) §4 (account enumeration); [ADR-018](./018-rate-limiting-and-security-headers.md) (rate limiting); [ADR-031](./031-credential-rate-limit-classes.md) (the classes this change made necessary)

## Context

Email verification sent a link carrying a 256-bit secret, valid for twenty-four
hours. It worked, but it only worked in the browser that opened the mail. A
person reading mail on a phone and signing up on a laptop had to forward the
link to themselves, or give up.

A six-digit code solves that. It also changes the security problem entirely,
and that change is what this ADR is about.

## Decisions

### 1. The credential is a code in the body of the mail

`POST /auth/verify-email` takes `{ email, code }`. Registration and resend both
mint a code, email it, and store only its SHA-256 hash (ADR-005 §1, unchanged).

A link secret has about 256 bits of entropy, so guessing it is not a threat
anyone models. That is why the old flow never counted wrong attempts and why a
token could live a day. **A six-digit code has about 20 bits**: one in a
million, which a script can walk through in minutes. The code alone is not a
credential. The credential is the code **plus** the two limits on guessing in
§3 and §4, and both are enforced.

| | Link (before) | Code (after) |
| --- | --- | --- |
| Entropy | ~256 bits | ~20 bits |
| Lifetime | 24 hours | **10 minutes** |
| Wrong guesses allowed | never counted | **5, then destroyed** |

### 2. How codes are generated

`lib/crypto/otp.ts` is its own module, separate from `tokens.ts`, because a
six-digit code is a different kind of credential from a 256-bit secret, and
that difference is the whole design problem.

- Codes are built **digit by digit with `crypto.randomInt`**, which avoids the
  modulo bias of `randomBytes(n) % 1000000`. With only a million possibilities,
  a skew toward some codes would measurably shorten an attack.
- Codes are kept as **strings**, so a leading zero survives. `042931` is a
  legitimate code.

### 3. A ten-minute lifetime

`EMAIL_VERIFICATION_TOKEN_TTL_MS` went from twenty-four hours to ten minutes.
For a code, lifetime is one of the two terms bounding a guessing attack. Ten
minutes is enough for mail to arrive and for a person to switch windows and
type six digits, and short enough that a code left in an abandoned inbox is not
a standing credential.

Expiry is enforced in the consumption predicate (`expiresAt > now`), never left
to the TTL index, which only cleans up storage (ADR-005 §5).

### 4. Five wrong guesses, counted on the token

`AccountToken.attempts` counts wrong codes. `EMAIL_VERIFICATION_MAX_ATTEMPTS`
is five. This is not extra hardening; without it the code is not a credential
at all.

- **Attempts are counted on the token document**, not per IP or per session.
  Rotating either buys an attacker nothing, because the budget belongs to the
  credential being guessed.
- **Exhaustion consumes the token** rather than flagging it, so a sixth guess
  has nothing to test even if it is correct. Getting five more guesses requires
  a new email, which the resend rate limiter meters.
- **Counting is one atomic aggregation-pipeline update**: increment, then
  consume if the count has reached the limit. Doing it in two steps would let
  concurrent guesses each read a count from before the increment and together
  spend far more than five.
- A failure to count must not become a free guess, so the refusal is thrown
  whatever the counter does.

A bug found while building this: Mongoose rejects a pipeline update unless
`updatePipeline: true` is set. The rejection was caught, logged and swallowed,
so the counter silently never incremented and the code allowed unlimited
guesses. The suite now asserts the counter directly, not only the refusal.

### 5. Consumption matches on the owner and the hash

A six-digit code cannot identify a token by itself: a million codes are shared
among every pending account. So the **address routes and the code proves**.
`consumeValidByUserAndPurpose` looks the user up by address, then atomically
consumes a token matching owner, purpose, hash, not-consumed and not-expired,
all in one predicate.

Two consequences:

- **The `tokenHash` index is no longer unique.** Two users holding the same
  code at the same time is ordinary once there are a thousand outstanding codes.
  A unique index turned that coincidence into a failed registration for whoever
  signed up second. Nothing is lost, because codes are never looked up by hash
  alone.
- **Every failure gives one refusal**: wrong code, expired, already used, never
  issued, and no such account (ADR-009 §1). An unknown address is answered
  exactly as a wrong code is, so the endpoint does not reveal whether an account
  exists (ADR-007 §4).

The request schema checks the code's shape (six digits) **before** any lookup,
so a typo is refused with a 400 and does not spend one of the five guesses.
That check depends only on the submitted string, so it reveals nothing about
any account.

### 6. What the mail carries

- **The code is in the body, never the subject.** Mail clients show subjects
  in notifications and on locked screens, and a credential readable without
  unlocking the phone can be used by anyone holding it.
- **The URL carries only the address, for prefill, and no secret.** It opens
  the page where the code is typed, so it is harmless in a referrer header,
  browser history, proxy log or screenshot.
- The mail states the expiry, so a code that stops working reads as expired
  rather than broken.
- `ConsoleEmailProvider` logs `codeIssued: true` and never the code. Six digits
  are easy to read off a shared terminal and easy to remember.

## Consequences

- Verification works across devices.
- Sign-up became an interactive step with a retry loop, which exhausted the
  shared credential rate-limit budget for honest users. [ADR-031](./031-credential-rate-limit-classes.md)
  split that class for this reason.
- `consumeValidByHashAndPurpose` and the hash index remain for credentials that
  are links. [ADR-036](./036-password-reset-by-emailed-code.md) later moved
  password reset to codes as well, so no production flow issues a link today.
