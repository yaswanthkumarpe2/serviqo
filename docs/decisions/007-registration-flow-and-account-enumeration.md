# ADR-007: Registration Flow, Account Enumeration, and the Request Boundary

**Status:** Accepted
**Date:** 2026-08-05
**Phase:** 2 (Slice 9 — the first endpoint that accepts a request body and the first genuine business workflow)
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) (authentication architecture), [ADR-003](./003-domain-first-server-modules.md) (module layout), [ADR-005](./005-account-action-token-lifecycle.md) (account action tokens)

## Context

Every slice before this one built persistence. `POST /api/v1/auth/register`
is the first route that accepts client-controlled input, the first that
writes to two collections in one operation, and the first that sends email.
It therefore has to settle a set of questions that no earlier slice could:
how input is validated, what a duplicate email discloses, what happens when
the second of two writes fails, and what a caller learns when something
goes wrong.

Scope is registration only. Email-verification consumption, resend, login,
refresh, logout, and password reset are explicitly not designed here.

## Decisions

### 1. Duplicate email answers `409 EMAIL_ALREADY_EXISTS`

Registration discloses whether an address is already registered.

The alternative — a generic `202` for both cases — does not actually close
enumeration unless the existing address is *also* emailed a "you already
have an account" notice. That notice turns an unauthenticated endpoint into
an email-sending oracle pointed at arbitrary addresses, trading enumeration
for spam amplification. Timing also leaks regardless, since Argon2id runs
on the create path and not on the duplicate path.

Serviqo is B2B support tooling. The set of addresses at a customer
organization is not a secret worth this cost, and an admin onboarding a
team has to be told plainly that an address is already taken.

**Two protections, one authority.** A `findByEmail` pre-check produces the
409 without spending ~19 MiB and ~100 ms of Argon2id work — it is a UX and
cost optimization, *not* a security control. The unique index on
`User.email` is the final authority: a duplicate-key error (Mongo `11000`)
from `create` is translated into the identical 409, so a race between two
concurrent requests resolves correctly no matter which one wins.

**Sibling flows are deliberately asymmetric and must stay that way.** Login
answers a generic `401 INVALID_CREDENTIALS`; forgot-password answers a
generic `202` unconditionally. Both can be generic at zero UX cost.
Registration cannot. A future reviewer should not "fix" this inconsistency.

### 2. `POST /register` never resends verification

An existing unverified user does **not** receive a fresh verification email
from this endpoint. Doing so would be the same email oracle as above, and
worse: issuing a replacement token invalidates the real user's outstanding
one, letting an attacker cancel a pending verification at will by
re-submitting a known address.

Resend belongs to a dedicated, separately rate-limited endpoint in a later
slice.

### 3. A failed verification-token write leaves the User in place

If `User` is created and `AccountToken` creation then fails, the User is
**preserved, unverified**, and the request answers a generic
`500 INTERNAL_ERROR`.

Compensating deletion of the new User was considered and rejected. It would
put a destructive persistence primitive on an unauthenticated code path and
would require adding a delete method to `user.repository.ts` for rollback
alone. Account verification is recoverable; the rollback machinery is a
permanent standing risk in exchange for a rare, recoverable state.

**Consequence, recorded deliberately:** the affected user owns an account
they cannot verify, and their retry returns `409 EMAIL_ALREADY_EXISTS` —
not an obvious message for someone who just saw a 500. Nothing in this
slice resolves it.

**Therefore the resend-verification slice has elevated priority.** It is
the single recovery path for both this failure and the delivery failure in
§4, and until it exists neither has a remedy.

The failure is rare by construction: `AccountToken.create` realistically
fails only when MongoDB is unavailable, in which case `User.create` would
almost certainly have failed first and no User would exist at all.

### 4. Email delivery failure does not fail the request

If both writes succeed and `sendVerification` throws, registration still
answers **201**. The account exists and the token is genuinely valid for 24
hours; deleting a user because a mail vendor blipped is disproportionate,
and failing the request would drop the caller into the same retry trap as
§3.

**The success body therefore never claims an email was sent.** It reports
account state only. A 201 that says "check your inbox" would be a lie in
exactly this case; a 201 that reports `{ id, name, email, emailVerified }`
is true in both.

### 5. No transaction, no replica set

Registration performs no cross-collection compensation of any kind. Both
writes are single-document atomic, and the only multi-collection failure is
tolerated as recoverable (§3) — consistent with ADR-005, which already
classifies the email-verification boundary as recoverable by resending.

Replica-set conversion becomes blocking before **organization onboarding**
(an ownerless organization is unrecoverable and violates an approved
invariant) and **password reset** (consume → revoke sessions → update
password has a security-relevant mid-failure state), per ADR-005.

### 6. Validation is middleware at the HTTP boundary

A route declares its schema in its own definition:

```ts
router.post("/register", validateBody(registerSchema), controller.register);
```

so "does this route validate its input?" is answered by reading the route
file rather than auditing the handler. Services below take already-validated
arguments and enforce business rules (email taken), not shape.

Zod object schemas strip unrecognized keys, so a client cannot smuggle
`status` or `emailVerifiedAt` through to a repository — mass assignment is
structurally impossible rather than something each service must remember to
guard.

**Password length is measured with the existing crypto primitives.** Zod's
`.min()`/`.max()` count UTF-16 code units; `isPasswordLengthValid` counts
code points after NFC, and that is what `hashPassword` enforces. Left to
diverge, a six-emoji password (6 code points, 12 code units) would pass
schema validation and then make `hashPassword` throw — a 500 on
valid-looking input. The schema therefore reuses
`isPasswordLengthValid(normalizePassword(value))` so the validator and the
hasher cannot drift. The schema still returns the password **raw**; NFC
ownership stays inside the crypto boundary.

### 7. The failure envelope gains an optional `details`

```
error: { code, message, details?: [{ field, message }], requestId, timestamp, version }
```

`details` is present only when field-level issues exist and absent
everywhere else, so ADR-002 §5's contract is extended rather than changed —
a client reading only `code` and `message` is unaffected.

**`details` carries a path and a reason, never a value.** The rejected input
is frequently the thing that must not be echoed: a password that failed the
length rule, an address typed into the wrong box. A response body reaches
client logs, error trackers, and browser history. Zod's built-in messages
describe expected *types*, and because the schema runs in strip mode rather
than `.strict()`, the one issue kind that would name client-supplied keys
(`unrecognized_keys`) can never fire.

### 8. Unparseable bodies are answered by the error handler

`express.json()` rejects malformed JSON, oversized bodies, and unsupported
encodings *before* any route middleware runs, so no schema ever sees them.
Left alone they fall through as unrecognized errors and become a generic
500 — telling a client its own malformed request was a server fault. They
are mapped to `MALFORMED_JSON` (400), `PAYLOAD_TOO_LARGE` (413), and two
415s.

**Body-parser's own message is discarded, not forwarded**: a JSON syntax
error quotes the offending fragment of the request body, and on this
endpoint that fragment can be the password. Each failure type gets a fixed
message instead.

This also required `requestContext` to run **before** `express.json()`.
Previously a body-parser rejection reached `errorHandler` with `req.log`
undefined, producing a `TypeError` and Express's default HTML 500. No
earlier endpoint accepted a body, so nothing had exercised that path.

### 9. `CLIENT_URL` is required, validated, and has no default

A wrong `CLIENT_URL` mails live 24-hour credentials to the wrong origin, so
it is validated at boot like `MONGODB_URI`: required, no default, `http:`
or `https:` only, no query, no fragment, trailing slashes normalized.
`loadEnv()` already throws on failure, so a misconfigured process cannot
start.

The verification link is `${CLIENT_URL}/verify-email?token=<raw-secret>`,
built with the `URL` API rather than string concatenation so a trailing
slash or stray component cannot produce a malformed link.

**The token must stay in the query string.** `lib/email/redaction.ts` maps
the exact pathname `/verify-email` to a known action and reports only
whether a `token` parameter was present. A path-segment form
(`/verify-email/<secret>`) classifies as `unknown` — and that module's own
comments name that exact shape as the failure it was hardened against.

### 10. `ConsoleEmailProvider` cannot become the production provider

`resolveEmailProvider()` returns the console provider outside production and
**throws** under `NODE_ENV=production`, because no real provider exists yet.
It is called during app construction, not at first send: a production server
that boots and then silently console-logs verification emails is precisely
the failure being guarded against, and discovering it on the first
registration is too late.

No SMTP, no vendor SDK, and no `EMAIL_PROVIDER` selection enum — one
implementation exists, and a selector with a single arm is a switch waiting
for a second vendor.

### 11. Domain events are deferred — a deliberate ADR-002 §6 deviation

ADR-002 §6 approved lightweight domain-event hooks so that call sites exist
before any subscriber does. No event helper has been built, and this slice
does not build one: there is no consumer, and a `user.registered` emit whose
only sink is a Pino line is something the service already does directly.

Revisit at organization onboarding, where audit logging (SECURITY.md §9)
creates a genuine second and third emitter. **Whenever it is introduced, an
event payload must never carry a password, a raw token, a token hash, or a
verification URL.**

### 12. Schemas stay in `modules/auth/` — a deliberate ADR-002 §7–19 deviation

ADR-002 names `packages/validation` as the home for shared Zod schemas.
`packages/` does not exist and has no occupant, and `apps/web` has no
authentication forms until Phase 4. Creating a package to serve a single
consumer is the premature scaffolding this project has otherwise avoided.

This is a deferral, not a reversal: when Phase 4 needs the same schema for
client-side validation, the file moves, because nothing in it imports server
internals.

### 13. Authentication rate limiting is a deployment blocker

SECURITY.md §3 requires strict rate limiting on authentication endpoints.
It is **not** implemented in this slice: `express-rate-limit`'s default
memory store is per-process, Serviqo goes multi-node at Phase 8, and
building it now means building it twice.

**Authentication endpoints must not be exposed outside local development
until authentication rate limiting is implemented** — this covers staging,
public demos, tunnel/ngrok-style exposure, shared environments, and
production.

This is a release gate, not optional future hardening, for two concrete
reasons: `POST /register` performs Argon2id work (~19 MiB per call) on an
unauthenticated path, making it trivially DoS-able; and it is the
compensating control that §1's enumeration tradeoff depends on. Recorded in
SECURITY.md §3 as well, because that is the document someone reads before
deploying.

### 14. CSRF protection is not required here

Registration is unauthenticated, sets no cookie, and consumes no ambient
authority — a forged cross-site request could only create an account the
attacker already controls the inputs for. Incidentally, `express.json()`
parses only `application/json`, which a classic cross-site `<form>` cannot
produce.

Revisit when refresh cookies exist (ADR-004), where `SameSite` on the
refresh cookie is the primary control.

## Consequences

- Registration discloses whether an address is registered, in exchange for a
  usable onboarding flow. Login and forgot-password must stay generic.
- A rare `AccountToken` write failure leaves an unverifiable account whose
  owner sees `409` on retry, until the resend slice ships. That slice is now
  a priority rather than a convenience.
- The failure envelope has one optional key; no existing key moved.
- Every future route gets a validated body by adding one middleware to its
  definition, and forgetting it is visible in the route file.
- Services take their `EmailProvider` as an explicit dependency, so tests
  inject a fake without touching module resolution or the real logger.
- Authentication cannot ship to any shared environment until rate limiting
  exists.
