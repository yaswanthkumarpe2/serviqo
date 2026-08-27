# ADR-008: Resend Verification and Silent Responses

**Status:** Accepted
**Date:** 2026-08-06
**Phase:** 2 (Slice 10 — the recovery path ADR-007 §3 called for)
**Related:** [ADR-005](./005-account-action-token-lifecycle.md) (account token lifecycle), [ADR-007](./007-registration-flow-and-account-enumeration.md) (registration, enumeration policy)

## Context

ADR-007 §3 and §4 both end in the same place: a user whose verification
token failed to write, or whose verification email failed to send, owns an
account they cannot verify and has no remedy. ADR-007 recorded that the
resend slice was therefore elevated in priority. This is that slice.

`POST /api/v1/auth/resend-verification` supersedes a user's outstanding
email-verification token with a fresh one and re-sends the link.

Scope is resend only. Verification *consumption* — the endpoint that
actually sets `emailVerifiedAt` — is a separate slice and is not designed
here.

## Decisions

### 1. Every outcome answers `204 No Content`

Unknown address, already-verified account, successful resend, failed token
write, failed delivery — all five answer an identical, bodiless `204`.

The endpoint's contract is deliberately "your request was accepted and I
will tell you nothing further." A caller cannot distinguish:

- whether an account exists for that address,
- whether that account is already verified,
- whether an email was actually sent.

**This is a genuine exception to ADR-002 §5's response envelope.** Every
endpoint that returns a body uses the envelope; this one returns no body at
all, because a body is precisely the channel through which the above state
would leak. Correlation is not lost — `requestContext` still sets
`X-Request-Id` and `X-Correlation-Id` on the response, so a support request
can still be traced to a log line without the body carrying anything.

### 2. Enumeration resistance here is defence in depth, not a guarantee

Two limits, recorded so nobody over-claims this endpoint:

**`POST /register` already discloses existence.** ADR-007 §1 answers a
specific `409 EMAIL_ALREADY_EXISTS`, deliberately. An attacker who can
reach both endpoints learns from `/register` exactly what this one refuses
to say. Resend is silent because silence costs nothing here — not because
it closes enumeration system-wide.

**Response timing still separates the branches.** An unknown address
returns after a single indexed lookup. An unverified account performs a
delete, an insert, and a provider call first. That difference is
measurable. Equalizing it would mean padding to a fixed budget or moving
the work off-request, both of which are out of scope and neither of which
is worth building before the rate limiting that actually bounds an
attacker's sampling rate.

The honest summary: this endpoint does not *add* an enumeration oracle, and
it is written so that it never becomes one if `/register` later goes
generic.

### 3. Supersede first, then mint — and accept ADR-005's concurrency caveat

The order is `invalidateOutstandingForUser` → `create`, reusing the
existing repository methods unchanged. No new persistence surface, no
change to `accountToken.repository.ts`.

ADR-005's "Concurrent issuance" note applies verbatim: those are two
separate operations, so two simultaneous resends can interleave and leave
**two** simultaneously valid tokens. That remains bounded and
non-exploitable — every link goes to the same inbox, and every one of them
was requested by whoever controls it — but **strict newest-token-wins is
not guaranteed by persistence alone**, and the tests assert the bound
rather than pretending otherwise.

Two alternatives were considered and rejected:

- **Mint first, then delete the others.** Under concurrency each request
  deletes the other's fresh token, and the user can be left with *zero*
  valid tokens. Strictly worse than a transient duplicate.
- **A transaction.** Requires a replica set. ADR-005 already names password
  reset and organization onboarding as the flows that will force that
  conversion; a resend that occasionally issues two links to one inbox does
  not justify pulling it forward.

Sequentially — the overwhelmingly common case, and what the smoke test
exercises — exactly one active token remains.

### 4. Superseded tokens are deleted; consumed tokens survive

`invalidateOutstandingForUser` filters on `consumedAt: null`, so a token
the user actually used is never removed by a later resend. That is ADR-005
§6's rule and this slice depends on it: it is what keeps "this link was
already used" distinguishable from "this link never existed" once the
consumption endpoint exists.

Invalidation is also scoped to `{userId, purpose}`, so a resend never
disturbs another user's tokens or the same user's future password-reset
tokens.

### 5. A failed token write still answers 204

If the invalidate or the create fails, the failure is logged internally and
the request still answers `204`.

Returning `500` was rejected: a `500` is reachable **only** for an existing,
unverified account, since every other branch returns early. It would
therefore be a precise account-existence oracle — reintroducing, through an
error status, exactly what §1 removed from the body.

**Consequence, recorded deliberately:** because invalidation runs first, a
create failure can leave the user with *zero* valid tokens — worse than
before they asked. This is self-recovering in a way ADR-007 §3's failure is
not: resend is idempotent and is its own retry, so the user simply asks
again. No other flow depends on a token existing.

### 6. Delivery failure is not a failure of the request

Identical to ADR-007 §4, and for the same reason: persistence is complete
and correct, the token is valid for its full lifetime, and the response
already promises nothing about delivery.

### 7. Token minting and link building are shared, not duplicated

`issueVerificationToken` and `buildVerificationUrl` move to
`modules/auth/emailVerification.ts`, and registration is refactored to use
them.

This is the one refactor this slice makes, and it is security-motivated
rather than cosmetic. Both flows must mint with the same TTL, persist only
a SHA-256 hash, and place the secret in the link's **query string** — the
last of these is load-bearing, because `lib/email/redaction.ts` matches the
exact pathname `/verify-email` and a path-segment variant would defeat log
redaction. Two copies of that rule is two chances for one to drift.

The `AuthLogger` structural type and the `failureType` helper move with
them, for the same reason: "log the error's class, never its message" is a
rule that should exist once.

### 8. Rate limiting remains a deployment blocker

Nothing changes about SECURITY.md §3 / ADR-007 §13, and this endpoint makes
it more urgent, not less: it sends an email per accepted request, so
without a limit it is an unauthenticated mail-sending amplifier aimed at
any address an attacker names.

Its per-address budget must be tighter than registration's, and it must be
limited by target address as well as by client, since one attacker can
target many addresses and many clients can target one address.

## Consequences

- Callers get no feedback whatsoever from this endpoint. A frontend must
  say something like "if that address needs verifying, a link is on its
  way" — it genuinely cannot say more.
- A concurrent double-request can leave two valid links in one inbox until
  the older expires. Accepted; documented in ADR-005 before this slice
  existed.
- A failed write can leave a user with no valid token, remedied by asking
  again.
- Registration and resend now share one token-minting path, so a change to
  TTL, hashing, or link shape necessarily applies to both.
