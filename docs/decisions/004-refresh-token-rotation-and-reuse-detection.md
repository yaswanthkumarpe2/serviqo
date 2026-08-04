# ADR-004: Refresh Token Rotation and Reuse Detection

**Status:** Accepted
**Date:** 2026-08-04
**Phase:** 2 (Session persistence slice — precedes any authentication code)
**Refines:** [ADR-002](./002-phase-2-authentication-architecture.md) §3 (token/session strategy)

## Context

ADR-002 established opaque, database-backed refresh tokens with rotation
and reuse detection. The informal design sketched alongside it modelled a
Session as holding a single `refreshTokenHash`, replaced on every
rotation.

That overwrite-only representation cannot support reuse detection. If
token A rotates to token B and the stored hash is simply overwritten,
then a later presentation of token A produces "no match" — indistinguishable
from a completely fabricated random token. The system cannot tell
**replay of a previously valid token** (a strong signal of theft,
requiring every session for that user to be revoked) from **noise** (an
invalid token, requiring only a 401). Reuse detection therefore requires
retaining enough lineage to recognise previously rotated tokens.

## Decisions

### 1. A Session is stable; the token rotates

One Session document represents one login on one device, and its `_id`
is stable for that session's whole life. Rotation changes which token
the session accepts — it does not create a new Session. Session listing,
revocation, and "log out this device" therefore all address a durable
identifier.

### 2. Refresh tokens are opaque, structured `sessionId.secret`

The future refresh token is **not** a JWT. It carries a non-secret
routing component and a secret component:

```
<sessionId>.<secret>
```

- `sessionId` — the Session's `_id`; not secret, used only to load one
  document.
- `secret` — a high-entropy cryptographically random value; the actual
  credential.

Only `hash(secret)` is persisted; the raw secret is never stored, logged,
or serialized.

This structure is what keeps validation O(1): the refresh flow parses
`sessionId`, loads that one Session, hashes the presented secret, and
compares. There is no global scan over sessions and no need to index or
search by token hash — a design that would not scale and would require
indexing sensitive material.

### 3. Hash algorithm: SHA-256, not Argon2

Refresh secrets are high-entropy random values, not human-chosen
passwords. They are not brute-forceable by guessing, so the memory-hard
cost of Argon2id (correct for `User.passwordHash`) buys nothing here and
would add latency to every refresh. A deterministic digest is also
required, since lookup compares hashes directly.

Argon2id remains the decision for user passwords (ADR-002 §1). The two
choices are deliberately different because the threat models differ.

### 4. Bounded previous-hash history

A Session stores:

- `currentRefreshTokenHash` — the hash the session currently accepts.
- `previousRefreshTokenHashes` — a bounded list of hashes of previously
  rotated secrets, **maximum 5**, oldest discarded first.

This yields a three-way outcome for any presented refresh token:

| Presented secret hashes to | Meaning | Future auth-service response |
|---|---|---|
| `currentRefreshTokenHash` | Valid current token | Rotate, issue new tokens |
| an entry in `previousRefreshTokenHashes` | **Replay of a rotated token** | Suspected theft — revoke every Session for that user, clear cookies, force re-login, emit a security/audit event |
| neither | Unknown/fabricated token | Reject (401) |

Five is sufficient because rotation is infrequent relative to a refresh
token's lifetime, and detection only needs to cover the window in which
a stolen token would realistically be replayed. The bound exists so a
long-lived session cannot grow without limit.

**Ownership of the bound**: the `rotateRefreshToken` repository operation
enforces it in a single atomic aggregation-pipeline update, so no caller
can violate the invariant or race another rotation. It is not left to
the future auth service to remember.

### 5. This is not a revocation ledger

Bounded history provides practical replay detection, not a permanent
audit trail of every token ever issued. If Serviqo later needs
high-scale token-family tracking (full lineage, ancestor invalidation),
a dedicated `RefreshToken`/`TokenFamily` collection replaces this design;
the Session model's stable identity means that migration would not
disturb session listing or revocation. That model is explicitly **not**
built now.

### 6. TTL is cleanup, not a security control

`expiresAt` carries a TTL index (`expireAfterSeconds: 0`). MongoDB's TTL
monitor runs periodically (roughly every 60s), so **an expired Session
may physically remain in the collection after `expiresAt` has passed.**

Authentication logic must therefore never treat "document exists" as
"session valid". Validity is always evaluated logically:

```
expiresAt > now  AND  revokedAt == null
```

TTL exists to stop the collection growing without bound — nothing more.

### 7. Revocation is a timestamp

`revokedAt: Date | null` rather than an `isRevoked` boolean: it records
both *whether* and *when*, which a security review or audit trail needs.
A separate `status` enum (active/expired/revoked) is deliberately not
stored — that state is derivable from `revokedAt` and `expiresAt`, and
duplicating it invites the two representations to drift.

### 8. Sessions carry no organization context

Session has no `organizationId`, `activeOrganizationId`, `membershipId`,
`role`, or `permissions`. A Session authenticates the **global User
identity**; organization access is resolved per request through
Membership (ADR-002 §3, ADR-003).

This is what allows a user who belongs to several organizations to switch
between them without re-authenticating, and it keeps a single source of
authorization truth: changing someone's role takes effect immediately
rather than waiting for their session to expire.

## Consequences

- Session documents are slightly larger (up to five extra hash strings)
  in exchange for a security capability that is otherwise impossible.
- The refresh flow depends on the token's `sessionId.secret` structure;
  changing that format later is a breaking change for issued tokens.
- Token hashes are `select: false` and additionally stripped in
  `toJSON`/`toObject`, so retrieving them requires a deliberately named
  security-sensitive repository method — accidental exposure through an
  ordinary query or API response is structurally prevented, not left to
  reviewer vigilance.
