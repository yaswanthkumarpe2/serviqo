# ADR-009: Email Verification Consumption

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 2 (Slice 11 — closes the loop opened by ADR-007 and ADR-008)
**Related:** [ADR-003](./003-domain-first-server-modules.md) (module layout), [ADR-005](./005-account-action-token-lifecycle.md) (account token lifecycle), [ADR-007](./007-registration-flow-and-account-enumeration.md) (registration), [ADR-008](./008-resend-verification-and-silent-responses.md) (resend)

## Context

Registration issues a verification token and resend replaces it. Neither
has anything to redeem it against: `emailVerifiedAt` has been `null` for
every user since the `User` model was written, because no code path could
set it.

`POST /api/v1/auth/verify-email` is that path. It is the first endpoint in
Serviqo that mutates an existing `User`.

Scope is consumption only. No session, no JWT, no cookie, no login — a
verified address is a fact about an account, not an authentication event.

## Decisions

### 1. One failure code for every bad token

Invalid, expired, already consumed, well-formed-but-fabricated, and
belonging-to-a-deleted-user all answer the identical
`400 INVALID_VERIFICATION_TOKEN` with the identical message.

The reason is never disclosed. "Expired" would confirm the token was once
real, which confirms an account exists for whoever holds it. "Already
consumed" would confirm the address was verified. Distinguishing them
turns a link into an account-existence probe for anyone who has ever seen
one.

There is deliberately no `expiredAt`, no `reason`, and no `details` array
on this response.

### 2. Consumption is the atomic authority; nothing re-checks it

The service calls `consumeValidByHashAndPurpose` exactly once and branches
on whether it returned a document. It never reads a token first, never
inspects `expiresAt` in application code, and never checks `consumedAt`
itself.

ADR-005 §4 already established why: of N concurrent callers presenting the
same token, exactly one matches `consumedAt: null` and flips it inside a
single-document update. Any `find → inspect → update` in this service
would reintroduce precisely the race that predicate exists to eliminate.

`purpose: "email_verification"` is part of that predicate, so a
password-reset token can never be redeemed here — ADR-005 §3's rule that
purpose belongs in the predicate rather than in a caller's afterthought.

### 3. `emailVerifiedAt` is set once, atomically

```js
findOneAndUpdate(
  { _id: userId, emailVerifiedAt: null },
  { $set: { emailVerifiedAt: verifiedAt } },
)
```

The `emailVerifiedAt: null` predicate is what makes the write set-once. A
second concurrent request — which can only exist if two valid tokens were
outstanding, the bounded state ADR-008 §3 tolerates — matches nothing and
changes nothing. The first verification timestamp is therefore the one that
survives, and no request can move it.

The preceding `findById` exists to satisfy the missing-user branch, not to
guard the update. Read-then-write would be a race; the predicate is the
authority.

This also makes the update structurally incapable of *un*-verifying an
account, which a plain `$set` on `_id` alone would allow.

### 4. This slice necessarily extends `user.repository.ts`

`userRepository` exposed `create`, `findById`, and `findByEmail`. Setting
`emailVerifiedAt` requires a write, and ADR-003 makes the repository the
only module permitted to touch Mongoose. There is no way to implement this
slice without adding a method.

`markEmailVerified(id, verifiedAt)` is deliberately narrow rather than a
general `update(id, patch)`:

- it can set exactly one field,
- its predicate makes it a no-op on an already-verified account,
- it has no capacity to modify `email`, `passwordHash`, `status`, or the
  lockout fields, all of which are reachable from a generic updater.

A general update method on an unauthenticated code path is the thing being
avoided. The `User` **model** is untouched.

### 5. An already-verified account answers 204, and the token is still spent

If the token was valid but the account is already verified, the response is
`204` — the same as a successful verification. The caller clicked a real
link and the address is verified; that the work happened a moment earlier
is not something the response should distinguish.

The token is **not** refunded. It was consumed by the atomic step before
the account state was known, and un-consuming it would require exactly the
read-modify-write this design forbids. A spent token on an
already-verified account costs nothing — the account needs no further
verification.

### 6. "Delete every outstanding token" means every *unused* token

Successful verification calls `invalidateOutstandingForUser`, which
deletes tokens with `consumedAt: null`. The token just redeemed has
`consumedAt` set and therefore survives.

That is deliberate, and it is ADR-005 §6's rule: consumed tokens are never
deleted by invalidation, because their continued existence is what keeps
"this link was already used" distinguishable from "this link never
existed" for an audit or support investigation. TTL bounds the retention.

So after verification a user holds **zero usable verification tokens and
one spent one**. Nothing is observable at the API level either way, since
§1 collapses every failure into one response.

Cleanup runs on the already-verified branch too: a second outstanding
token from the ADR-008 §3 window should not survive a completed
verification.

### 7. Verification is not authentication

No `Session` is created, no access or refresh token is issued, no cookie
is set. Verifying an address proves control of an inbox; it does not
present a credential, and conflating the two would let a forwarded link
become a login.

The user logs in afterwards, through the login slice, with their password.

## Consequences

- A verification link is single-use in the strict sense: clicking it twice
  gives `204` then `400`, and the second response is indistinguishable
  from one produced by a fabricated token.
- `userRepository` gains its first write method, scoped so tightly that it
  cannot serve as a general-purpose updater.
- The response carries no body in either success case, so no field exists
  through which account state could later leak by accident.
- A user whose account was deleted between issuance and redemption gets the
  same `400` as everyone else, and the token is spent in the process.
