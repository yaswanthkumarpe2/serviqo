# ADR-005: Account Action Token Lifecycle

**Status:** Accepted
**Date:** 2026-08-05
**Phase:** 2 (AccountToken persistence slice — precedes registration, verification, and password-reset flows)
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) (authentication architecture), [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) (session refresh tokens)

## Context

Email verification and password reset both need a short-lived, single-use
credential delivered by email. `SECURITY.md` §7 already commits to these
tokens being "cryptographically secure, single-use, and expire quickly";
this ADR records how that is actually enforced in persistence.

These credentials are **not** session refresh tokens. ADR-004 scopes
`Session` to login/refresh state, where the token is *rotated* and a stable
session identifier routes the lookup. An account action token is
categorically different: it is issued once, used at most once, and the only
thing the recipient presents is the secret itself. Conflating the two would
force one model to serve two incompatible lifecycles.

## Decisions

### 1. Raw secret → SHA-256 → persisted hash

```
rawSecret = generateSecret()      // 32 bytes, base64url
tokenHash = sha256(rawSecret)     // lowercase hex
```

Only `tokenHash` is stored. The raw secret exists **only** transiently in
memory, in the outgoing email URL, and in the incoming HTTP request. It
must never reach MongoDB, logs, error messages, or response bodies.

The primitives in `lib/crypto/tokens.ts` are reused unchanged — no second
generator, no second hashing implementation. SHA-256 rather than Argon2id
for the same reason as ADR-004 §3: these are high-entropy random values,
not guessable human input, so a memory-hard KDF buys nothing and lookup
must be deterministic.

### 2. Exactly two purposes

`purpose: "email_verification" | "password_reset"`

Invitations, magic-login, MFA codes, OAuth state, and API keys are
explicitly out of scope. Membership invitations in particular are a
separate future flow with organization context that this model does not
carry.

### 3. Purpose is part of validation, not metadata

A password-reset token must never be usable as an email-verification
token. `purpose` is therefore in the consumption **predicate**, not
checked afterwards by the caller. The repository deliberately exposes no
`consumeByHash(hash)`-style method through which a caller could forget it.

### 4. Atomic single-use consumption

```js
findOneAndUpdate(
  { tokenHash, purpose, consumedAt: null, expiresAt: { $gt: now } },
  { $set: { consumedAt: now } },
  { returnDocument: "after" },
)
```

MongoDB's single-document atomicity means that of N concurrent callers
presenting the same valid token, exactly one matches `consumedAt: null`
and flips it; every other caller's predicate no longer matches and returns
`null`. There is no `find → inspect → save` sequence anywhere, because
that pattern reintroduces the check-then-act race this design exists to
eliminate.

### 5. TTL is cleanup, never authorization

`expiresAt` carries a TTL index (`expireAfterSeconds: 0`), but MongoDB's
TTL monitor runs periodically, so **an expired document routinely still
exists**. Validity is therefore always evaluated logically via
`expiresAt: { $gt: now }` in the predicate. "The document exists" never
means "the token is valid" — the same rule ADR-004 §6 established for
sessions.

### 6. `consumedAt` means one thing, and superseded tokens are deleted

`consumedAt` records that *the recipient used the link and it worked*.

When a newer token supersedes older unused ones for the same user and
purpose, those are **deleted**, not marked consumed. Overloading
`consumedAt` would make it impossible to distinguish a completed password
reset from an abandoned duplicate request — exactly the question an audit
or support investigation asks.

A separate `revokedAt` / `invalidatedAt` field was considered and
rejected: a superseded token was never used, and its continued existence
carries no security or audit value that the replacement token plus a
future domain event does not already provide. Adding a fourth state field
with no consumer is the speculative-field trap.

Consumed tokens are **never** deleted by invalidation. They remain until
their original expiry so that presenting an already-consumed token is
distinguishable from presenting a fabricated one — the same replay-
detection philosophy as ADR-004 §4. TTL bounds the retention.

### 7. Indexes

| Index | Purpose |
|---|---|
| `{ tokenHash: 1 }` **unique** | Consumption lookup; guarantees one document per hash and hard-stops a duplicate insert |
| `{ userId: 1, purpose: 1 }` | Backs invalidation and user-scoped queries; its `userId` prefix makes a standalone `{userId: 1}` index redundant |
| `{ expiresAt: 1 }` TTL `expireAfterSeconds: 0` | Storage cleanup only |

**Why AccountToken indexes its hash while Session does not.** Session
routes by `sessionId` carried in the token's non-secret component, so
indexing the refresh hash would add an index over sensitive material for
no benefit. An account action token has no such routing component — the
email link carries only the secret — so the hash *is* the lookup key. The
apparent inconsistency is deliberate and correct; the two models should
not be "harmonized".

**No dynamic "one active token" partial index.** A partial unique index on
`{userId, purpose}` filtered to `consumedAt: null` cannot also express
`expiresAt > now`, since `partialFilterExpression` has no dynamic date
comparison. Such an index would block a legitimate re-request whenever an
expired-but-not-yet-swept token still existed. That invariant belongs at
the service layer, not in an index.

### 8. Serialization

`tokenHash` is `select: false`, and `toJSON`/`toObject` strip it (and
`__v`) even if some future query explicitly selects it. The repository
intentionally exposes **no** method whose purpose is to return
`tokenHash`, and none is needed: consumption matches *by* the hash inside
the database rather than reading it back. This is strictly stronger than
Session, which does require a security-sensitive read path.

## Future considerations (explicitly not solved here)

### Concurrent issuance of reset tokens

`invalidateOutstandingForUser` plus `create` are separate operations, so
two simultaneous forgot-password requests can interleave and leave two
simultaneously valid reset tokens. This is bounded and non-exploitable —
both links go to the same inbox, and both were requested by whoever
controls it — but it means **strict newest-token-wins is not guaranteed by
persistence alone**. If that guarantee is required, the future
forgot-password service must wrap invalidate+create in a transaction or
serialize per user. That remains a business-flow decision.

### Email-verification transaction boundary

`consume token` → `set User.emailVerifiedAt` spans two collections. A
failure between them burns the token without verifying the address.
Recoverable by resending, so tolerable without a transaction, though a
transaction is cleaner.

### Password-reset transaction boundary

`consume token` → `update User.passwordHash` → `revoke all Sessions` spans
three. The dangerous ordering is password-then-revoke: if revocation
fails, the password has changed but an attacker's existing session
survives, defeating the purpose of the reset. Either wrap all three in a
transaction (preferred), or order as consume → revoke → update so a
mid-failure leaves the user logged out with an unchanged password.

### Replica-set requirement

Multi-document transactions require a replica set; the development
MongoDB is currently standalone. This persistence slice needs no
transactions — every primitive is single-document atomic. The conversion
becomes blocking before the first business flow that must mutate two
collections atomically: password reset (security-relevant failure mode)
and organization onboarding (an ownerless organization is unrecoverable
and violates an approved invariant).

## Consequences

- Account action tokens and session refresh tokens stay in separate models
  with separate lifecycles, at the cost of two token concepts to reason
  about.
- Consumed tokens linger until expiry rather than being deleted, trading a
  small amount of storage for replay detection.
- Every consumption is one indexed, atomic database round trip.
