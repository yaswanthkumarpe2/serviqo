# ADR-014: Logout All Devices

**Status:** Accepted
**Date:** 2026-08-13
**Phase:** 2 (Logout-all slice)
**Refines:** [ADR-013](./013-logout-and-session-revocation.md) (single-session logout, whose contract this inherits)

## Context

ADR-013 ended one session and deliberately left `revokeAllForUser`
reserved — at that point its only caller was reuse detection, and §9 recorded
"log out all devices" as a different feature with a different endpoint.

This is that endpoint. `POST /api/v1/auth/logout-all` is what someone reaches
for after losing a laptop or seeing a session they do not recognise, and it is
the first place a user can deliberately trigger the revoke-everything response
that until now only theft detection could cause.

## Decisions

### 1. The contract is ADR-013's, unchanged

Always `200`, always the success envelope, always clears the cookie, on every
path — absent cookie, malformed token, unknown session, expired session,
already-revoked session, wrong secret, and a genuine mass revocation are
indistinguishable to the caller.

ADR-013 §1 argued this from what the request means: "sign me out everywhere"
asks for a state, and a state that already holds is not a failure. That is
where idempotency comes from, and it is why a repeated call is not an error.
The reasoning is not restated here because it has not changed; two endpoints
answering the same question differently is what this inherits away from.

### 2. The body stays constant, and must not carry a count

`data` is `{}`. It is tempting to return how many sessions were revoked —
it is genuinely useful feedback — and it is exactly the field that must not
exist.

A count is a fact about the account: how many devices this person uses, and
whether anything besides the current browser was signed in. ADR-013 §2 allowed
the envelope precisely because the body is a constant that says the same thing
to everyone; a count would make it vary with internal state, which is what
ADR-008 §1 forbade. The number is logged, where it is for operators.

### 3. The secret is required here more than anywhere else

Logout-all revokes on the same evidence logout does: the presented secret must
match the session's `currentRefreshTokenHash`, compared in constant time. A
rotated hash revokes nothing (ADR-013 §4).

ADR-013 §5 refused to let reuse detection fire from logout, on the grounds
that a revoke-everything response must not be reachable from an endpoint that
grants nothing. This endpoint *is* revoke-everything by design, which makes
the same rule load-bearing rather than incidental: the session id inside the
token is not secret, so accepting it alone would hand anyone who can guess an
ObjectId the ability to sign a stranger out of every device they own.

Requiring the current secret means the authority to end every session is
exactly the authority to use one — no more.

### 4. No reuse detection, for the reason that has not changed

Presenting a rotated token is answered as "revoked nothing" and logged. It
does not trigger ADR-004 §4's response.

That would be circular here: the detection's punishment is mass revocation,
and mass revocation is what this endpoint already does. Wiring them together
would mean a wrong secret accomplishes what a right one does, which is the
whole hole §3 closes.

### 5. Scope comes from the query, not from a check

`sessionRepository.revokeAllForUser` filters on `{ userId, revokedAt: null }`.
Other users are untouched because they are not selected — not because a
condition remembered to exclude them. Reusing that operation rather than
writing a second revocation path is what keeps the guarantee structural.

The same filter is what leaves already-revoked sessions alone, preserving
their original timestamps (ADR-004 §7), and what makes a second call revoke
nothing rather than overwrite anything.

The current session is included. It is one of the user's active sessions, and
"all devices" that spared the device asking would be a strange reading of the
words.

### 6. Credential validation lives in one place

Resolving the refresh cookie to a validated session — parse, load, check
`revokedAt` and `expiresAt` logically (ADR-004 §6), compare the secret — is
now `resolveSessionFromRefreshCookie`, and both logout services call it.

This is an extraction, not a redesign: same checks, same order, same refusal
reasons, and ADR-013's tests pass unchanged against it. It exists because the
alternative was a second copy of security-critical credential handling, where
a fix applied to one endpoint silently misses the other. Two copies of this
particular forty lines is a defect waiting for its second author.

`/refresh` deliberately does **not** adopt it. Its classification is a
three-way outcome with a grace window and reuse detection (ADR-012 §4), not a
yes/no on the current hash, and flattening the two into one helper would make
the shared thing answer a question neither caller quite asked.

### 7. What this slice does not do

- **No session listing.** `findActiveByUser` still has no caller. Showing
  someone their devices before ending them is a different feature.
- **No selective revocation.** There is no "sign out that one device"; it is
  this session, or all of them.
- **No password confirmation.** A destructive account action arguably deserves
  re-authentication, and this endpoint has no way to ask — nothing verifies a
  password outside login. Recorded as a gap, not solved here.
- **No token verification.** Logout-all authenticates with the cookie, like
  logout and refresh. ADR-012 §10's deferral stands.
- **No rate limiting.** ADR-007 §13's deployment gate now covers a seventh
  endpoint.

## Consequences

- A user can now end every session they hold, including the one making the
  request. The browser that asked is signed out along with the rest.
- Access tokens already issued stay valid until they expire — at most fifteen
  minutes (ADR-013 §7). Logout-all does not change that and cannot; it is the
  standing stateless-token trade-off, and it applies to every revoked session
  rather than just one.
- The frontend's `signOutAllDevices` mirrors `signOut`: local state clears
  first so the redirect is immediate, then the request settles. A failed
  request still signs the browser out locally, which leaves the other devices
  alive — the opposite of what was asked. That failure is silent today because
  there is no error surface on the dashboard, and it is the weakest point in
  this slice.
- `revokeAllForUser` now has two callers with very different meanings: an
  alarm (reuse detection) and a deliberate user action. They are distinguished
  in the logs by event name, which is the only place they can be told apart
  after the fact.
