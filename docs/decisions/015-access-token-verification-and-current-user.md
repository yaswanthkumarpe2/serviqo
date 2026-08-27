# ADR-015: Access Token Verification and the Current-User Endpoint

**Status:** Accepted
**Date:** 2026-08-13
**Phase:** 2 (Current-user slice)
**Closes:** [ADR-011](./011-login-and-session-issuance.md) §13, [ADR-012](./012-refresh-token-rotation-endpoint.md) §10, [ADR-013](./013-logout-and-session-revocation.md) §9, [ADR-014](./014-logout-all-devices.md) §7 — the deferral all four recorded
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) (stateless tokens), [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) §8 (per-request organization resolution), [ADR-010](./010-principal-types-organization-users-and-customers.md) §5 (principal types)

## Context

Four consecutive slices deferred the same thing in the same words. ADR-011
§13 wrote it first — "the middleware belongs to the slice that first
protects a route" — and ADR-012, ADR-013 and ADR-014 each restated it
because none of them was that slice: refresh, logout, and logout-all all
authenticate with the refresh cookie, not a bearer token.

`accessToken.ts` carries the deferral in code as well, and gives the
reason:

> Issuance only. There is deliberately no `verifyAccessToken` here: nothing
> consumes an access token yet, and a verifier written before its first
> caller is a security-critical function nobody exercises.

This is that slice. `GET /api/v1/auth/me` is the first route in Serviqo
whose credential is an access token, so the verifier now has a caller and
the decisions its absence postponed have to be made: how a bearer token is
read, what verification actually checks, what happens between a valid token
and a user who is no longer entitled to one, and what the dashboard is told
about itself.

Two additional facts shape the endpoint and are settled here rather than
discovered later: a revoked session's access token stays valid for up to
fifteen minutes (ADR-013 §7), and no user in the system has an
`Organization` or a `Membership`, because nothing creates one yet.

## Decisions

### 1. Verification lives beside issuance; the middleware lives beside the other middleware

`verifyAccessToken` is added to `modules/auth/accessToken.ts`, the file that
already owns the claim set, the algorithm, and the signing key. Splitting a
token's format from its parser across two modules is precisely the drift
`refreshToken.ts` avoided when `parseRefreshToken` landed next to
`formatRefreshToken` — a verifier that lives elsewhere is a verifier that
can disagree with the issuer, and the disagreement is silent.

`middleware/requireAccessToken.ts` holds the Express plumbing: read the
header, call the verifier, attach the principal or refuse. ADR-003 places
cross-cutting infrastructure outside `modules/`, and this is cross-cutting
by construction — every protected route in every future domain mounts it.
The split is header handling here, credential handling there.

### 2. The verifier returns `null`; it does not throw

Every rejection — bad signature, wrong issuer, wrong audience, expired,
`alg: none`, a `sub` that is not an ObjectId — produces `null`. The caller
decides what a refusal means.

`jose` throws a *different error class per failure mode*
(`JWTExpired`, `JWTClaimValidationFailed`, `JWSSignatureVerificationFailed`),
and each carries a message naming the claim that failed. Letting those
propagate would put the distinctions one `instanceof` away from a response
body, which is the shape of every accidental oracle in this codebase's
history. Collapsing at the boundary means the distinction never exists in
the first place, rather than existing and being carefully not used.

### 3. The algorithm is pinned, and that is load-bearing

Verification passes `algorithms: ["HS256"]` explicitly. Without it, a
verifier accepts whatever the token's own header claims — including
`alg: "none"`, which is the classic JWT forgery: strip the signature,
announce that there isn't one, and be believed. The signing key is symmetric
(ADR-011 §10), so the header must never be allowed to choose.

`issuer` and `audience` are passed to `jwtVerify` rather than compared
afterwards, so the check cannot be forgotten by a later edit that reshapes
the payload handling.

### 4. `aud` is the control ADR-010 §5 was written for

ADR-010 §5 required that a token declare its principal type and that
"verification rejects any token whose audience does not match". Until now
that requirement had no verifier to bind. It does now:
`ACCESS_TOKEN_AUDIENCE` is `serviqo-dashboard`, and a token bearing any
other audience is refused before its subject is read.

Serviqo has one principal type today, so nothing in production can currently
fail this check. It is tested anyway, with a token minted under
`serviqo-widget` using the *correct signing key* — the exact shape a future
customer credential would take, and the only test that can fail before that
credential exists. This is the retrofit ADR-010 §5 said could not be applied
to tokens already in circulation, and it is now enforced rather than merely
promised.

### 5. `sub` is validated as an ObjectId before it reaches Mongoose

The same 24-character hex guard `parseRefreshToken` applies to session ids,
and for the same reason: `findById` raises a `CastError` on a malformed
value, and a `CastError` reaching `errorHandler` is a generic 500 — a client
credential answered as a server fault.

A token that reaches this point was signed with Serviqo's own key, so its
`sub` is always well-formed in practice. The guard exists because "in
practice" is doing work in that sentence that a regex does more cheaply, and
because the failure mode it prevents is a 500 on an authentication path.

### 6. Every refusal is one `401 INVALID_ACCESS_TOKEN`

Absent header, malformed header, wrong scheme, empty token, bad signature,
expired, wrong issuer, wrong audience, unknown user, and disabled user all
raise `InvalidAccessTokenError` with one message.

This is ADR-009 §1, ADR-011 §3, and ADR-012 §3 applied a fourth time, and
the reasoning has not changed. Two distinctions are worth naming explicitly
because they are the tempting ones:

**"Expired" is not disclosed separately.** It reads harmless — the client
already knows when its token expires — but the client is not the only
caller. To anyone probing with a stolen or guessed token, "expired" confirms
the token was once real, and that is the difference between a dead end and a
lead.

**"No such user" and "disabled" are not distinguished from "bad token".**
Answering `404` for a deleted account, or a specific code for a disabled
one, turns a bearer token into a probe for account state. ADR-011 §6 already
refused to confirm a disabled account to someone holding its *password*;
confirming it to someone holding a token would be strictly worse.

The `reason` recorded in the structured log is the one place the
distinctions exist — for operators, after the fact, on the server. That is
the same division ADR-012 §3 drew.

### 7. A valid token is not sufficient; the account is re-checked

`sub` identifies a user. It does not entitle them. The service loads the
user and refuses unless the account still exists, is `active`, and has a
verified address — the same three-part gate `refresh.service.ts`'s
`loadEntitledUser` applies, deliberately identical so the two cannot drift
into disagreeing about who may hold a session.

This is what makes a disabled user's access token useless immediately rather
than at expiry. Disabling an account revokes nothing by itself; this check
is the reason the dashboard stops answering.

### 8. The session is NOT re-checked, and the fifteen-minute window stands

`sid` is verified as part of the token and then deliberately not looked up.
No session document is loaded, and a revoked session's access token keeps
working until it expires.

ADR-013 §7 recorded this as the standing consequence and said the slice
introducing verification "inherits this and should not be surprised by it".
It is inherited here, awake and on purpose. A per-request session lookup
would make every protected route stateful, which is the exact property
ADR-002 §3 chose JWTs to avoid, and it would do so to close a window
`ACCESS_TOKEN_TTL_MS` already bounds at fifteen minutes.

The asymmetry with §7 is deliberate and worth stating plainly: **the account
is re-checked on every request, the session is not.** Disabling a user is a
security response and takes effect immediately; ending a session is a user
convenience and takes effect within fifteen minutes. If session-level
revocation ever needs to be immediate — a "sign out that device, now"
feature — that is a new decision requiring a revocation list or a session
lookup, and it is not reachable by loosening anything here.

### 9. `/me` returns identity, and no organization or role

The response is `id`, `name`, `email`, `status`, `emailVerifiedAt`, and
`createdAt`. It carries no `organizationId`, no `role`, no `Membership`, and
no organization list.

**Because there is nothing truthful to put there.** No slice creates an
`Organization` or a `Membership`. Every user in the database has zero
memberships, so an organization field would be `null` for every caller —
a field that is a constant pretending to be data, which is the reasoning
`login.service.ts` used to omit `emailVerified` and registration used to
derive it.

**Because "current organization" does not exist as a concept.** ADR-004 §8
resolves organization access *per request, scoped to a specific
organizationId*, and ADR-011 §2 keeps `organizationId` and `role` out of the
token for exactly that reason. A user may belong to several organizations;
nothing today selects among them. Answering "your current organization"
would require inventing that selection, which is organization onboarding —
a different slice.

**Because the repository is shaped to forbid the shortcut.**
`membershipRepository` has no `findByUser(userId)`, and its header explains
why: that shape "invites 'fetch everything, then filter', which is exactly
how cross-tenant leaks happen." Adding one to populate a dashboard field
would trade a documented tenant-safety property for a value that is
currently always empty.

When organization onboarding lands, the membership/role that the dashboard
needs belongs to an organization-scoped endpoint or an explicit
organization-selection step — not retrofitted onto `/me`, whose subject is
the global `User` identity that ADR-010 §3 says carries no tenant.

### 10. `status` is returned, and is always `"active"`

Recorded because it is the one field in §9's list that is knowingly
redundant: §7 refuses every non-active account, so no caller can ever
observe another value.

It is included regardless, for two reasons. It is the caller's own account
state returned to the authenticated owner, so it discloses nothing — unlike
the login response, where ADR-011 §3 withholds account state from a caller
who has not yet proved anything. And a client that reads `status` keeps
working if a future state is ever allowed to reach the dashboard in a
degraded mode, whereas a client that assumes "reachable implies active"
would have to be found and changed.

This is a deliberate exception to the "no constants pretending to be data"
rule applied elsewhere, not an oversight.

### 11. Identity comes from the token and the database, never the request

There is no `validateBody`, no query parameter, and no path parameter on
this route. The user is `sub`, and `sub` comes from a signature Serviqo
produced. A `userId` in the body or query string is not rejected — it is
never read, which is a stronger guarantee than rejecting it, because there
is no code path in which it could be consulted.

The response is built from the loaded `User` document rather than from the
token, so `name` and `email` are current as of the request rather than as of
login. This is also why they are absent from the token (ADR-011 §2): a name
in a JWT is stale personal data in a place personal data does not belong.

### 12. The access token is never logged and never returned

Auth logging convention is unchanged: structured events, `userId` and
`sessionId` where known, `reason` for refusals, and the error's class rather
than its message (`authLogging.ts`).

The token itself appears in no log line, valid or not — the refusal events
record *why* a credential failed, never the credential. `/me` also returns no
token of any kind: it is a read of identity, not a credential endpoint, and
minting or echoing one here would give the dashboard a second way to obtain
an access token that bypasses both login and refresh.

### 13. What this slice does not do

- **No `WWW-Authenticate` header.** RFC 6750 suggests one on a bearer 401.
  Its `error="invalid_token"` / `error="expired_token"` parameters are
  exactly the distinctions §6 refuses to make, and a bare `Bearer` challenge
  adds nothing a client uses. Deliberately omitted rather than forgotten.
- **No authorization.** This middleware answers "who is calling", never "may
  they". `requirePermission` and `requireOrganization` belong to the RBAC
  slice, and ADR-010 §2's boundary — Customer is not a role — binds it.
- **No organization onboarding.** §9's consequence, and the slice that
  unblocks the membership question.
- **No session listing or device management.** `findActiveByUser` still has
  no caller, four slices later.
- **No rate limiting.** ADR-007 §13's deployment gate now covers an eighth
  endpoint. `/me` grants nothing and is not a guessing surface, but the gate
  is about the auth surface as a whole.

## Consequences

- Serviqo has an authentication boundary. `requireAccessToken` is the one
  place a bearer token is verified, and every future protected route mounts
  it rather than re-implementing the check.
- The audience claim ADR-010 §5 required is now enforced rather than merely
  issued. A future customer credential cannot verify on a staff route, and
  the test proving it exists before the credential does.
- A disabled account loses the dashboard on its next request rather than
  within fifteen minutes — the account gate is per-request, unlike the
  session, which is not (§7, §8).
- `/me` costs one indexed user lookup per call. The dashboard makes it once
  per mount, not per render.
- The frontend no longer displays identity taken from the login response.
  The session's `user` remains as the restore's payload, but the dashboard's
  source of truth is `/me`, which means a name or email changed elsewhere
  appears on the next dashboard load rather than the next sign-in.
- `lib/errors` gains `InvalidAccessTokenError`, the fourth 401 in the file
  and the first thrown by middleware rather than by a service.
- `Request.principal` enters the Express type surface. It is optional in the
  type, because most routes have none — a route that needs it mounts the
  middleware that sets it, and TypeScript will not let a handler assume it
  otherwise.
- The staleness window in §8 is now user-visible for the first time: signing
  out on one device leaves the dashboard working on that device's *other*
  tab for up to fifteen minutes if it holds a token. That was always the
  design; this is the slice where someone could notice.
