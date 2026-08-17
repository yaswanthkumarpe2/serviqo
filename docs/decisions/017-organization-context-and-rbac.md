# ADR-017: Organization Context and Role-Based Authorization

**Status:** Accepted
**Date:** 2026-08-17
**Phase:** 2 (Organization context and RBAC slice)
**Closes:** [ADR-015](./015-access-token-verification-and-current-user.md) §9 (`/me` carries no organization) and §13 (`requireOrganization`/`requirePermission` belong to the RBAC slice)
**Implements:** [ADR-002](./002-phase-2-authentication-architecture.md) §7–19 ("RBAC: permission-based, centralized via `can()` / `requirePermission()` — no scattered `if (role === 'admin')` checks")
**Binding constraint from:** [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (resolve access by loading the `Organization`, never by finding a `Membership` alone)
**Related:** [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) §8 (Sessions carry no organization context), [ADR-010](./010-principal-types-organization-users-and-customers.md) §2 (Customer is not a role), [ADR-011](./011-login-and-session-issuance.md) §2 (no `organizationId` or `role` in the token)

## Context

Serviqo can now authenticate a staff user (ADR-015) and create a tenant with
its owner (ADR-016). What it cannot do is answer the question every
subsequent staff endpoint asks first: *which organization is this request
about, and may this user act in it?*

Four ADRs deliberately left that question open, and each closed a door on
the way past:

- **ADR-011 §2** keeps `organizationId`, `role`, and `permissions` out of the
  access token, because a role baked into a 15-minute credential keeps
  working after an admin revokes it.
- **ADR-004 §8** keeps them off the `Session` too, so a user who belongs to
  several organizations can switch without re-authenticating.
- **ADR-015 §9** left them off `/me`, because no `Membership` existed.
- **ADR-016 §3** made one requirement binding on this slice: organization
  access must be resolved by loading the `Organization` and checking it is
  active, never by finding a `Membership` alone.

Together those mean the organization context is carried by **nothing** the
system already has. It must be named per request and proved per request.
This ADR decides how.

It also has to resolve a direct contradiction. `membership.repository.ts`
states that there is "deliberately no `findByUser(userId)` here that a caller
could follow with in-memory filtering — that shape invites 'fetch everything,
then filter', which is exactly how cross-tenant leaks happen." `/me` now has
to list the caller's memberships, which is precisely a `findByUser`. Adding
it without settling why it is safe here and forbidden elsewhere would quietly
delete a tenant-safety property this codebase wrote down on purpose.

## Decisions

### 1. The active organization is a path parameter

Organization-scoped staff routes live under
`/api/v1/organizations/:organizationId/…`, and `requireOrganization` reads
the tenant from `req.params` and from nowhere else.

**Not the session.** ADR-004 §8 forbids it in the schema's own words, and for
a reason worth restating: a server-side "currently selected organization"
makes two browser tabs fight over one value, and turns a read in tab A into
an authorization change in tab B.

**Not a request body or query string.** Those are the inputs
`PROJECT_CONTEXT.md` §22 means by "never trust frontend-supplied
identifiers", and a body cannot address a `GET` at all.

**Not a header.** A header is invisible in access logs, omissible by
accident, and it lets a route that *needs* tenant context be addressed
without any — the failure mode being a handler that quietly operates on
whatever default it invented. A path segment cannot be forgotten, because
the URL does not exist without it.

The client asserting an organization id in the path is not the same as being
trusted with it. It is an address, validated against the database before
anything reads it — exactly as `/me` treats the token's `sub` (ADR-015 §11).
It is also the only form that appears in every request log, which is what
makes a cross-tenant attempt visible after the fact.

The id is shape-checked against the 24-character hex `OBJECT_ID_PATTERN`
before it reaches Mongoose, for the reason `refreshToken.ts` gives: a
`CastError` reaching `errorHandler` is a generic 500, which reports a
client's malformed URL as a server fault.

### 2. Four gates, and all four are required

`requireOrganization` resolves context by proving, in order:

1. A `Membership` exists for **this user and this organization** —
   `findByUserAndOrganization(userId, organizationId)`, which proves the
   relationship against both identities in a single indexed query.
2. That membership's `status` is `"active"`.
3. The `Organization` exists.
4. That organization's `status` is `"active"`.

Gates 3 and 4 are ADR-016 §3's binding requirement made real: "a membership
is a claim about a tenant, not proof the tenant exists." ADR-016 §3 also
records exactly how an orphaned membership becomes reachable — a crash
between onboarding's two writes — so this is not a hypothetical.

Gate 2 gives `MembershipStatus` its first meaning. `invited` is an
invitation not yet accepted and grants nothing; `suspended` is access
revoked without destroying the record, and grants nothing. Only `active`
grants. Writing this down now matters because the invitations slice will
create `invited` rows, and an authorization check that treated any
membership as sufficient would admit people who never accepted.

### 3. Authorization queries both identities; it never filters in memory

`requireOrganization` uses `findByUserAndOrganization` and **may not** use
`findByUser`. This preserves `membership.repository.ts`'s stated property
rather than overriding it.

The distinction is not stylistic. "Fetch this user's memberships, then check
in JavaScript whether one of them matches the requested organization" is a
comparison a developer writes by hand, and the ways to get it wrong are
quiet: comparing an `ObjectId` to a string, `==` against `undefined`,
`.find()` without checking the result, or forgetting the `status` gate on the
row that matched. Asking the database for `{ userId, organizationId }`
returns a document or `null`, and there is no comparison left to write.

### 4. `findByUser` is added, and is forbidden for authorization

`/me` lists the caller's memberships, which needs the method the repository
declined to provide. It is added with its scope stated in its own name and
comment: it answers "which organizations does *this caller* belong to", and
must never appear in an authorization path.

It is safe for listing for a reason the original prohibition did not
contradict. The danger it named is *filtering in memory after fetching
broadly*; here `userId` is the complete scope, it is the prefix of the
`{ userId: 1, organizationId: 1 }` unique index, and the result set is by
construction exactly the caller's own rows. Nothing is filtered afterwards,
and the caller is the subject of every document returned.

The prohibition stands for the case it was written about, and §3 is where it
is enforced.

### 5. The role comes from the database, on every request

`requireOrganization` attaches `req.organizationContext = { organizationId,
role, membershipId }`, where `role` is read from the `Membership` document
that was just loaded.

There is no path by which a client supplies a role. It is not in the token
(ADR-011 §2), not in the session (ADR-004 §8), not accepted in a body, and
not read from a header. A `role` field in a request is not rejected — it is
never consulted, which is the stronger guarantee (ADR-015 §11). This is what
makes a revoked role take effect on the next request rather than at token
expiry, which is the property ADR-004 §8 gave up token-embedded roles to
obtain.

### 6. Two failure modes, and they disclose different things

**A failed gate from §2 answers `404 NOT_FOUND`, indistinguishably.**
Organization does not exist, organization is suspended, caller is not a
member, membership is `invited`, membership is `suspended` — one response,
one message.

Answering `403` for "you are not a member" would confirm that the
organization exists, turning any authenticated account into an oracle for
"which tenant ids are real" and, with a guessable slug, "does company X use
Serviqo". That is the enumeration reasoning ADR-009 §1, ADR-011 §3,
ADR-012 §3, and ADR-015 §6 have each applied in turn, and a tenant's
existence is exactly the kind of fact SECURITY.md §2 exists to keep inside
its own boundary.

**A failed permission check answers `403 FORBIDDEN`, specifically.**
By the time `requirePermission` runs, `requireOrganization` has already
proved membership — so the caller demonstrably knows this organization
exists and belongs to it. Withholding "your role cannot do this" from
someone who has proved they work there discloses nothing and only makes the
product confusing. The two codes therefore mean precisely: *404 — as far as
you are concerned this tenant does not exist*; *403 — it exists, you are in
it, your role is not enough*.

### 7. Permissions are a map, checked through one function

```ts
ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]>
can(role, permission): boolean
requirePermission(permission): RequestHandler
```

This is ADR-002 §7–19's "centralized via `can()` / `requirePermission()` — no
scattered `if (role === 'admin')` checks" made concrete. A route names the
permission it needs; no route names a role. That is what lets the mapping
change — or gain the custom roles `PROJECT_CONTEXT.md` §5 anticipates —
without auditing every handler.

**The catalogue starts small and grows with its enforcers.** This slice
defines the organization-scoped permissions and nothing else:

| Permission | owner | admin | supervisor | agent |
|---|---|---|---|---|
| `organization.read` | ✅ | ✅ | ✅ | ✅ |
| `organization.manage` | ✅ | ✅ | | |
| `member.read` | ✅ | ✅ | ✅ | |
| `member.manage` | ✅ | ✅ | | |

`conversation.read`, `ticket.update`, and `ai.configure` are named in
`PROJECT_CONTEXT.md` §5 and are deliberately **absent**: no conversation,
ticket, or AI resource exists, and a permission with nothing to guard is the
same unexercised security surface `accessToken.ts` refused to write a
verifier for before it had a caller. A permission enters this map in the
slice that enforces it.

**`MembershipRole` is used exactly as declared** — `owner`, `admin`,
`supervisor`, `agent`. No `customer`, ever: ADR-010 §2 gives three
independent sufficient reasons, and ADR-010's consequences call these four
"correct and final for staff".

### 8. `requirePermission` ships with a real caller

`GET /api/v1/organizations/:organizationId` returns the organization and the
caller's role in it, behind `requireAccessToken` → `requireOrganization` →
`requirePermission("organization.read")`.

It exists so this slice does not ship two security-critical middlewares that
nothing exercises — the failure mode `accessToken.ts` named when it declined
to write a verifier before its first consumer. It is also the endpoint the
dashboard uses to confirm a switched context is real, rather than trusting
its own client-side selection.

Deliberately **not** shipped: a members list, an organization update, or
anything conversation-shaped. `member.read` and `organization.manage` exist
in the map to give the role gradient something to mean and are exercised by
`requirePermission`'s own tests; their endpoints belong to team management
and organization settings.

### 9. `/me` returns a list, never a "current" organization

```json
{ "user": { …six fields, unchanged… },
  "memberships": [ { "organization": { "id", "name", "slug", "status" },
                     "role", "membershipId" } ] }
```

**A list, not a selection.** There is no `currentOrganizationId` on `/me`,
because there is no server-side notion of current (§1). The client chooses;
the server proves that choice on every request.

**Empty is empty.** A user with no memberships gets `[]` — never a
fabricated organization, and never `null` dressed as one. That is the
ordinary state for anyone who has registered and not yet onboarded, and it
is what tells the dashboard to offer creation instead of a switcher.

**Only `active` memberships to `active` organizations are listed**, using the
same gates as §2. Listing a suspended tenant the caller cannot enter would
produce a switcher entry that 404s when selected.

**Ordering is deterministic** — by organization name, then id — so the
switcher does not reshuffle between loads and tests are not flaky. Mongo
returns documents in unspecified order otherwise.

**Minimal organization fields.** `id`, `name`, `slug`, `status`; no
timestamps and no internal fields. `status` is included even though only
`active` is listed today, for ADR-015 §10's reason: the client that reads it
survives a future state being allowed through.

The six existing user fields are unchanged. `memberships` is a sibling of
`user` rather than nested inside it, because a membership is a fact about a
relationship, not an attribute of the person — the same reason `User`
carries no `organizationId` (ADR-010 §3).

### 10. The switcher is UX; the server is the authority

The dashboard reads its list from `/me`, so the options are by construction
only organizations the caller is a member of. Selecting one changes which
organization id the client puts in subsequent URLs — nothing else.

Per ADR-015 §12 and ADR-011 §1, the selection may be kept in memory and, at
most, as an organization **id** for convenience across reloads. Roles and
permissions are never stored client-side in any form: they are re-derived
from `/me` and re-proved by `requireOrganization` on every request. A UI that
remembered "I am an owner" would be a UI that can be edited into one.

`ProtectedRoute`'s note applies unchanged: this is "a UX control, not a
security boundary". A client that selects an organization it does not belong
to receives a 404 from the server, and the correct client response is to
discard the selection rather than to trust it.

### 11. What this slice does not do

- **No invitations or team management.** `member.read`/`member.manage` have
  no endpoints; the second membership needs an email, a token, and an
  acceptance step (ADR-005 §2 already excluded invitations from
  `AccountToken`).
- **No organization update, rename, or suspend endpoint.** `status` is
  readable and only reachable through the database today.
- **No conversation, ticket, or AI permissions** (§7).
- **No rate limiting.** ADR-007 §13's deployment gate now covers a ninth and
  tenth endpoint, and it remains the next slice.
- **No `Customer`, widget, or Socket.IO.** ADR-010 §9 anticipates that socket
  authorization needs two verifiers and asymmetric rooms; nothing here
  prejudges that.

## Consequences

- Serviqo has an authorization boundary. `requireOrganization` is the one
  place tenant context is established, and every future staff route composes
  it rather than re-deriving membership.
- The staleness ADR-004 §8 traded token size for is now realised: changing a
  role takes effect on the caller's next request, because the role is read
  from the database every time.
- Two middlewares must be mounted in order — `requireAccessToken`,
  `requireOrganization`, `requirePermission` — and the last two throw if the
  earlier ones did not run. That is a deliberate loud failure rather than a
  silent unauthenticated pass.
- `/me` costs one additional indexed query per call and, for a user with
  memberships, one organization lookup. The dashboard calls it once per
  mount.
- A tenant's existence is not disclosed to non-members (§6), which means a
  legitimate user who mistypes an organization id sees "not found" rather
  than "forbidden". Accepted: the alternative discloses the tenant list to
  every authenticated account in the system.
- `membershipRepository` now has both a scoped-listing method and an
  authorization method, and they are not interchangeable. §3 and §4 are the
  record of which is which, because the next person to need "the user's
  organizations" in an authorization path will reach for the wrong one.
- The permission catalogue is deliberately incomplete. Slices that add
  resources add their permissions, and the table in §7 is the place that
  stays authoritative.
