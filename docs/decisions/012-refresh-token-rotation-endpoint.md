# ADR-012: Refresh Token Rotation Endpoint

**Status:** Accepted
**Date:** 2026-08-12
**Phase:** 2 (Refresh slice)
**Refines:** [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) (rotation and reuse detection), [ADR-011](./011-login-and-session-issuance.md) §13 (the deferral this slice closes)

## Context

ADR-004 designed the Session's token state — a current hash plus a bounded
history of rotated ones — and the three-way classification that state makes
possible. ADR-011 issued the first real refresh tokens but stopped there:
nothing consumed one, so a session was refreshable in principle and expired
in practice after fifteen minutes.

This slice adds `POST /api/v1/auth/refresh`, the first and only consumer of
the refresh credential. It is where ADR-004's classification table stops
being a design and starts being code, and where three things ADR-004 left
open have to be settled: how a benign concurrent refresh is told apart from
theft, what happens to an account whose standing changed after it signed in,
and how a rotation survives two requests arriving at once.

## Decisions

### 1. The endpoint takes no request body

The credential is the `serviqo_refresh` cookie and nothing else. There is no
schema and no `validateBody` on this route, because there is no input to
validate — a body, if one were accepted, could only be a second place to
look for a credential, and two places to look is how one of them ends up
trusted by mistake.

This also means the endpoint cannot be made to act on behalf of a session
the caller does not already hold a cookie for. The `sessionId` component of
the token is not a parameter a caller supplies independently; it arrives
welded to the secret that has to match it.

### 2. Cookies are read at the route that needs them, not globally

No `cookie-parser`, and no app-wide cookie middleware. `lib/http/cookies.ts`
exposes `readCookie(header, name)`, and only the refresh controller calls it.

The refresh cookie is already `Path`-scoped to `/api/v1/auth` (ADR-011 §12)
precisely so it never rides along on unrelated requests. Installing a global
parser would undo half of that intent on the server side — every health
check and every future endpoint would parse a credential header it has no
business touching. A helper beside `normalizeUserAgent`, called once, keeps
the credential's blast radius equal to its cookie scope.

A parsing failure in that helper can only produce "no cookie found", which
becomes a 401. It cannot produce a match that was not there, because what
follows is a SHA-256 comparison against a stored digest.

### 3. Refusals are one error, with one message

`InvalidRefreshTokenError` — 401, `INVALID_REFRESH_TOKEN` — answers every
refusal: absent cookie, malformed token, unknown session, expired session,
revoked session, unknown secret, replayed secret, concurrent rotation, and
an account no longer entitled to refresh.

This is the same reasoning ADR-009 §1 applied to verification tokens. A
caller holding a token that does not work does not need to know which of
nine reasons applies, and several of those reasons are facts about another
person's account. In particular, "this session was revoked" must not be
distinguishable from "this secret was never valid", because the first
confirms a real session existed at that id.

The endpoint therefore has exactly two outcomes a client can observe: 200
with a new pair of credentials, or 401 with a fixed body.

### 4. The grace window governs revocation only — never issuance

ADR-004 §4 classified any presentation of a previously-rotated hash as
suspected theft, answered by revoking every session the user has. Applied
literally, that is unsafe in the ordinary case: two tabs, or one tab and a
retried request, can both present the same valid token within milliseconds
of each other. One rotates it; the other is then holding a hash that has
just moved into history, through no fault of anyone. Revoking every session
on that basis logs a legitimate user out of every device because their
browser did something completely normal.

ADR-004 is amended here. Presenting the **immediately previous** hash —
the last entry in `previousRefreshTokenHashes`, not any older one — within
`REFRESH_RACE_GRACE_MS` (10s) of `lastRotatedAt` is classified as a benign
concurrent refresh rather than replay.

The window's authority is deliberately narrow, and this is the part that
matters:

- It decides **only** whether reuse triggers revocation.
- It never authorizes issuing an access token, a refresh token, or a
  cookie. The losing request of a legitimate race receives credentials of
  no kind, and gets the same 401 as any other refusal.

Anything else would turn a 10-second window into a period during which a
stolen token still works, which is the opposite of what rotation is for.
A client that races itself recovers by retrying once: the winning request's
`Set-Cookie` has already replaced the cookie, so the retry presents the
current token and succeeds.

The bound on "immediately previous" is what keeps the window from widening
over time. An attacker replaying a token that is three rotations old is
outside the window no matter how recently the session rotated.

### 5. One observable difference between refusals, and why it is accepted

Terminal refusals clear the refresh cookie. The concurrent-rotation refusal
does not.

It cannot: the losing request of a race would otherwise delete the cookie
the winning request just set, destroying a valid credential and converting
a self-healing race into a forced re-login — the exact failure §4 exists to
prevent.

So the presence of a clearing `Set-Cookie` does distinguish the race case
from the rest, and the bodies being identical does not hide that. This is
accepted rather than worked around: reaching the race branch at all requires
presenting a secret that was genuinely current within the last ten seconds
for that specific session. A caller who can do that already knows the
session is real. Nothing is disclosed to anyone who is not already holding
a freshly-rotated credential.

### 6. Rotation is conditional on the hash it replaces

`sessionRepository.rotateRefreshToken` now takes the hash it expects to be
current and matches on it, so the write is a compare-and-swap rather than an
unconditional overwrite.

Without the guard, two requests presenting the same token both match the
current hash while reading, and both rotate. The session ends up two
rotations ahead, one of the two issued tokens is orphaned the moment it is
minted, and the client that keeps the orphan is holding a hash that ages out
of the grace window — at which point §4's replay branch revokes every
session that user has. A false theft alarm produced entirely by the server
racing itself is a worse outcome than the race it was meant to survive.

With the guard, exactly one rotation commits. The loser gets `null`, which
is the same benign-race outcome as §4: 401, no revocation, no cookie change,
recovered by a retry.

This changes a method that had no production caller before this slice — its
own repository tests were the only ones — so no shipped behavior is being
rewritten. The bounded-history invariant it owned (ADR-004 §4) is unchanged
and still enforced in the same single atomic pipeline update.

### 7. Refresh re-checks the account, not just the token

A valid, unrevoked session whose secret matches is not sufficient. The user
is loaded and must still be `active` with a verified address, or the session
is revoked and the refresh refused.

A session lives seven days; an access token lives fifteen minutes. Refresh
is the only moment in that week when the server gets to reconsider. Skipping
the check would mean disabling an account leaves it fully able to mint fresh
access tokens for the remainder of its sessions' lifetimes, and "disabled"
would mean "disabled in about seven days."

Revoking the session rather than only refusing it is what stops the cookie
from returning every fifteen minutes to be refused again. Revoking *this*
session and not all of them is deliberate: the flow that disables an account
owns revoking the rest, and refresh should not grow sweeping writes it has
no way to scope correctly.

The `emailVerifiedAt` half of the check is defense in depth and is expected
to be unreachable today — `markEmailVerified` is set-once and nothing
un-verifies an address. It is written anyway because the alternative is a
gate that a future email-change flow silently walks around.

### 8. Refresh returns the user's identity

The 200 body is the login body minus the parts that only apply to a fresh
sign-in: `{ user, accessToken, expiresIn }`.

The access token lives in memory on the client and does not survive a page
reload; the refresh cookie does. Refresh is therefore the flow a returning
tab uses to find out who it is, and returning only a token would force every
such client into a second round trip to an endpoint that does not exist yet.
The user document is already loaded for §7's check, so this costs nothing.

The identity is the same three fields login returns — `id`, `name`, `email`
— through the same mapping, so the two flows cannot drift into disagreeing
about what a session's owner looks like. Account state (`status`,
`emailVerifiedAt`, lockout counters) stays out, for the reasons ADR-011 §2
gave.

### 9. Order of evaluation

1. Cookie present, token parses, `sessionId` is a well-formed ObjectId.
2. Session loads, and is valid **logically** — `revokedAt == null` and
   `expiresAt > now` — never by existence alone (ADR-004 §6).
3. Presented secret is hashed and classified against current, then history.
4. Account still entitled (§7).
5. Compare-and-swap rotation (§6), then issue.

The ObjectId check in step 1 is not cosmetic: `findById` on a malformed id
raises a `CastError`, which would answer a hand-typed cookie with a 500 and
report a client's garbage as a server fault.

Validity is checked before classification, so a session already revoked by
an earlier reuse detection does not re-run revocation on every replay.

### 10. What this slice does not do

- **No token verification middleware.** Still nothing consumes an access
  token; ADR-011 §13's deferral stands and belongs to the slice that first
  protects a route. Refresh authenticates with the cookie, not a bearer
  token.
- **No logout.** The endpoint that clears a session on purpose is its own
  slice. Reuse detection revokes sessions, but that is an alarm, not a
  feature a user can invoke.
- **No client wiring.** `apps/web` does not call this endpoint yet. The
  frontend's retry-once-then-sign-out policy (§4) lands with that slice.
- **No rate limiting.** ADR-007 §13's deployment gate now covers a fifth
  endpoint. Refresh is a credential-guessing surface like login, and the
  gate holds until that slice exists.
- **No session listing or device management.** `findActiveByUser` remains
  without a caller.

## Consequences

- A disabled account loses the ability to mint access tokens within fifteen
  minutes rather than seven days, at the cost of one indexed user lookup per
  refresh.
- Reuse detection is now live and revokes every session a user has. A false
  positive logs someone out everywhere, which is why §4 and §6 exist; the
  remaining path to one is a client that stores a refresh cookie, stops
  using it for longer than the grace window, and then presents it after the
  session has rotated — behavior no first-party client has.
- `rotateRefreshToken`'s signature changed. Its only callers were tests.
- The refresh cookie's `Path` now has a live endpoint under it, so the URL
  prefix ADR-011 §12 accepted as fixed is genuinely fixed.
- Refresh does not extend the session. `expiresAt` is set at login and
  rotation does not move it, so seven days after signing in the user
  authenticates again regardless of activity. Sliding expiry would be a
  deliberate change to that contract, not an oversight in this one.
