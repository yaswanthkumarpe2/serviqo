# ADR-031: Splitting the Credential Rate-Limit Class

**Status:** Accepted
**Date:** 2026-09-11
**Phase:** 2 (Authentication + Organization onboarding)
**Amends:** [ADR-018](./018-rate-limiting-and-security-headers.md) §3, which defined a single `credential` class covering `POST /register`, `POST /login`, `POST /resend-verification` and `POST /verify-email`
**Related:** [ADR-007](./007-registration-flow-and-account-enumeration.md) §1 (registration discloses a taken address deliberately), §13 (registration's Argon2id cost on an unauthenticated path is a rate-limiting concern); [ADR-008](./008-resend-verification-and-silent-responses.md) §1 (resend answers 204 for every outcome); [ADR-011](./011-login-and-session-issuance.md) §7 (per-account lockout); [ADR-018](./018-rate-limiting-and-security-headers.md) §3 (the classes), §4 (limiter placement and keying), §6 (one generic refusal, the class never reaches a body), §8 (disabled under `NODE_ENV=test`), §10 (safe fields only in the log); [ADR-030](./030-email-verification-codes.md) §3–4 (the code's TTL and its attempt limit)

## Context

ADR-018 grouped four endpoints into one `credential` class and gave it
`LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCK_DURATION_MS` — ten requests per
fifteen minutes per IP — so that the per-IP bound and the per-account lockout
agreed about one policy rather than enforcing two.

That reasoning was sound for `/login` and wrong for the other three, and
ADR-030 made it visibly wrong. Verification moved from a link to a six-digit
code, which turned one email round trip into an interactive step with a retry
loop. Completing a single honest sign-up now costs:

| step | calls |
| --- | --- |
| `POST /register` | 1 |
| `POST /resend-verification` (slow mail, or spam folder) | 0–2 |
| `POST /verify-email` (mistyped a digit) | 1–3 |
| `POST /login` | 1 |

Three to seven requests, against a budget of ten that was sized to bound a
**password guesser**. The budget is per IP, so a household, an office behind
one NAT, or a developer testing the flow exhausts it in one or two sign-ups
and is then locked out of *every* credential endpoint for fifteen minutes —
including `/login`, which they were not doing anything unusual on.

That is the failure mode a limiter must not have: it refused the people using
the product correctly, while an attacker mounting the attack the number was
drawn against got exactly the ten attempts they were always going to get. A
shared counter also made the two behaviours indistinguishable in the logs; a
run of refusals on this class could equally have been one person signing up
twice.

The instinct is to raise the limit. That is the wrong fix, because the four
endpoints are not defending against the same thing and no single number can be
right for all of them — a limit generous enough for verification retries is
too generous for password guessing, and one tight enough to bound mail
sending is far too tight for anything else.

## Decisions

### 1. Four endpoints, four classes

`credential` is split into `credential`, `registration`, `emailVerification`
and `verificationResend`. Each keeps the machinery ADR-018 built — the same
factory, the same store, the same draft-7 headers, the same enveloped generic
refusal, the same safe-fields-only log line — and differs only in its numbers
and its name.

The class name still never reaches a response body (ADR-018 §6). It does reach
the log, which is the point of naming them separately: an operator can now see
`limitClass: "verificationResend"` and know that somebody is hammering the mail
sender, rather than seeing `credential` and having to guess which of four
behaviours produced it.

**Not one class with a per-route multiplier.** A multiplier is a number whose
justification lives somewhere other than the number itself, and each of the
four limits below is argued from what its own endpoint faces. Four constants
that each say why are cheaper to review than one constant and three
adjustments.

### 2. `credential` keeps the lockout pair, and now covers only `/login`

`CREDENTIAL_LIMIT` and `CREDENTIAL_WINDOW_MS` remain
`LOGIN_MAX_FAILED_ATTEMPTS` and `LOGIN_LOCK_DURATION_MS`. ADR-018 §3's
argument was always specifically about login — the per-IP bound and the
per-account lockout must not encode two different answers to "how many
credential attempts is too many" — and narrowing the class to `/login` makes
the constant match the argument for the first time.

Changing the lockout constants without revisiting these still puts them back
into disagreement. That warning is unchanged and now applies to one endpoint
instead of four.

### 3. `registration`: 5 per hour, per IP

Guessing is not the attack on `/register`; there is nothing to guess. Two
other things are:

- **Argon2id cost.** ADR-007 §13 named it precisely: each call spends ~19 MiB
  and ~100 ms on an unauthenticated path. Five per hour bounds that to
  something a single process shrugs at.
- **Bulk creation of unverified accounts.** ADR-007 §1 accepts that
  registration discloses whether an address is taken, which makes the endpoint
  an enumeration oracle as well; a low hourly rate is what makes enumerating
  at scale impractical without also being the enumeration defence, which
  ADR-007 deliberately declined to build.

**An hour-long window rather than fifteen minutes.** With a short window, the
same hourly rate is available to a patient script — twenty per hour in
four-per-window bursts — and the limit only slows an attacker down without
bounding them. The long window is what makes a slow drip as unrewarding as a
burst.

**Five is stricter than the ten this endpoint had.** That is intended. The old
number was never chosen for registration; it was inherited from login, and
loosening a shared budget was the wrong repair. A person signs up once, and
an admin onboarding a team from one office does it a handful of times.

### 4. `emailVerification`: 20 per fifteen minutes, per IP

This one *is* a guessing defence, and it is deliberately the **outer** of two
bounds rather than the real one. The real one is
`EMAIL_VERIFICATION_MAX_ATTEMPTS` (ADR-030 §4): five wrong codes and the code
is consumed, so an attacker's ceiling is five tries out of a million per
issued code no matter what this class allows, and getting five more requires
triggering a new email — which §5 meters.

Given that, the per-IP number is free to be generous enough for the honest
case, which the old budget was not: mistyping a code, a second tab, two people
behind one address each verifying their own account. Twenty covers all of that
and still refuses a client grinding codes across many addresses from one IP.

### 5. `verificationResend`: 3 per fifteen minutes, per IP

The tightest of the four, and the only one tighter than the budget it
replaced.

Every accepted call to `/resend-verification` puts a message in an inbox the
**caller names**. The cost of being generous here is paid by a third party and
by the sending domain's reputation, not by this server — which makes it the
one endpoint in the set where the server's own capacity is the wrong thing to
size against.

Three is two more than a person waiting on slow mail needs. Someone who
exhausts it has a delivery problem that a fourth copy will not solve.

ADR-008 §1's silence is unaffected: resend still answers 204 for every
outcome, and a 429 from this class discloses only that the *caller* has asked
too often — a fact about the caller, not about the address.

### 6. What did not change

- **Placement.** All four still mount *before* `validateBody`, for ADR-018's
  original reason: a limiter behind validation spends a Zod parse per refused
  attempt, and — more importantly — lets a refused caller learn from the
  difference in responses whether their body was well-formed.
- **Keying.** All four are keyed by IP through `ipKeyGenerator`, because none
  of them has a verified principal. IPv6 is still masked to its /64.
- **The refusal.** One generic message, no class, no limit, no window
  (ADR-018 §6).
- **The test default.** Rate limiting stays off under `NODE_ENV=test`
  (ADR-018 §8); `tests/security.rateLimit.test.ts` opts in.
- **`createDisabledRateLimiters`.** It gains the three new keys, keeping the
  disabled set mirroring the enabled one exactly — the property that stops a
  route mounting a real limiter under one configuration and `undefined` under
  the other.

### 7. What this does not do

- **No per-account bound on verification or resend.** Both are keyed by IP
  only. A distributed caller with many addresses still gets a fresh budget per
  address, which is the standing limitation of any IP-keyed class and is
  bounded in practice by `EMAIL_VERIFICATION_MAX_ATTEMPTS` for verification
  and by nothing for resend. A per-address resend budget is the obvious next
  step and is deliberately not taken here: it needs storage keyed on an
  identifier the endpoint is otherwise careful not to confirm exists.
- **No change to the memory store.** ADR-018 §2's deployment gate stands: the
  default `MemoryStore` is correct for one process and wrong behind a load
  balancer, where N nodes grant N times every budget above.
- **No CAPTCHA, no proof of work, no email-domain policy.** Each is a real
  answer to bulk registration and none is a rate-limiting decision.

## Consequences

- A person completing a sign-up no longer spends a password guesser's budget.
  The regression test for this asserts the direction that matters: registering
  works *while* the login budget is exhausted.
- Registration is meaningfully stricter than before (5/hour, down from an
  effective 10/15min). This is the one behaviour change that could surprise
  someone, and it is the correct strictness for the endpoint.
- Resends are meaningfully stricter (3/15min, down from 10). Anyone who was
  relying on hammering resend to work around spam-folder delivery now cannot,
  which correctly reclassifies that as a deliverability problem.
- Four classes must be kept in step in three places — `constants.ts`,
  `RateLimiters`, and `createDisabledRateLimiters` — and the existing test
  asserting the two sets have identical keys is what catches a miss.
