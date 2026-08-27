# ADR-011: Login and Session Issuance

**Status:** Accepted
**Date:** 2026-08-11
**Phase:** 2 (Slice 12 — the first endpoint that issues a credential)
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) (authentication architecture), [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) (sessions and refresh tokens), [ADR-007](./007-registration-flow-and-account-enumeration.md) (registration, enumeration policy), [ADR-009](./009-email-verification-consumption.md) (verification), [ADR-010](./010-principal-types-organization-users-and-customers.md) (principal types)

## Context

Eleven slices have built identity without ever authenticating anyone.
`Session`, `MAX_PREVIOUS_REFRESH_TOKEN_HASHES`, `LOGIN_MAX_FAILED_ATTEMPTS`,
`REFRESH_SECRET_BYTES`, `verifyPassword`, and `normalizeUserAgent` are all
committed, tested, and completely unreached — no code path has ever
constructed a Session or read a `passwordHash`.

`POST /api/v1/auth/login` is that path. It is the first endpoint that
issues a credential, which makes several decisions permanent the moment it
ships: what a token claims, where each token travels, and what a caller
learns from a refusal.

Scope is login only. Refresh, logout, logout-all, `GET /me`, the
access-token verification middleware, RBAC, and password reset are not
designed here.

## Decisions

### 1. Two tokens, two transports

| | Access token | Refresh token |
|---|---|---|
| Form | JWT, HS256, signed with `jose` | opaque `sessionId.secret` (ADR-004 §2) |
| Lifetime | 15 minutes | 7 days (the Session's) |
| Travels in | the response body | an `HttpOnly` cookie |
| Stored server-side | not at all | only as SHA-256 of the secret |

The access token goes in the body because the client attaches it as a
bearer credential and holds it in memory. Putting it in a cookie instead
would make it ambient on every request to the API, which turns every future
authenticated endpoint into a CSRF surface.

The refresh token goes in a cookie because it is the long-lived credential
and must be unreachable from JavaScript. This leaves exactly **one** ambient
credential in the browser, which is what makes the CSRF question ADR-007
§14 deferred answerable in one line: `SameSite=Strict` plus a scoped
`Path`.

**The raw refresh secret never appears in the response body**, only in the
`Set-Cookie` header. A body copy would defeat the `HttpOnly` flag entirely.

### 2. The access token declares its principal type

```
{ sub: <userId>, sid: <sessionId>, iss: "serviqo", aud: "serviqo-dashboard", iat, exp }
```

`aud` is the ADR-010 §5 requirement made concrete. Today there is one
principal type and the claim looks like ceremony; the moment a customer
visitor credential exists, it is the single control that stops a visitor
token verifying on a staff route. It cannot be retrofitted onto tokens
already in circulation.

**`sid` is present so that logout and revocation have something to address
later**, not because this slice checks it. Nothing in this slice verifies a
token at all.

**Deliberately absent: `email`, `name`, `organizationId`, `role`,
`permissions`.** Organization access is resolved per request through
Membership (ADR-004 §8), so a role baked into a token would take up to 15
minutes to stop being true after an admin revokes it — the exact staleness
ADR-004 §8 was written to avoid. Names and addresses are absent because a
JWT is not encrypted and routinely lands in logs and proxy traces.

### 3. Every credential failure answers one generic `401`

Unknown address, wrong password, locked account, and disabled account all
answer an identical `401 INVALID_CREDENTIALS` with an identical message.
ADR-007 §1 committed login to staying generic, and this is that promise
kept.

A locked account in particular is **not** told it is locked. "Temporarily
locked" confirms the address has an account, which is precisely what an
unauthenticated caller must not learn. The lock expires on its own in 15
minutes; there is nothing the caller could usefully do with the
information.

### 4. One Argon2id verification on every path

An unknown address is answered *after* verifying the submitted password
against a dummy hash whose result is discarded. A locked account is
answered after verifying against that account's real hash, also discarded.

Without this, an unknown address returns after a single indexed lookup while
a real one spends ~19 MiB and ~100 ms of Argon2id work. That difference is
trivially measurable and converts the generic `401` of §3 into an
account-existence oracle — undoing the whole decision at the network layer.
ADR-008 §2 recorded timing as an unclosed gap on the resend endpoint;
login is the flow where it is worth closing, because login is where
guessing pays.

The dummy hash is generated at service construction from a random secret,
using the current Argon2id parameters, so it can never drift from the real
ones and is never a hash of anything a person chose.

### 5. Account state is checked *after* the password, not before

Order is: find → lockout → verify password → status → verification → issue.

Checking `status` or `emailVerifiedAt` before the password would let an
unauthenticated caller distinguish "no such account" from "disabled
account" without knowing any credential, reintroducing enumeration through
a different door. After the password check, every remaining branch is
reachable only by someone who already holds valid credentials, so it
discloses nothing they did not already know.

### 6. An unverified account is refused with a distinct `403`

`403 EMAIL_NOT_VERIFIED` — the one refusal that is *not* generic.

This is safe precisely because of §5: it is unreachable without a correct
password, so it is never an enumeration oracle. It is also the only
refusal with a self-service remedy — `POST /auth/resend-verification`
exists (ADR-008) and the caller cannot be expected to guess that it is what
they need. A generic `401` here would leave a user with correct credentials
in an unexplained loop, which is the failure mode ADR-007 §3 called a
priority to avoid.

A disabled account is deliberately treated differently and stays generic:
it has no self-service remedy, and confirming the state to whoever holds
the password tells an attacker the account is worth further attention.

### 7. Lockout counters move in exactly two narrow operations

`registerFailedLogin` increments and, on crossing
`LOGIN_MAX_FAILED_ATTEMPTS`, sets `lockedUntil` **and resets the counter to
zero** — in one atomic aggregation-pipeline update, the same technique
`rotateRefreshToken` uses. Two stages, so the second sees the incremented
value.

Resetting on lock is what makes the lock a genuine cooling-off period: if
the counter stayed at its maximum, the first failure after expiry would
re-lock immediately and a forgetful user would be permanently locked out by
a mechanism whose stated requirement is that it always auto-expires.

A locked account's attempts do **not** increment anything. Counting them
would let an attacker extend someone else's lockout indefinitely by
continuing to submit wrong passwords — turning a brute-force defence into a
denial-of-service tool aimed at a known address.

`clearLoginFailures` runs after the Session exists, not before. If session
creation fails, the failure counter is deliberately left standing.

Both methods are scoped exactly like `markEmailVerified` (ADR-009 §4): they
can touch the lockout fields and nothing else. `userRepository` still has no
general `update(id, patch)`.

### 8. Reading `passwordHash` requires a differently-named method

`passwordHash` is `select: false`, so `findByEmail` cannot return it.
`findByEmailWithPasswordHash` is the deliberately-named security-sensitive
read, matching `sessionRepository.findByIdWithRefreshTokenState` (ADR-004).
The ordinary path stays incapable of leaking the hash by accident, and the
call site announces what it is doing.

### 9. Session captures the User-Agent and not the IP

`normalizeUserAgent` was written and tested in Slice 6 for exactly this
field, truncating rather than rejecting so diagnostic metadata can never
fail a login.

`Session.ip` is left unpopulated. Filling it correctly requires deciding
Express's `trust proxy` setting, because `X-Forwarded-For` is
client-spoofable and a wrong setting silently records attacker-supplied
values. That is a deployment decision with no consumer until session/device
listing exists. The field is optional; the slice that lists devices is the
one that should own it.

### 10. `jose` is pinned to v5

ADR-002 §2 chose `jose` and this slice honours it. **Version 6 is
ESM-only**, and `apps/server` compiles to CommonJS and declares
`node >= 18`, where `require()` of an ESM module does not exist. It appears
to work on the current Node 22 only because of `require(esm)` support that
the project's own engine range does not guarantee.

v5 ships a real CommonJS build with an explicit `require` export condition.
This is a packaging constraint, not a change of library.

### 11. Token lifetimes are constants, not environment variables

`ACCESS_TOKEN_TTL_MS` and `SESSION_TTL_MS` live in `config/constants.ts`
under that file's stated rule: a misconfigured deployment must not be able
to weaken a security policy. `JWT_ACCESS_EXPIRY` and `JWT_REFRESH_EXPIRY`
are removed from `.env.example` — the latter was doubly wrong, since the
refresh token is not a JWT at all (ADR-004 §2).

`JWT_ACCESS_SECRET` stays in the environment because it is a secret and
genuinely varies per deployment. It is required with no default and a
minimum length, validated at boot like `MONGODB_URI` and `CLIENT_URL`
(ADR-007 §9), so a process signing tokens with a weak or absent key cannot
start. Its validation message never echoes the value.

### 12. Cookie attributes

`HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Max-Age` equal to the
session lifetime, and `Secure` outside development.

`Path` scoping keeps the refresh cookie off every non-auth API call, which
shrinks both its exposure and the CSRF surface, and — as ADR-010 §8
requires — makes it structurally impossible for the staff refresh cookie to
be sent to a future widget endpoint. It also fixes the refresh endpoint's
URL prefix, which is accepted deliberately.

`Secure` is off only when `NODE_ENV` is `development` or `test`, because a
`Secure` cookie cannot be set over plain-HTTP localhost. Those are the only
two non-production values the environment schema permits, and ADR-007 §13's
deployment gate already forbids exposing authentication endpoints outside
local development until rate limiting exists.

### 13. What this slice does not do

- **No token verification.** Nothing consumes an access token yet; the
  middleware belongs to the slice that first protects a route.
- **No rehash-on-login.** `needsRehash` exists and stays unused. Upgrading
  a hash is a second write on the login path with no trigger until the
  Argon2id parameters actually change.
- **No session cap.** Nothing limits concurrent sessions per user.
  `findActiveByUser` exists for the future listing slice.
- **No rate limiting.** ADR-007 §13's deployment gate now covers a fourth
  endpoint, and login makes it more urgent: it is the flow where guessing
  is the attack. Per-account lockout (§7) is a partial compensating control
  and is not a substitute.

## Consequences

- A revoked session's access token remains valid until it expires — at most
  15 minutes. Logout will therefore invalidate the refresh cookie
  immediately and the access token only by expiry. This is the standard
  stateless-token trade-off, recorded here so logout is not later mistaken
  for broken.
- The refresh token's `sessionId.secret` shape is now issued to real
  clients. ADR-004 named this a breaking change once tokens exist; that
  point has passed.
- The refresh endpoint's URL is constrained to the `/api/v1/auth` prefix by
  the cookie's `Path`.
- Rotating `JWT_ACCESS_SECRET` invalidates every live access token.
  Acceptable at a 15-minute lifetime; a second service needing to verify
  these tokens would force a move to asymmetric keys.
- `userRepository` now has three write methods, each narrow enough that
  none can serve as a general updater.
- Login is audit-relevant (`SECURITY.md` §9) and currently produces
  structured Pino events only. No `Audit` collection exists; when one does,
  these call sites are where it hooks in.
