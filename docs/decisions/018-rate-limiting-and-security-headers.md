# ADR-018: Rate Limiting and Security Headers

**Status:** Accepted
**Date:** 2026-08-17
**Phase:** 2 (Security gate slice)
**Closes:** [ADR-007](./007-registration-flow-and-account-enumeration.md) §13's deployment gate for single-node deployments; restates it for multi-node
**Related:** [ADR-011](./011-login-and-session-issuance.md) §7 (per-account lockout), [ADR-012](./012-refresh-token-rotation-endpoint.md) §3 (refusal opacity), [ADR-015](./015-access-token-verification-and-current-user.md) §6 (one refusal, one message), [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §2 (unbounded organization creation), [ADR-017](./017-organization-context-and-rbac.md) §11 (the gate covering ten endpoints), [ADR-010](./010-principal-types-organization-users-and-customers.md) §8–9 (the widget's cross-origin boundary)

## Context

ADR-007 §13 made authentication rate limiting a release blocker and said
why it was deferred:

> `express-rate-limit`'s default memory store is per-process, Serviqo goes
> multi-node at Phase 8, and building it now means building it twice.

Nine slices later that reasoning has aged badly in one direction and held
in the other. It held on storage: there is still no Redis, and Phase 8 is
still where multi-node arrives. It aged badly on urgency — the surface the
gate protects has grown from four endpoints to eleven, and now includes an
authenticated write that creates database documents in a loop (ADR-016 §2)
and two authorization-bearing reads (ADR-017 §11).

The premise that building it now means building it twice is also wrong in
its specifics. What would be built twice is the **store**. The policy — who
is limited, how often, keyed by what, refused how — is written once and is
the part that takes judgement. `express-rate-limit` separates those
already: a `Store` interface with an official Redis implementation. Writing
the policy now against a memory store is not a rewrite later; it is a
constructor argument.

Serviqo also ships no security headers at all today. Express advertises
itself via `X-Powered-By`, and nothing sets `nosniff`, a referrer policy, or
a frame policy.

## Decisions

### 1. Two dependencies, and no Redis

`helmet` and `express-rate-limit` are added. Both are small, widely
audited, and dependency-free themselves, which matters under SECURITY.md
§10's "minimal dependency surface area".

This codebase has twice declined a dependency and written the primitive
instead — ADR-012 §2 refused `cookie-parser` for `lib/http/cookies.ts`. That
precedent is deliberately **not** followed here, for a reason specific to
each package:

- A cookie parser is a string split. A rate limiter is a store with an
  eviction policy, a window algorithm, standards-track headers, and an IPv6
  key-normalisation problem — and a memory leak in the eviction path is the
  failure mode nobody notices until production.
- `express-rate-limit`'s `Store` interface is the thing that answers
  ADR-007 §13's objection. Hand-rolling the limiter would mean hand-rolling
  that seam too, and then discovering at Phase 8 whether it fits
  `rate-limit-redis`.

**Redis is not introduced.** Nothing in the current architecture requires
it: Serviqo runs as one process, and ADR-002 §7–19 records that Redis is
not part of Phase 2. Installing it now to serve one limiter would add an
operational dependency to a system that has none.

### 2. Storage is in-memory, and that bounds the deployment

The limiter uses `express-rate-limit`'s default `MemoryStore`. Counters live
in the process and are lost on restart.

**Single-node deployments are correctly limited.** Every request reaches
the one process holding the counters.

**Multi-node deployments are NOT correctly limited**, and this is the
residual gate. With N nodes behind a load balancer, an attacker gets N×
the intended budget, and a restart resets every counter. That is a real
weakening, not a rounding error.

The production boundary is therefore explicit:

| Deployment | Status |
|---|---|
| Local development, single process | Correct and released |
| Single-node staging or production | Correct; acceptable |
| Multi-node (Phase 8 onward) | **Blocked** until a shared store exists |

The seam is prepared rather than merely promised: every limiter is built by
one factory (`lib/rateLimit`), and each takes its store from one place. A
Redis-backed deployment changes that one argument and nothing about the
policy, the keys, the responses, or the tests.

### 3. Five classes, and why each limit is that number

Limits are derived from values the codebase already committed to, not
invented. Where a number is a judgement call, the judgement is stated.

| Class | Endpoints | Limit | Window | Keyed by |
|---|---|---|---|---|
| `credential` | `POST /auth/register`, `/auth/login`, `/auth/resend-verification`, `/auth/verify-email` | 10 | 15 min | IP |
| `session` | `POST /auth/refresh`, `/auth/logout`, `/auth/logout-all` | 60 | 15 min | IP |
| `authenticatedWrite` | `POST /organizations` | 30 | 60 min | user id |
| `authenticatedRead` | `GET /auth/me`, `GET /organizations/:organizationId` | 300 | 15 min | user id |
| `global` | everything under `/api/v1` | 1000 | 15 min | IP |

**`credential` — 10 per 15 minutes.** Taken directly from
`LOGIN_MAX_FAILED_ATTEMPTS` (10) and `LOGIN_LOCK_DURATION_MS` (15 minutes)
in `config/constants.ts`. Those already encode the approved answer to "how
many credential attempts is too many, and for how long"; choosing different
numbers would mean the IP limit and the per-account lockout (ADR-011 §7)
disagreed about the same policy. It also bounds the concrete DoS ADR-007
§13 named: `POST /register` spends ~19 MiB and ~100 ms of Argon2id per call
on an unauthenticated path, so ten calls per quarter-hour per IP caps that
at a level no honest client approaches.

**`session` — 60 per 15 minutes.** A legitimate tab refreshes about once
per `ACCESS_TOKEN_TTL_MS` (15 minutes), plus once per page load. Sixty
allows heavy reloading across several tabs and still bounds a loop. Refresh
secrets are 256 bits (`REFRESH_SECRET_BYTES`), so this is not a
guessing defence — guessing is already infeasible — it is a volume bound on
an endpoint that performs a database write per call.

**`authenticatedWrite` — 30 per hour.** ADR-016 §2 recorded the vector
exactly: "an authenticated user can create organizations in a loop. That is
a rate-limiting concern, and rate limiting is the next slice." Thirty
tenants in an hour is already far past anything a person does; the number
is chosen to be obviously generous for humans and obviously insufficient
for a script.

**`authenticatedRead` — 300 per 15 minutes.** A dashboard mount costs two
calls (`/me`, then one organization context). Three hundred allows roughly
150 page loads per quarter-hour per user. This class exists to catch a
runaway client or a scraper, not an attacker — reads are cheap and already
authorized.

**`global` — 1000 per 15 minutes.** A blunt volume bound covering what the
specific classes cannot: requests that are refused before any class
applies. Hammering `GET /auth/me` with no token produces a 401 from
`requireAccessToken` and never reaches the user-keyed read limiter, so
without this it would be unlimited. Set high enough that it never fires
before a specific class does for honest traffic.

Windows are fixed rather than sliding. `express-rate-limit`'s fixed window
is the simpler algorithm, and its known weakness — up to 2× the limit
across a window boundary — is immaterial at these numbers.

### 4. Authenticated classes are keyed by user, not by IP

`authenticatedWrite` and `authenticatedRead` key on `req.principal.userId`,
which exists because they mount **after** `requireAccessToken`.

Two reasons. An office behind one NAT would otherwise share a single
budget, making a shared limit a shared outage. And the abuser ADR-016 §2
described is authenticated — rotating IP addresses is trivial and rotating
verified accounts is not, so the account is the honest key.

Unauthenticated classes key on IP because there is no identity yet. They
use the library's IPv6-aware key generator rather than raw `req.ip`, so a
single client cannot get a fresh budget per address inside its own /64.

### 5. Credential limits are NEVER keyed by email

Keying the credential class by submitted email address would be the
obvious way to protect a specific account — and it would build precisely
the oracle four ADRs have refused to build.

If the counter were per-email, the response to the eleventh attempt would
depend on which address was submitted, which is an observable difference
between "an address someone is attacking" and "an address nobody has
touched". Worse, it would hand an attacker a denial-of-service tool aimed
at a known account, which is the exact failure ADR-011 §7 avoided by not
counting attempts against a locked account.

The counter is per-IP and the response is identical regardless of the body.
A 429 says "you have made too many requests", never "this account is under
attack" and never "this account exists".

### 6. Refusals use the existing envelope and say nothing new

`TooManyRequestsError` (429, `TOO_MANY_REQUESTS`) joins `lib/errors` and
travels through `errorHandler` like every other `AppError`, so a rate-limit
refusal is the same envelope shape as a validation failure or a 401.

One message for every class. The message names no limit, no window, no
route class, and no remaining budget — those are facts about Serviqo's
defences rather than about the caller, and the same reasoning kept the
required permission out of ADR-017 §6's 403.

`RateLimit` and `Retry-After` headers (IETF draft-7) **are** sent. They are
standard, they let an honest client back off instead of hammering, and the
window length is not a secret — an attacker learns it by waiting. Legacy
`X-RateLimit-*` headers are disabled; two spellings of the same fact is one
too many.

### 7. `trust proxy` stays off, and that is the safe default

Express's `trust proxy` remains `false`. `req.ip` is the socket address and
`X-Forwarded-For` is ignored entirely.

This is the only setting under which the current deployment is correct.
Enabling it would make the limiter key a client-controlled header — one
line in a request and every limit is bypassed with a fresh identity per
call. Leaving it off means a forged `X-Forwarded-For` changes nothing,
which is exactly what the current configuration must guarantee.

The cost, stated plainly: **behind a reverse proxy this configuration is
wrong in the other direction.** Every request would appear to come from the
proxy, all clients would share one bucket, and the limiter would become a
self-inflicted outage.

Deploying behind a proxy therefore requires, as one step:

1. Set `trust proxy` to the specific number of trusted hops, or to the
   proxy's address — never `true`, which trusts the whole chain.
2. Verify `req.ip` reports the real client address.

That is added to the deployment gate rather than solved with configuration
here, because no proxy deployment exists to configure against, and an
untested `TRUST_PROXY` environment variable is a security control nobody
has ever exercised.

### 8. Rate limiting is off in the test environment by default

`createApp` takes `rateLimiting`, defaulting to `env.NODE_ENV !== "test"`.

Without this, existing suites would fail for reasons unrelated to what they
assert — the lockout test in `auth.login.test.ts` deliberately makes eleven
failed logins, which is the credential limit by construction. Rewriting
those suites to accommodate a limiter would obscure what they were written
to prove.

The limiter is not thereby untested: the security suites pass
`rateLimiting: true` explicitly and exercise the real middleware, the real
store, and the real refusal path. What is disabled by default is disabled
only where it would be noise.

### 9. Security headers: what is set, and what is deliberately not

`helmet` is mounted with a configuration chosen for what this process
actually serves — a JSON API, and nothing else. `apps/web` is served by
Vite in development and would be a static host in production; no HTML
leaves this server.

| Header | Setting | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | A JSON response should load nothing and frame nothing. The default helmet policy is written for documents and would be wrong here in both directions. |
| `X-Content-Type-Options` | `nosniff` | Stops a browser reinterpreting a JSON error body as HTML. |
| `Referrer-Policy` | `no-referrer` | API URLs carry organization ids (ADR-017 §1); none of that belongs in a `Referer` sent elsewhere. |
| `X-Frame-Options` | `DENY` | Redundant with `frame-ancestors` for modern browsers, retained for old ones. |
| `Strict-Transport-Security` | production only | Meaningless over the HTTP that development uses, and a stray HSTS pin on `localhost` outlives the experiment that set it. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Correct while every caller is same-origin. |
| `X-Powered-By` | removed | Free version disclosure, currently sent. |

**Deferred to the widget slice, deliberately (ADR-010 §9):**

- **CORS.** Not installed, not configured. Every caller is same-origin
  today (`vite.config.ts` proxies `/api`), and ADR-010 §9 already fixed
  that the widget slice is where this stops being acceptable — with a
  per-tenant allowed-origin list, not a blanket policy.
- **`frame-ancestors` for the widget document.** The policy above applies
  to **API responses**. The widget's HTML document is a different resource
  that does not exist yet, and it must be framed by tenant sites to work at
  all. When it ships it needs its own headers — served from its own origin,
  or from a route that overrides this policy. **Nothing here forecloses
  that**, and it is called out because a blanket `frame-ancestors 'none'`
  applied to the whole application later would silently make the widget
  architecture impossible.
- **`Cross-Origin-Resource-Policy` on widget endpoints.** `same-origin`
  suits an API whose only client is same-origin; `/api/v1/widget/*` will
  need `cross-origin` and the CORS layer beside it.

### 10. Logging

Rate-limit events are logged at the same structured standard as every other
security event (`authLogging.ts`): an event name, the route class, and the
request id that `requestContext` already binds.

Deliberately **not** logged: the request body in any form, the
`Authorization` header, cookies, tokens or token hashes, and the email
address a credential request carried. The client key is not logged either —
for the user-keyed classes it is a user id, which is safe and useful, but
for the IP-keyed classes it is an IP address, and logging one on every
refusal turns the limiter into an access log nobody asked for. The route
class plus the request id is enough to answer "what is being limited, and
how often" during triage.

### 11. What this slice does not do

- **No Redis, and no shared store** (§2). The multi-node gate stands.
- **No CORS** (§9), which the widget slice owns.
- **No `trust proxy` configuration** (§7), which the first proxied
  deployment owns.
- **No per-account or per-organization quotas.** Business limits — how many
  organizations a plan allows — are a product decision, not a security one.
- **No CAPTCHA, no proof-of-work, no IP reputation.** These belong to a
  slice that has evidence of abuse to tune against.
- **No `Customer`, widget, conversation, or Socket.IO work.**

## Consequences

- ADR-007 §13's gate is **released for single-node deployments** and
  **restated for multi-node**. SECURITY.md §3 is updated to say which is
  which, because that is the document read before deploying.
- Serviqo has security headers for the first time. The API stops
  advertising Express.
- Every limit is derived from an existing constant or an explicitly stated
  judgement (§3), so the next person to change one can see what it was
  balanced against.
- Two dependencies enter a deliberately small tree (§1).
- Behind a proxy, this configuration limits every client as one (§7). That
  is a documented deployment prerequisite rather than a defect, and it fails
  toward refusing traffic rather than toward allowing bypass.
- Tests run without limits by default (§8), so a future suite that wants to
  assert limiter behaviour must opt in — which is also what stops one from
  depending on it accidentally.
- The credential limit and the account lockout now share their numbers
  (§3). Changing `LOGIN_MAX_FAILED_ATTEMPTS` without revisiting the limiter
  would put them back into disagreement; they are cross-referenced in both
  files.
