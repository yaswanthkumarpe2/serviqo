# ADR-027: Team Management and the Membership Lifecycle

**Status:** Accepted
**Date:** 2026-08-25
**Phase:** 3 (User / Team / Role management)
**Implements:** ROADMAP.md Phase 3's "Team creation and management" and the add/role/remove half of "Invitation system for joining organizations"
**Closes:** [ADR-026](./026-conversation-assignment-and-status.md) §15's carried-forward limitation — "A conversation assigned to someone whose membership was revoked stays assigned to them … Nothing sweeps `assignedTo` when a membership ends, because membership removal has no endpoint yet (`member.manage` guards nothing today). The slice that builds it owns that cleanup." This is that slice.
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) §7–19 (permission-based authorization, centralized via `can()`/`requirePermission()` — no scattered role checks); [ADR-003](./003-domain-first-server-modules.md) (domain-first modules); [ADR-010](./010-principal-types-organization-users-and-customers.md) §2–3 (a customer holds no membership; `User` carries no `organizationId`/`role`); [ADR-015](./015-access-token-verification-and-current-user.md) §6–7 (one opaque refusal; a valid signature identifies but does not entitle); [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §1, §3–4 (the owner membership is written first so a tenant is never unowned; compensation), §9 (tenant content stays out of logs); [ADR-017](./017-organization-context-and-rbac.md) §1 (the tenant is a path segment and nothing else), §3 (`findByUserAndOrganization` is THE authorization lookup), §5 (role read from the database on every request), §6 (one opaque refusal, `403` only after membership is proved), §7 (`requirePermission`), §8 (the middleware order); [ADR-018](./018-rate-limiting-and-security-headers.md) §3–4 (limiter placement and user-keyed classes), §6 (the class never reaches a response body), §10 (safe fields only); [ADR-022](./022-persistent-conversations-and-messages.md) §1 (every repository method scoped by `organizationId`), §5 (server-assigned literals, never request input); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §2 (the domain-event seam), §10 (cross-tenant ids stay indistinguishable); [ADR-026](./026-conversation-assignment-and-status.md) §9 (`conversationEvents`), §10 (`conversation:updated` reaches the inbox room and never the customer), §11 (`member.read` gates the roster; a revoked assignee renders nameless), §15 (the limitation this slice closes); CONTRIBUTING.md ("Never rely only on frontend filtering"; "No business logic in JSX"); SECURITY.md §2 (the staff/customer disclosure boundary)

## Context

Serviqo has had a complete authorization model since ADR-017 and has never had
a way to exercise half of it. `member.read` and `member.manage` have sat in
`ROLE_PERMISSIONS` since that slice with the same comment attached to each:

> `member.read` — See who else works here. No endpoint yet — team management
> is its own slice.
> `member.manage` — Invite, remove, or change a member's role. No endpoint yet.

Everything those endpoints need already exists and none of it needs changing.
`Membership` is the authoritative `User ↔ Organization` relationship and has
been since ADR-010; it already carries `role`, `status`, and
`invitedByUserId` — the last of which `membership.model.ts` describes as "the
field that lets [an invitation workflow] be added later without a schema
migration". The database already enforces both invariants this slice depends
on: one membership per user per organization (index A) and **at most one owner
per organization** (index B, partial on `role: "owner"`).
`requireOrganization` already resolves the tenant from a path segment and
reads the role from the database on every request, and
`membershipRepository.deleteById` already exists with an explicit prohibition
attached to it:

> Deliberately not a general `delete(filter)` … it cannot remove a person from
> an organization. Revoking access is a different operation with different
> authorization, and it belongs to the team-management slice.

Three facts shape every decision below.

**First, `member.manage` is strictly wider than `member.read` in the existing
catalogue.** Both are held by `owner` and `admin` and by nobody else;
`supervisor` holds `member.read` alone; `agent` holds neither. So a caller who
can reach a write route can already read the roster, which is what makes it
safe to answer "that person is already a member" specifically (§8) — it
discloses nothing the caller cannot fetch. This slice does not change the
table. Adding a second RBAC system, or a per-route role comparison, is exactly
what ADR-002 §7–19 forbade.

**Second, the owner invariant is enforced by MongoDB, not by application
code.** Index B makes a second owner document impossible and
`organizationOnboarding.service.ts` makes an unowned tenant impossible by
write ordering. Neither of those protects against an operation that *removes*
the only owner. That is the one new invariant this slice must hold, and §7 is
where it is held.

**Third, ADR-026 shipped a stale-assignment hole and named its owner.**
`Conversation.assignedTo` is a `User` id carrying no tenancy of its own, so a
conversation stays assigned to someone whose membership has ended — rendering
in the inbox as an assignment with no name, unreleasable by anyone, because
ADR-026 §4 lets only the holder release it. That hole existed only because
membership had no lifecycle. It does now, and §10 closes it.

This slice introduces **no new credential, no new transport, no new
authentication path, no new authorization mechanism, and no new event bus**.
It adds four routes, one repository, one service, five error classes, one rate
limit class, one conversation-repository method, and one dashboard section.

## Decisions

### 1. Four routes under `/organizations/:organizationId/members`, keyed by membership id

```
GET    /api/v1/organizations/:organizationId/members                 member.read
POST   /api/v1/organizations/:organizationId/members                 member.manage
PATCH  /api/v1/organizations/:organizationId/members/:membershipId/role   member.manage
DELETE /api/v1/organizations/:organizationId/members/:membershipId   member.manage
```

Nested under the organization prefix so the tenant is a **path segment**
`requireOrganization` can read, which is the only source it consults
(ADR-017 §1). A member route cannot be addressed without naming a tenant, and
a body or query `organizationId` is not rejected — it is never read, which is
stronger.

Its own router rather than routes added to `createOrganizationRouter`,
following ADR-025 §1's precedent exactly: that module owns the tenant record
and its widget installation settings, and **the roster is not organization
configuration**. It is a different resource with a different permission pair.

The two mutating routes are keyed by **`membershipId`, never `userId`**, and
that is a security decision rather than a REST preference. A `User` id is
global and carries no tenancy — the same property that made ADR-026 §11's
assignee lookup necessary. A `Membership` id *is* tenant-scoped, so
`{ _id: membershipId, organizationId }` is a two-key query in which a
membership belonging to another organization returns `null` **identically to
one that does not exist**. The isolation is produced by the query missing, not
by a branch comparing tenants (§9).

`PATCH …/role` rather than `PATCH …/:membershipId` carrying `{ role }`,
following ADR-026 §2's shape: the path is the field being changed. Today both
writes need the same permission so a combined `PATCH` would be defensible;
keeping them separate means the *next* thing a membership can change —
suspension, ownership transfer — arrives as its own route with its own
permission rather than as a discriminator in a body doing authorization work.

### 2. `member.read` and `member.manage` are enforced as they are written, and the catalogue is not touched

```
owner:      organization.read, organization.manage, member.read, member.manage, conversation.*
admin:      organization.read, organization.manage, member.read, member.manage, conversation.*
supervisor: organization.read,                      member.read,                conversation.*
agent:      organization.read,                                                  conversation.*
```

Not one row changes. The list route names `member.read`; the three write
routes name `member.manage`. `requirePermission` compares the role
`requireOrganization` read **from the database on this request** (ADR-017 §5),
which is what makes a role change take effect on the target's *next* request
rather than at their token's expiry — §11 is the test that proves it rather
than assumes it.

So, concretely and by construction rather than by a comparison anywhere in
this slice:

- **owner** and **admin** may list, add, change roles, and remove.
- **supervisor** may list and may do nothing else.
- **agent** may not even list, and receives `403` — safely, because
  `requireOrganization` already proved they work here, so the refusal
  discloses nothing they did not know (ADR-017 §6).

An admin managing another admin is permitted, because the table says
`member.manage` and says nothing about targets. Introducing a role-precedence
rule ("an admin may not act on an equal") would be a **second authorization
model** layered on the first — the exact shape ADR-002 §7–19 refused. The only
target-sensitive rules in this slice are the two structural ones in §7, and
neither is a role comparison: one protects a database invariant, the other
protects the caller from themselves.

### 3. Adding a member is direct, and `invited` stays reserved for the email-backed flow

`POST …/members` takes `{ email, role }` and, on success, creates a membership
with `status: "active"` and `invitedByUserId` set to the **acting user**,
resolved from `req.principal` and never from the body.

The alternative — writing `status: "invited"` and waiting for acceptance — was
considered and declined, because this slice cannot deliver the acceptance.
`requireOrganization` refuses every non-`active` membership, so an `invited`
membership grants nothing until something flips it, and the only honest
somethings are (a) an emailed single-use token, which needs
`AccountToken.purpose` to gain a value and needs *real* email delivery, or
(b) an in-app acceptance endpoint, which is a fifth route and a second surface
in a slice that already has four. Email notifications are explicitly out of
scope here. Shipping an `invited` write with no acceptance path would be
shipping a button whose only effect is a row nobody can use — the same mistake
ADR-026 §6 identified when it refused to give agents a "close" button that set
a field with no consequence.

So `invited` is *handled* everywhere and *written* nowhere:

- The list projection reports it, because a membership in that state can
  already exist in the database.
- Duplicate detection (§8) treats it as an existing membership, so a later
  invitation flow cannot produce a second row for the same person.
- `requireOrganization` refuses it, unchanged.

`invitedByUserId` is populated regardless, so the roster records **who added
whom** from the first day rather than from the day invitations ship.

The `role` accepted here is any role in the catalogue **except `owner`** (§7).

### 4. The target is named by email; the acting identity is never named at all

The body is exactly `{ email, role }`. There is deliberately **no `userId`, no
`organizationId`, no `membershipId`, and no `invitedByUserId`** in this schema
or in any schema in this slice. Zod object schemas strip unrecognized keys
(ADR-007 §6), so a client that posts one has it **stripped, not rejected** —
it never becomes observable to a controller, which is ADR-022 §5's rule
applied to identity exactly as ADR-026 §2 applied it to assignment.

Email is the identifier because it is the only thing a manager knows about a
colleague. It is normalized through `normalizeEmail` — the one place that rule
lives (`user.model.ts`) — before any lookup, so casing and surrounding
whitespace cannot produce a second membership for one person.

The **acting** identity comes from `req.principal.userId` for `invitedByUserId`
and from `req.organizationContext` for the tenant and the caller's role. Three
values a client might hope to influence, none of which has a client-reachable
source.

### 5. A member the server will not add: the same refusal for "no account" and "not entitled"

The lookup is `userRepository.findByEmail(normalizeEmail(email))`, and the
membership is created only for a user who is **`active` and email-verified** —
the identical three-part gate `currentUser.service.ts`, `refresh.service.ts`,
and `organizationOnboarding.service.ts` apply, so a fourth service cannot
drift about who Serviqo still serves.

"No such account" and "an account that may not be served" produce **one
refusal with one message**: `422 MEMBER_NOT_INVITABLE`, *"That email cannot be
added. The person needs a verified Serviqo account before they can join an
organization."*

This is stated as a **policy**, not as an answer about the submitted address —
but it is still distinguishable from success, and that is an enumeration
oracle for "does a verified Serviqo account exist with this email". It is
accepted here, deliberately and with the mitigations named, rather than
papered over:

- The alternative is answering `201` for an address that was added to nothing.
  A manager would believe they had granted access that does not exist, and
  would find out when the colleague could not sign in. Silence fails closed on
  access and fails open on trust, which is the worse trade for a tenant-admin
  surface.
- The oracle is reachable only by a caller who is authenticated,
  email-verified, holds `member.manage`, and is inside a real tenant. ADR-007's
  concern — anonymous enumeration of the user base through registration — is
  untouched; `/auth/register`, `/auth/login`, and `/auth/resend-verification`
  keep their silent responses.
- It is bounded by **its own rate limit class** rather than by the shared
  authenticated-write budget (§12): `memberInvite`, 20 per hour per verified
  user. Probing a list of addresses costs one verified, email-confirmed
  account per twenty guesses per hour, which is not a practical enumeration
  channel.
- The submitted email **never reaches a log line**, on this path or any other
  in this slice (§13). An operator sees `member.add_refused` with a reason and
  the acting user, and cannot reconstruct what was probed.

`422` rather than `404`: the request is well-formed and the route and tenant
both exist; what cannot be processed is the instruction. `404` would also be
the code every unreachable *membership* answers with (§9), and one code
meaning two unrelated things is a code a client cannot branch on.

### 6. Roles are validated against the RBAC catalogue itself, minus `owner`

The role schema is derived from `ROLE_PERMISSIONS`:

```ts
const ASSIGNABLE_ROLES = (Object.keys(ROLE_PERMISSIONS) as MembershipRole[]).filter((r) => r !== "owner");
```

rather than spelled as a literal enum. `agentInbox.validation.ts` spells its
status enum out and says why — `ConversationStatus` is a type with no runtime
value. `ROLE_PERMISSIONS` **is** a runtime value, and it is the authorization
table itself, so deriving from it means a role added to the catalogue is
assignable the moment it has permissions, and a role removed from it stops
being assignable in the same commit. There is no second list of role names to
keep in step.

`owner` is excluded from what a client may submit, in both the add and the
role-change schemas. Granting ownership is **ownership transfer**, and §7 is
why that is not a role write.

An unknown role is a `400 VALIDATION_ERROR` from `validateBody` before any
handler runs — the ordinary boundary, not a special case.

### 7. Owner safety: the owner is not a role you can write, and you cannot act on yourself

Two structural rules, both refusing before any write, and neither of them a
role comparison of the kind §2 rules out.

**a. The owner membership is not a target, and `owner` is not a value.**

- `PATCH …/:membershipId/role` on the membership whose current role is
  `owner` → `409 ORGANIZATION_OWNER_PROTECTED`.
- `DELETE …/:membershipId` on that membership → the same error.
- `role: "owner"` in either body → `400`, because §6's schema does not accept
  it.

The first two protect the invariant `organizationOnboarding.service.ts`
established by write ordering: *a tenant is never unowned*. That service made
it structurally impossible to **create** an unowned organization; nothing
until now could **produce** one, because nothing could touch a membership. An
ownerless organization holds its unique slug forever with nobody able to
administer it, and ADR-016 §3 already recorded that no adoption path exists or
is planned, because "let an authenticated user claim an ownerless
organization" is an account-takeover primitive. So the only safe answer is to
refuse.

The third protects index B. A promotion to `owner` while an owner exists would
be refused by MongoDB as a duplicate key — a `500` for a request the schema
could have refused with a `400`. Refusing it in the schema means the database
constraint is a backstop rather than the error path.

**Ownership transfer is therefore not supported by this slice, and that is
stated rather than implied.** Doing it correctly is a single atomic operation
that demotes one membership and promotes another against a unique partial
index, in a database this project deliberately runs without transactions
(ADR-016 §3: MongoDB transactions need a replica set; development is a
standalone `mongod` and the suites use `MongoMemoryServer`). Approximating it
with two sequential writes has a window in which the tenant has no owner —
precisely the state this section exists to prevent. It gets its own slice, its
own route, and its own permission.

**b. A caller may not change or remove their own membership** →
`409 MEMBER_SELF_MODIFICATION`.

Compared against `req.principal.userId` — the verified subject of the access
token — never against anything in the request. It covers the owner (already
covered by (a), so this is defence in depth on the path that matters most) and
it covers the case (a) cannot see: an admin demoting themselves to `agent` and
losing `member.manage` in the same request, leaving a tenant whose only
remaining manager is an owner who may not be reachable. Self-service departure
is a different operation with a different name ("leave organization") and it
is not in this slice.

### 8. A duplicate add is a conflict, and the unique index is the final authority

`POST …/members` for a person who already has a membership in this tenant —
**in any status**, `active`, `invited`, or `suspended` — answers
`409 MEMBER_ALREADY_EXISTS`.

Safe to answer specifically, and this is the one place §2's catalogue fact
does real work: a caller holding `member.manage` also holds `member.read`, so
they can already fetch the roster this response describes. It discloses
nothing that `GET …/members` would not have.

Detection is a pre-check followed by a caught duplicate-key error, not a
pre-check alone — the pattern `registration.service.ts` established for email
and `organizationOnboarding.service.ts` reuses for slugs. Two concurrent adds
of the same person both find no membership; index A rejects one of them, and
that request answers `409` rather than `500`. The pre-check is a fast path;
**MongoDB is the authority**, and requirement "no duplicate memberships" is
held by the index rather than by a comparison that races.

Including `suspended` in "already a member" is deliberate. Re-adding a
suspended person would either create a second row (impossible — index A) or
silently reactivate them, which is a *reinstatement* dressed as an add. If the
answer should be "reactivate", it should be a request that says so.

### 9. Cross-tenant isolation is produced by the query, not by a comparison

Every membership repository method added here takes `organizationId` as a
**mandatory key**, following ADR-022 §1's discipline exactly. There is no
`findMembershipById(id)` and no unscoped update or delete:

```
findByIdForOrganization(membershipId, organizationId)
listForOrganization(organizationId)
updateRoleForOrganization(membershipId, organizationId, role)
deleteForOrganization(membershipId, organizationId)
```

A membership under another organization returns `null` **identically to one
that does not exist**, so `404 NOT_FOUND` with one message covers: no such
membership, another tenant's membership, and a well-formed id belonging to
nothing. The indistinguishability starts at the query and not at the error it
produces — ADR-025 §10's property, restated for a second resource.

`deleteById`'s existing prohibition stands unchanged. It remains the
compensation-only method aimed by `_id` alone, and removal uses
`deleteForOrganization`, which cannot be aimed outside the caller's tenant at
all.

A malformed `:membershipId` is a `400` before any query, guarding against the
`CastError`-becomes-`500` failure `requireOrganization` and
`agentInbox.controller.ts` both guard against. Safe to answer specifically: it
depends only on the submitted string's shape and never on whether anything
exists.

Above all of it, `requireOrganization` has already refused any caller who is
not an **active** member of an **active** organization. A suspended tenant, a
suspended membership, and an `invited` membership all fail there, before a
member route's handler exists — which is why this slice adds no organization
status check of its own and no membership status check of its own for the
*caller*. Adding one would be a second copy of a rule that already has one
authoritative implementation.

### 10. Removing a member releases their conversations, through the seam ADR-026 built

This is the limitation ADR-026 §15 handed to this slice, and it is closed
inside the removal operation rather than by a sweep somewhere else.

`conversationRepository.releaseAllForUser(organizationId, userId)` clears
`assignedTo` on every conversation in **that tenant** assigned to that user,
and returns the affected documents. The membership service then publishes one
`conversationEvents` event per released conversation, exactly as
`conversationService.claim` and `release` already do — so
`createSocketServer`'s existing subscriber emits `conversation:updated` into
the tenant's inbox room and every connected agent's list re-renders the row as
unassigned, live, with **no new event type, no new room, and no new
subscriber**.

Ordering matters and is deliberate: **the membership is deleted first, then
the assignments are released.** Access revocation is the security-relevant
half and must not be delayed behind bookkeeping. The inverse partial state — a
membership removed while some assignments are still theirs — is exactly the
state that existed before this slice and is inert: the person can no longer
reach the tenant, and the next removal or a manual release resolves it. The
partial state the other ordering produces — assignments cleared while the
person still has access — is the one that reads as a bug to everyone looking
at it.

The release is **best-effort and never fails the removal**, the posture
ADR-022 §10 set for follow-up writes and `login.service.ts` set for
`clearLoginFailures`: the caller's outcome must not change because bookkeeping
did not. A failure is logged as `member.assignment_cleanup_failed` with a
failure *type*, not an error object.

**Role changes also release**, but only when the new role would not hold
`conversation.assign`:

```ts
if (!can(nextRole, "conversation.assign")) await releaseAssignments(...);
```

Under today's catalogue every role holds it, so this branch does nothing —
and it is written anyway, derived from `can()` rather than from a hardcoded
role list, so a future catalogue edit that creates a read-only role does not
silently leave that role holding conversations it can no longer release. The
predicate is unit-tested directly rather than through a role that cannot exist
yet; the integration suite asserts the complement, that a role change under
the current catalogue leaves assignments **intact**, so the premise itself is
covered and fails loudly if the table changes.

`ConversationAlreadyAssignedError`'s workflow limitation from ADR-026 §15 — "an
agent cannot take a conversation from a colleague" — is narrowed rather than
removed by this: a colleague who has *left* no longer strands their queue.

### 11. A role change takes effect on the target's next request, because nothing caches it

No session is revoked, no token is invalidated, and no cache is cleared when a
role changes — because there is nothing to clear. ADR-011 §2 kept `role` out
of the access token; ADR-004 §8 kept it off the session;
`requireOrganization` reads it from the `Membership` document on every single
request (ADR-017 §5).

So a demoted admin's *next* request is evaluated under the new role, with the
old access token still perfectly valid as an *identity*. That is the property
those three decisions were made for, and this slice is its first real
exercise — §2's tests assert it end to end: an agent who could list members as
an admin receives `403` on the request after the demotion, with the same
token.

**Removal** behaves the same way: `requireOrganization`'s membership lookup
returns `null` on the next request and every organization-scoped route answers
`404`. The removed person's *session* survives — they remain a signed-in
Serviqo user who belongs to one fewer organization, which is correct.
`GET /auth/me` stops listing the tenant, so the dashboard's switcher drops it.

### 12. Rate limiting: the existing classes, plus one narrow class for the one route that discloses

- `GET …/members` → `authenticatedRead`, mounted **before**
  `requireOrganization` — ADR-018 §3's placement, so a caller cannot spend
  database lookups probing organization ids they hold no membership in.
- `PATCH …/role`, `DELETE …/:membershipId` → `authenticatedWrite`. Staff
  configuration writes of exactly the shape that class was sized for.
- `POST …/members` → **`memberInvite`**, a new class: 20 per hour, keyed by
  the verified user, `MEMBER_INVITE_LIMIT` / `MEMBER_INVITE_WINDOW_MS`.

The new class exists for §5's disclosure and for nothing else. Reusing
`authenticatedWrite` would put the invite oracle on a 30/hour budget *shared*
with role changes and removals, so a manager doing ordinary team admin would
also be spending the probing budget — the two would be indistinguishable to
the limiter, and tightening one would throttle the other. A separate, tighter
class bounds the probe without touching the ordinary writes. That is the same
reason ADR-019 §11 gave `widgetSession` its own class rather than the session
bucket.

`AUTHENTICATED_WRITE_LIMIT` is **not** widened from inside this feature slice,
consistent with ADR-025 §13 and ADR-026 §12 declining the same move.

The class never reaches a response body (ADR-018 §6). Every refusal is the
same `429` with the same message.

### 13. Logging: ids, roles, counts — never an email, a name, or a credential

Events added by this slice, with their complete field sets:

| event | fields |
| --- | --- |
| `member.listed` | `organizationId`, `actorUserId`, `count` |
| `member.added` | `organizationId`, `actorUserId`, `membershipId`, `targetUserId`, `role` |
| `member.add_refused` | `organizationId`, `actorUserId`, `reason` |
| `member.role_changed` | `organizationId`, `actorUserId`, `membershipId`, `targetUserId`, `previousRole`, `role` |
| `member.role_change_refused` | `organizationId`, `actorUserId`, `reason` |
| `member.removed` | `organizationId`, `actorUserId`, `membershipId`, `targetUserId`, `role`, `releasedConversations` |
| `member.remove_refused` | `organizationId`, `actorUserId`, `reason` |
| `member.assignment_cleanup_failed` | `organizationId`, `targetUserId`, `failureType` |

**No email appears in any of them**, including on the refusal paths where the
submitted address is the thing an operator would most like to see — because
that field is the enumeration channel §5 spent a rate limit class bounding,
and a log is read by people who did not pass `member.manage`. No name either:
ADR-026 §12 already established that a roster name in a log line reaches
readers who did not pass `can(role, "member.read")`, and §16's decision was to
log the id and not the name. This slice follows it without exception.

`role` and `previousRole` **are** logged. ADR-017 §7 already logs `role` on
every permission denial and `createSocketServer` logs it on every agent
connection; it is a category, not personal data, and "who was promoted to
what" is the first question an audit asks.

`reason` is a closed set of internal strings (`unknown_or_unverified_user`,
`already_a_member`, `owner_protected`, `self_modification`,
`membership_not_found`) which reach the log and **never** a response body —
ADR-015 §6 and ADR-017 §6's split, applied a third time.

### 14. Response projection: the roster discloses what `member.read` is for, and stops there

```ts
{ id, role, status, createdAt, user: { id, name, email } }
```

`id` is the **membership** id — the handle the two write routes take (§1) —
and `user.id` is the global `User` id, which the inbox already needs so a
reader can match `assignedTo.id` against a roster row.

`user.email` is included. `member.read` is "See who else works here", the
roster is the surface it names, and a team page that cannot show how to reach
a colleague is not a team page. It is disclosed only to `owner`, `admin`, and
`supervisor` — the roles holding that permission — and never over a socket
(§15), never to an `agent`, and never to a customer.

Absent by construction: `passwordHash` (`select: false` at the schema level,
and this projection is built field by field so it could not carry it anyway),
`failedLoginAttempts`, `lockedUntil`, `emailVerifiedAt`, `invitedByUserId`,
and `organizationId`. The first three are authentication state and belong to
authentication, exactly as `currentUser.service.ts` says of the same fields.
`invitedByUserId` is recorded (§3) and not yet rendered: showing "added by" is
a product decision with no request behind it, and a field in a payload is a
field a client starts depending on. `organizationId` is omitted for the reason
every projection in this codebase omits it — the caller named the tenant in
the URL and the server proved it.

Sorted by role rank (`owner`, `admin`, `supervisor`, `agent`) then by name,
then by membership id. Deterministic for the same reason
`currentUser.service.ts` sorts its memberships: Mongo promises no order, and a
list that reshuffles between loads is one people mis-click.

The `User` documents are fetched with **one** batched
`userRepository.findByIds` call, not one per row — the N+1 every list endpoint
in this codebase is written to avoid.

### 15. No membership event, no membership broadcast

`conversationEvents` is reused for assignment cleanup (§10) because a
conversation's assignment genuinely changed. **No `membershipEvents` module is
created**, and the roster does not update live.

ADR-026 §15 left standing instructions on exactly this point:

> **Two near-identical event modules** now exist (§9). That is deliberate, and
> the third one is where the generalization should be considered.

A third copy of the same twelve lines is what that sentence warns against, and
generalizing the seam properly — a shared `domainEvents` bus with typed topics
— is a refactor of two existing modules plus their subscribers, which is its
own change and does not belong inside a feature slice. So the team page
refetches after its own mutations and on mount, which is correct for a surface
where changes are rare, deliberate, and made by the person looking at it.

There is a second, independent reason not to broadcast the roster: the payload
would carry names and email addresses, and a broadcast has no single reader to
run `can(role, "member.read")` against. That is precisely ADR-026 §10's
argument for keeping `assignedTo` out of the customer's room, and §9's for
keeping the assignee's *name* out of `conversation:updated`. A roster event
would have to either omit everything worth sending or send roster data to a
room whose entry requirement is `conversation.read` — which `agent` holds and
`member.read` deliberately does not.

What **is** live is the consequence that matters: removing a member releases
their conversations and every connected agent sees those rows go unassigned
immediately (§10).

### 16. The dashboard's Team section: permission-aware, keyed by organization, and confirming destruction

A `TeamManagement` section on the dashboard, mounted `key={organizationId}`
beside `WidgetInstallation` and `AgentInbox` — the same discipline ADR-025 §11
set and for the same reason: switching tenants must **discard** one
organization's roster rather than reconcile it into a component that just
finished rendering another's. React tears down the subtree on a key change,
which is the only way to be certain no row from the previous tenant survives
into the new one. Filtering by `organizationId` in an effect would be the
"rely only on frontend filtering" CONTRIBUTING.md forbids.

States, mirroring `AgentInbox`'s: `loading`, `ready`, `error` (retryable), and
`forbidden` — separate because it is the one refusal that will never succeed
on a retry, and an agent seeing "Please try again" for a permission they will
never hold is a UI lying about what is wrong.

The management controls render only when the server-confirmed role holds
`member.manage`, decided in **one place** from the role
`OrganizationSwitcher` already receives from `GET /organizations/:id` — the
role the server resolved on that request, never one the client stored. This is
a **UX affordance, not a boundary**: the server re-proves the permission on
every request, so a hidden control that is un-hidden in a debugger still
receives `403`. The client keeps no permission table; it asks whether this one
role string is `owner` or `admin`, in a single exported predicate, so there is
one place to change when the catalogue changes and no second RBAC model in the
browser.

Removal requires an explicit confirmation naming the person, because it is
irreversible from this surface: re-adding requires the manager to know the
address, and it silently unassigns that person's conversations (§10). Role
changes do not confirm — they are reversible with the same control.

`invited` and `suspended` memberships render with their status visible, so a
manager can see why a colleague cannot get in.

### 17. What this slice does not do

- **No ownership transfer** (§7). The only operation that could leave a tenant
  unowned, and the one that needs an atomicity this database is deliberately
  not configured for.
- **No suspend/reactivate.** `MembershipStatus` supports both and no route
  sets either; removal is the revocation this slice ships.
- **No emailed invitations and no acceptance flow** (§3). Both need real email
  delivery, which is out of scope.
- **No self-service "leave organization"** (§7b).
- **No profile management** — ROADMAP Phase 3's fourth item, which is about a
  `User` and not about a `Membership`.
- **No custom roles.** `PROJECT_CONTEXT.md` §5 anticipates them; §6's schema is
  derived from the catalogue so they cost a table edit rather than a rewrite.
- **No live roster** (§15).
- **No change to any customer or widget path.** No file under
  `modules/widget/`, `modules/customers/`, or `modules/messages/` is touched.

### 18. Known limitations carried forward

- **An organization's owner cannot be changed, removed, or demoted by any
  request** (§7). A tenant whose owner leaves the company has no in-product
  resolution today. This is the most user-visible gap in the slice and it is
  the ownership-transfer slice's to close.
- **`POST …/members` discloses whether a verified Serviqo account exists for a
  submitted email** (§5), bounded by a 20/hour user-keyed class and by
  `member.manage`. The alternative — a silent success — was judged worse.
- **The roster is not live** (§15). Two managers editing the same team see
  each other's changes on their next fetch.
- **Assignment cleanup is best-effort and not transactional** (§10). A crash
  between the delete and the release leaves conversations assigned to a
  departed member — the exact state that existed before this slice, now
  bounded to a crash window instead of being permanent.
- **`memberInvite`'s counters are in-process**, inheriting ADR-018 §2's
  single-process ceiling unchanged: N nodes grant N times the budget.
- **Removing a member does not revoke their sessions** (§11), which is correct
   — they remain a Serviqo user — but it does mean the tenant cannot force a
  departing employee's *other* organizations to sign out, which is not this
  tenant's decision to make anyway.

## Consequences

- `member.read` and `member.manage` stop being table entries and become
  enforced permissions. Every row of `ROLE_PERMISSIONS` is now exercised by at
  least one route, which means the catalogue is a description of the running
  system rather than a plan.
- The `Membership` model gains a lifecycle. It has been the authoritative
  `User ↔ Organization` relationship since ADR-010 and, until now, could only
  be created — by onboarding, once, for the owner. `invitedByUserId` stops
  being a field waiting for a workflow.
- ADR-026's stale-assignment hole closes, and it closes through the seam
  ADR-025 §2 built rather than beside it: a membership operation causes a
  conversation broadcast with no service importing `socket.io` and no
  transport learning what a membership is. That is the third distinct writer
  through that seam and the first from another domain.
- ADR-017 §5's "role is read from the database on every request" acquires a
  test that can actually fail. Until this slice, no request could change a
  role, so the property was true by absence.
- The dashboard gains its first destructive control, and with it the first
  confirmation dialog and the first permission-gated section. §16's single
  exported predicate is the seam every later permission-aware surface reuses
  instead of re-deriving.
- ROADMAP Phase 3 moves from "not started" to "team management and role
  management complete; invitations and profile management deferred". The RBAC
  item it lists was already delivered by ADR-017; what was missing was
  anything that used it.
