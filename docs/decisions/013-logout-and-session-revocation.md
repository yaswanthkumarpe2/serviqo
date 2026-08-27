# ADR-013: Logout and Single-Session Revocation

**Status:** Accepted
**Date:** 2026-08-12
**Phase:** 2 (Logout slice)
**Refines:** [ADR-011](./011-login-and-session-issuance.md) §13 (the deferral this slice closes), [ADR-012](./012-refresh-token-rotation-endpoint.md) §10

## Context

Sign-out has existed in the UI since the frontend login slice, and it has
always been a lie by omission: it dropped the access token from memory and
left the refresh cookie untouched. Since ADR-012 that omission became
visible — the next page load restored the session the user had just ended.

This slice adds `POST /api/v1/auth/logout`, the endpoint that makes signing
out mean something. It is the third consumer of the refresh cookie and the
first that destroys rather than exchanges it.

## Decisions

### 1. Logout always succeeds

Every call answers `200` with the success envelope and clears the cookie.
There is no failure branch: absent cookie, malformed token, unknown session,
expired session, already-revoked session, and a secret that matches nothing
all produce the same response as a genuine revocation.

This is the whole of the idempotency requirement, and it falls out of the
question the endpoint actually answers. "Log me out" is a request to reach a
state, not to perform a transaction. If the state already holds, the request
has succeeded. A second call is not a failed call.

It also removes an oracle that a 401-on-failure design would create. Refusing
an unknown session id would confirm which session ids are real, and confirming
that to an unauthenticated caller is exactly what ADR-007 §1 committed this
API to withholding.

### 2. The envelope, not 204

ADR-008 §1 made `204` the answer for endpoints that must disclose nothing,
and this is not a departure from that reasoning — it is the reasoning applied
to a different case.

What §1 forbade was a *varying* field: a body whose contents differ by
internal state is a channel. Logout's body is a constant. It says the same
thing to every caller on every path, because §1 above guarantees there is only
one path. A constant discloses nothing, so the standard envelope costs
nothing, and clients keep one response shape across the API.

### 3. Revocation requires the secret, not just the session id

The token's `sessionId` component is not secret (ADR-004 §2). Revoking on
that alone would let anyone end anyone's session by presenting a plausible
ObjectId — and ObjectIds embed a timestamp and a counter, so they are guessable
enough to matter. A forced-logout endpoint is a denial-of-service tool.

So logout hashes the presented secret and revokes only when it matches the
session's `currentRefreshTokenHash`, compared in constant time. A mismatch is
answered exactly as §1 requires — success, cookie cleared, nothing revoked.

### 4. Only the current hash counts, and the race that suggests otherwise does not exist

A presented secret matching a *previously rotated* hash does not revoke.

The case for accepting one is a tab holding a stale token after a concurrent
rotation. That case cannot arise: the refresh token lives in one cookie shared
by every tab in the browser, the browser attaches whatever is current at send
time, and no tab keeps a private copy — it cannot, the cookie is `HttpOnly`.
A stale secret therefore has to be constructed by hand, which is not a user
signing out.

Accepting old hashes would also widen the window in which a stolen, already-
rotated token still does something, in exchange for a scenario with no real
client behind it.

### 5. Logout does not run reuse detection

Presenting a rotated token here is classified as "revoke nothing" and logged.
It does **not** trigger ADR-004 §4's revoke-everything response, even though
the same presentation on `/refresh` would.

Reuse detection is a response to a credential being *used*, and its cost is
every session that user has. Wiring it to an endpoint that grants nothing
would mean an unauthenticated request could destroy every session a user
holds — a mass-revocation trigger reachable by anyone who guesses a session
id and any wrong secret. Detection stays on the flow a thief actually wants,
which is refresh.

The consequence is accepted deliberately: a thief who calls logout with a
stolen rotated token escapes detection. They also achieve nothing, and their
next call to `/refresh` is detected.

### 6. Exactly one session ends

`sessionRepository.revokeById` filters on `revokedAt: null`, so a second
logout matches nothing, changes nothing, and preserves the original
revocation timestamp — which is what ADR-004 §7 wanted that field to record.

Other sessions are untouched, on every path. Signing out of a laptop must not
sign out the phone. "Log out everywhere" is a different feature with a
different endpoint, and it is not in this slice.

### 7. The access token outlives the session, by up to fifteen minutes

Nothing verifies an access token yet (ADR-012 §10), so this is currently
theoretical — but it is the standing consequence and ADR-011 already recorded
it: revoking a session invalidates the refresh cookie immediately and the
access token only by expiry.

Logout does not change that and cannot. A stateless token is valid until it
expires; the alternative is a revocation check on every request, which is the
statefulness JWTs were chosen to avoid (ADR-002 §3). Fifteen minutes is the
bound, and it is why `ACCESS_TOKEN_TTL_MS` is short.

The slice that introduces token verification inherits this and should not be
surprised by it.

### 8. CSRF

`SameSite=Strict` on the refresh cookie (ADR-011 §12) is what stops a
cross-site page from logging a user out. Forced logout is a nuisance rather
than a compromise, but it is still an action taken without intent, and the
control that prevents it is already in place — this endpoint needs nothing
new. It is a `POST` so it is not reachable by navigation or prefetch.

### 9. What this slice does not do

- **No "log out all devices".** `revokeAllForUser` exists and stays reserved
  for reuse detection.
- **No token verification.** Logout authenticates with the cookie, like
  refresh. ADR-012 §10's deferral stands.
- **No session listing.** `findActiveByUser` still has no caller.
- **No rate limiting.** ADR-007 §13's deployment gate now covers a sixth
  endpoint. Logout is not a guessing surface — it grants nothing — but the
  gate is about the auth surface as a whole.

## Consequences

- Signing out now ends the session on the server, so a reload cannot restore
  it. That is the defect this slice exists to close.
- The frontend's `signOut` becomes asynchronous. It clears local state
  synchronously first so protected routes redirect on the next render, then
  lets the request settle — the user is never made to wait on the network to
  leave a page they have already left.
- Clearing local state before the response returns leaves a narrow race: if a
  user signed out and completed a fresh sign-in before the logout response
  arrived, that response's clearing `Set-Cookie` would remove the new
  session's cookie. It requires beating a local round trip with a typed email
  and password, and the cost is one extra sign-in. Recorded rather than
  engineered around.
- A logout whose request never reaches the server still clears the client. The
  cookie then outlives the session in the browser, and the next refresh
  restores it. Best-effort local sign-out is the right failure mode: the
  alternative is refusing to sign the user out because the network is down.
