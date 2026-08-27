# ADR-028: Organization Ownership Transfer

**Status:** Accepted
**Date:** 2026-08-26
**Phase:** 3 (User / Team / Role management)
**Implements:** ROADMAP.md Phase 3's "Ownership transfer" item
**Closes:** [ADR-027](./027-team-management-and-membership-lifecycle.md) §7a's deferral — "Ownership transfer is therefore not supported by this slice, and that is stated rather than implied … It gets its own slice, its own route, and its own permission." This is that slice. It also makes `OrganizationOwnerProtectedError`'s message — "Transfer ownership first." — true, where until now it named a remedy that did not exist.
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) §7–19 (permission-based authorization, centralized via `can()`/`requirePermission()` — no scattered role checks); [ADR-003](./003-domain-first-server-modules.md) (domain-first modules); [ADR-010](./010-principal-types-organization-users-and-customers.md) §2–3 (a customer holds no membership; `Organization` carries no `ownerUserId`); [ADR-015](./015-access-token-verification-and-current-user.md) §6 (one opaque refusal); [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (an unowned tenant is unrecoverable; MongoDB transactions need a replica set and this project does not run one), §4 (compensation as the no-transaction pattern), §9 (tenant content stays out of logs); [ADR-017](./017-organization-context-and-rbac.md) §1 (the tenant is a path segment and nothing else), §2 (the four gates), §5 (role read from the database on every request), §6 (one opaque refusal; `403` only after membership is proved), §7 (`requirePermission`), §8 (the middleware order), §10 (no permission list in any payload); [ADR-018](./018-rate-limiting-and-security-headers.md) §3–4 (limiter placement and user-keyed classes), §6 (the class never reaches a response body), §8 (disabled limiters keep the mount order), §10 (safe fields only); [ADR-020](./020-widget-installation-configuration-surface.md) (organization-configuration routes on the organization router); [ADR-022](./022-persistent-conversations-and-messages.md) §5 (server-assigned literals, never request input); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §1 (which router a resource belongs on), §10 (cross-tenant ids stay indistinguishable); [ADR-026](./026-conversation-assignment-and-status.md) §2 (the path names the field being changed), §10 (`conversation:updated` reaches the inbox room and never the customer); [ADR-027](./027-team-management-and-membership-lifecycle.md) §4 (the acting identity is never named by the request), §7 (owner safety and self-modification), §8 (the unique index is the final authority), §9 (isolation produced by the query), §10 (releasing assignments, derived from `can()`), §11 (nothing caches a role), §12 (one narrow limiter class per disclosing route), §13 (ids, roles, counts — never an email or a name), §15 (no membership broadcast), §16 (the dashboard's permission-aware Team section); CONTRIBUTING.md ("Never rely only on frontend filtering"; "No business logic in JSX"); SECURITY.md §2 (tenant isolation), §3a (deployment gate status)

## Context

Every part of this slice already exists except the operation itself.

`Membership` has carried `role` since ADR-010 and is the single source of
truth for who owns a tenant. MongoDB enforces the ownership invariant
directly: index B on `{ organizationId, role }` is unique and partial on
`role: "owner"`, so **two owner documents in one organization are impossible
at the storage layer**. `organizationOnboarding.service.ts` makes the
complementary invariant true at creation time by writing the owner membership
*before* the organization, so a tenant can never be born unowned.
`requireOrganization` resolves the tenant from a path segment and reads the
role from the database on every single request, which is what makes a role
change take effect on the target's very next call rather than at token expiry.
ADR-027 shipped the roster, the role-change route, the removal route, the
permission-aware dashboard section, and the confirmation pattern for a
destructive control.

What ADR-027 deliberately did **not** ship is the one membership write that
touches two documents:

> Doing it correctly is a single atomic operation that demotes one membership
> and promotes another against a unique partial index, in a database this
> project deliberately runs without transactions (ADR-016 §3: MongoDB
> transactions need a replica set; development is a standalone `mongod` and
> the suites use `MongoMemoryServer`). Approximating it with two sequential
> writes has a window in which the tenant has no owner — precisely the state
> this section exists to prevent.

That paragraph is the whole problem statement, and the honest answer to it is
not "find an atomic primitive that is not there". It is: **choose which
partial state the window can expose, make that state inert, guard both writes
so concurrency cannot widen it, compensate when the second write does not
land, and write the window down.** §8 and §9 do that, and §10 states the
residual failure mode plainly rather than implying one does not exist.

Three facts shape the rest.

**First, ownership is a `Membership` fact and must stay one.** `Organization`
has no `ownerUserId` and must not gain one — ADR-010 §3 records why, and a
second place recording who owns a tenant is a second thing that can disagree
with index B. This slice adds no field to any model and no collection.

**Second, `owner` and `admin` currently hold identical permissions.**
`permissions.test.ts` asserts it: *"gives owner and admin the same authority
today"*. That assertion becomes false in this slice, deliberately and for the
first time — §2 gives `owner` one permission `admin` does not have, which is
what finally makes `ROLE_PERMISSIONS`'s own comment on `admin` ("Everything
the owner can do except what ownership itself confers") describe the running
system instead of an intention.

**Third, the outgoing owner must land somewhere.** There is no "former owner"
role and there will not be one (§7). The existing catalogue is the whole
vocabulary.

## Decisions

### 1. One route: `POST /organizations/:organizationId/ownership`

```
POST /api/v1/organizations/:organizationId/ownership   { membershipId }
```

Mounted on `createOrganizationRouter`, beside `/:organizationId/widget-config`
— **not** on `createMemberRouter`.

That placement is the substantive call, so it is argued rather than assumed.
ADR-025 §1 set the rule the other routers follow: a resource that is not
organization configuration gets its own router. The roster is such a resource
and got one. **Ownership is not a member of the roster; it is a property of
the tenant.** The question this route answers is "who owns this organization",
the permission that guards it is an `organization.*` one (§2), and the
resource being changed is named by the path with no member segment in it. It
is the same shape as `PUT /:organizationId/widget-config/origins`: the path
names the thing being set, the body carries the value.

`POST` rather than `PUT` or `PATCH`. This is not idempotent in the sense those
verbs promise — replaying it after it succeeded refuses (§9), because the
caller who sent it is no longer the owner.

**The target is a body field, and that is the one convention this slice
departs from.** Every other membership-targeting route in this codebase puts
the target in the path (`…/members/:membershipId/role`). Here the path already
names the resource being changed — the organization's ownership — and there is
exactly one of it, so `…/ownership/:membershipId` would name the *value* in
the path and leave the body empty, which reads as a different resource than it
is. The security property the path-segment convention buys is not lost: §4
shows the tenant is still a path segment and still the only tenant the handler
can reach, and the target is still resolved by a two-key query that cannot be
aimed outside it.

### 2. A new permission, `organization.transfer_ownership`, held by `owner` alone

It joins the `Permission` union and gets exactly one row in
`ROLE_PERMISSIONS`:

```ts
owner:      [ …, "organization.transfer_ownership" ],
admin:      [ … ],            // NOT granted
supervisor: [ … ],            // NOT granted
agent:      [ … ],            // NOT granted
```

This is the first permission in Serviqo's history that separates `owner` from
`admin`, and it is the correct one to be first: transferring ownership is the
only action whose whole content is *ownership itself*. An admin who could
perform it could take the tenant from the person who created it, which is a
privilege-escalation primitive dressed as an administrative convenience.

It follows `permissions.ts`'s stated lifecycle exactly — *"a permission joins
this union in the slice that enforces it"* — and it needs no new mechanism:
`requirePermission("organization.transfer_ownership")` on the route is the
entire authorization decision, and no handler, service, or repository in this
slice compares a role to a literal for the purpose of deciding whether the
caller may act. There is no second RBAC system and no per-route role check
(ADR-002 §7–19).

Naming: the underscore in `transfer_ownership` is a departure from
`organization.manage` / `member.manage`, and is kept because the action is a
verb phrase with no single-word spelling that stays honest —
`organization.transfer` does not say what is transferred, and
`organization.own` is a state rather than an action.

**Consequence, stated so it is not a surprise:** `permissions.test.ts`'s
"owner and admin have the same authority today" assertion is replaced in this
slice with its successor — admin holds every owner permission *except*
`organization.transfer_ownership` — which is a stronger property and one that
fails loudly if a future slice grants it to admin by accident.

### 3. Admins, supervisors, agents, and ordinary members receive the existing 403

`requirePermission` refuses with `403 INSUFFICIENT_PERMISSION` and the
existing generic message, exactly as it does for every other permission. No
new refusal, no new status, no new message, and the required permission is not
named in the response (ADR-017 §6).

That refusal is safe here for the reason ADR-017 §6 gave: by the time
`requirePermission` can run, `requireOrganization` has already proved the
caller holds an active membership in an active organization, so telling them
their role is insufficient discloses nothing they did not already know.

A caller with **no** membership in the organization, a suspended membership,
an invited-but-unaccepted membership, a suspended organization, or an id
belonging to another tenant is refused earlier and more opaquely — `404` from
`requireOrganization` (ADR-017 §2) — and never reaches the permission check at
all.

### 4. Both identities come from the server; neither can be named by the request

The request body is `{ membershipId }` and nothing else.

| Fact | Where it comes from | Why a client cannot supply it |
| --- | --- | --- |
| acting organization | `req.organizationContext.organizationId` | built by `requireOrganization` from the **path segment**, after proving the caller's active membership (ADR-017 §1, §2) |
| acting owner's user id | `req.principal.userId` | the verified subject of the access token (ADR-015) |
| acting owner's membership id | `req.organizationContext.membershipId` | the document `requireOrganization` loaded on **this** request |
| acting owner's role | `req.organizationContext.role` | read from that same document, never from the token (ADR-017 §5) |
| target membership | the body's `membershipId`, resolved by `findByIdForOrganization(membershipId, organizationId)` | the tenant half of that pair is the server's, so the id alone cannot escape the tenant (§5) |

A body carrying `organizationId`, `currentOwnerId`, `userId`, `role`, or
`status` is **stripped by the Zod schema before any handler runs**, not
rejected — the property ADR-007 §6 and ADR-027 §4 rely on, and the stronger of
the two outcomes: a forged field never becomes observable to application code
at all, so there is no branch that could be written to trust it.

This is why "forged `organizationId`", "forged `currentOwnerId`", and "forged
`role`" are not defended against by comparisons. There is nothing to compare;
those values do not exist by the time the service runs.

### 5. Cross-tenant isolation is produced by the query, exactly as ADR-027 §9

The target is resolved by
`membershipRepository.findByIdForOrganization(membershipId, organizationId)` —
two keys, one indexed query, the organization half server-derived.

A membership id belonging to **another organization returns `null` identically
to one that does not exist**, so the refusal is produced by the query missing
rather than by a branch comparing tenants. No line in this slice reads
`membership.organizationId` and compares it to anything, because there is no
point in the flow at which a document from another tenant is in hand.

Refused with `404 NOT_FOUND` and ADR-027's existing `MemberNotFoundError`
message, so "no such membership", "another tenant's membership", and
"well-formed id belonging to nothing" are one answer.

A malformed `membershipId` is refused by the schema as `400 VALIDATION_ERROR`
before any query runs — the same `OBJECT_ID_PATTERN` guard
`requireOrganization`, `member.validation.ts`, and `agentInbox.controller.ts`
each apply, for the same reason: a `CastError` reaching `errorHandler` becomes
a generic `500`, reporting a client's mistyped id as a server fault. That
`400` depends only on the submitted string's shape and never on whether
anything exists, so it is not an existence oracle.

### 6. What the target must be, and one refusal per reason

Checked in this order, all before any write:

1. **Resolvable inside this tenant** → else `404 NOT_FOUND` (§5).
2. **Not the acting owner's own membership** → else
   `409 OWNERSHIP_TRANSFER_SELF_TARGET`.
3. **Membership `status === "active"`** → else
   `409 OWNERSHIP_TRANSFER_TARGET_INVALID`.
4. **The `User` it points at exists, is `active`, and has a verified email** →
   else the same `409 OWNERSHIP_TRANSFER_TARGET_INVALID`.

On (2): "transfer to yourself" and "transfer to someone who is already the
owner" are the **same condition**, not two. Index B guarantees at most one
owner, and §2 guarantees the caller is it — so the only membership in this
tenant whose role is `owner` is the caller's own. One check covers both, and
the message says the useful half: you already own this organization.

On (3): `invited` has not been accepted and `suspended` has been revoked.
`requireOrganization` refuses both for a *caller*; handing a tenant to someone
who cannot sign into it would manufacture the unowned-in-practice state §8
exists to prevent, one step removed.

On (4): the same three-part gate `currentUser.service.ts`,
`refresh.service.ts`, `organizationOnboarding.service.ts`, and
`member.service.ts` apply — exists, active, verified. Five services, one
definition of who Serviqo still serves. A suspended user with a stale active
membership is exactly the case this catches.

(3) and (4) share one error and one message on purpose. Both mean "that person
cannot receive this", the remedy is the same (pick someone else, or fix their
account first), and splitting them would let a caller distinguish "membership
suspended" from "account suspended" for no benefit they can act on.

All three `409`s are **specific rather than opaque**, and safely so, for
ADR-027 §8's reason applied one step further: `organization.transfer_ownership`
is held only by `owner`, who also holds `member.read`, so this caller can
already fetch the roster that shows every fact these refusals describe. They
disclose nothing `GET …/members` would not.

### 7. The previous owner becomes `admin` — an existing role, chosen deliberately

`admin`, and this is the decision ADR-027 §7 left open.

- **`ROLE_PERMISSIONS` already says so.** `admin` is documented as "Everything
  the owner can do except what ownership itself confers." After §2 that is
  *literally* the permission difference: `owner` = `admin` +
  `organization.transfer_ownership`. Demoting to `admin` is therefore the
  transition that changes exactly one capability — the one being transferred —
  and nothing else.
- **Anything lower is a second, unasked-for action.** `supervisor` and `agent`
  do not hold `member.manage` or `organization.manage`, so demoting to either
  would silently strip the outgoing owner of the ability to correct a mistake
  — including the ability to reach the new owner through the product. A
  transfer that also locks the transferrer out is two decisions wearing one
  button.
- **A new "former owner" role is refused.** It would be the second ownership
  vocabulary this slice is forbidden to create, and it would need a row in
  `ROLE_PERMISSIONS`, a rank in `ROLE_RANK`, a place in `ASSIGNABLE_ROLES`,
  and a meaning in every future permission decision — all to encode a fact
  already recorded by the transfer's log line.
- **Removing the previous owner's membership entirely is refused.** Transfer
  and departure are different operations; "leave organization" is named in
  ADR-027 §7b as its own future slice and is explicitly out of scope here
  (§17).

Written as a single named constant, `PREVIOUS_OWNER_ROLE`, in one place. Not
derived by a "largest remaining permission set" computation: that would be
clever, would silently re-target if the catalogue changed, and would make the
answer to "what happens to me if I transfer?" a thing you compute rather than
read.

The dashboard states it before confirming (§16), because a person handing over
their organization is entitled to know exactly what they will be afterwards.

### 8. The transfer: two guarded writes, ordered so the exposed partial state is the inert one

**There is no transaction, and none is invented.** ADR-016 §3 established that
MongoDB transactions require a replica set, that development runs a standalone
`mongod`, and that the suites use `MongoMemoryServer`. Introducing a session-
and-transaction abstraction here would either fail at runtime in the
environment the project actually runs in, or become a code path no test ever
exercises — the unexercised-security-surface failure mode `accessToken.ts`
named when it declined to write a verifier before its first caller. Instead
this slice uses the pattern ADR-016 §4 already established for exactly this
situation: **ordered writes, each guarded, with compensation.**

The sequence, in the service:

```
1. demote    findOneAndUpdate({ _id: ownerMembershipId, organizationId, role: "owner" },
                              { $set: { role: PREVIOUS_OWNER_ROLE } })
             null → 409 OWNERSHIP_TRANSFER_CONFLICT   (someone else won; nothing written)

2. promote   findOneAndUpdate({ _id: targetMembershipId, organizationId,
                                status: "active", role: { $ne: "owner" } },
                              { $set: { role: "owner" } })
             null or throw → COMPENSATE, then 409 OWNERSHIP_TRANSFER_CONFLICT

3. verify    countOwners(organizationId) === 1, logged with the success line
```

Five properties, each load-bearing:

**a. Demote first, because the ownerless window is the survivable one.**
Promote-first is not merely worse, it is *impossible*: index B rejects a second
owner document, so the promotion would fail with a duplicate key while the
tenant still has its original owner. Every ordering MongoDB will accept passes
through a moment with zero owners. This is not a choice between "a window" and
"no window" — it is a choice between the ownerless window and nothing working
at all, and saying so is more useful than implying an alternative was
rejected.

**b. Every filter is a precondition, so concurrency cannot produce two
transfers.** `role: "owner"` in step 1 is the concurrency guard: two
simultaneous transfers both try to demote the same single owner document, and
MongoDB's per-document atomicity means **exactly one matches**. The loser
matches nothing, writes nothing, and answers `409
OWNERSHIP_TRANSFER_CONFLICT`. It cannot proceed to step 2, so it cannot
promote a second target. The guard is in the write itself rather than in a read
that preceded it — the same property `updateRoleForOrganization` relies on, and
the reason a read-then-write would be wrong here.

`status: "active"` and `role: { $ne: "owner" }` in step 2 re-assert §6's checks
*as part of the write*, so a target suspended in the microseconds since §6 read
it is not promoted.

One thing those filters deliberately do **not** do, stated because it is easy
to assume otherwise: a filter constrains the document being *matched*, never
the collection. `role: { $ne: "owner" }` proves this row is not already the
owner; it says nothing about any other row. If some other membership in the
tenant still holds `owner`, step 2 matches its target and **index B rejects the
write with a duplicate key**. That is the design rather than a gap — index B is
the final authority, the same standing ADR-027 §8 gives index A — and it is why
step 2 is wrapped in a `try`: a throw and a `null` mean the same thing to the
caller, and both compensate. In the ordinary flow it cannot arise, because
step 1 vacated the owner slot and its own guard proved that it did.

**c. The ownerless window is inert.** During it — bounded by one database
round-trip — the tenant has zero owner documents. What that does and does not
affect:

- `requireOrganization` is unaffected: it proves membership, membership status,
  organization existence, and organization status, and has no opinion about
  ownership.
- Every other route is unaffected: no route besides this one consults
  `role === "owner"` for an authorization decision.
- **Nobody holds `organization.transfer_ownership` during the window**, so no
  *second* transfer can even begin inside it. The window closes itself against
  the operation that would compound it.
- The roster momentarily renders the previous owner as `admin` and no row as
  `owner`. Cosmetic, sub-request-duration, and not observable to any caller
  whose read did not interleave.
- Nothing is deleted, no access is granted, and no credential changes. There is
  no state in the window from which an attacker gains anything.

**d. A failed promotion is compensated, not left.** If step 2 matches nothing
or throws, the service restores the previous owner with
`findOneAndUpdate({ _id: ownerMembershipId, organizationId, role: PREVIOUS_OWNER_ROLE },
{ $set: { role: "owner" } })` — itself guarded, so it cannot overwrite a role
that has since changed, and index B would refuse it outright if an owner
somehow existed. The caller receives `409 OWNERSHIP_TRANSFER_CONFLICT` and the
organization is exactly as it was.

If the compensation *itself* fails, that is logged at `error` with a distinct
event and the request still fails. §10 states what is then true.

**e. The post-condition is verified and logged.** Step 3 counts owner documents
in the tenant and logs the count with the success line. Index B already makes
`> 1` impossible, so this is not defence against a duplicate — it is the
assertion that makes "exactly one owner" a fact the log records on every
transfer, and the thing the integration suite reads to prove it.

New repository methods, each as narrow as the ones around them
(`userRepository`'s rule, restated in `membershipRepository`'s header):
`demoteOwner`, `promoteToOwner`, `restoreOwner`, `countOwners`. Deliberately
**not** a general `update(id, patch)` — a method that can write any field is a
method that can write `organizationId` by accident.

### 9. Concurrency, restated as the three cases

| Two requests | Outcome |
| --- | --- |
| Same owner, two different targets, simultaneously | One demote matches, one does not. Exactly one transfer completes; the other answers `409 OWNERSHIP_TRANSFER_CONFLICT`. Exactly one owner after. |
| Same owner, the same target, twice (a double-click) | Identical: the second matches nothing at step 1 and answers `409`. |
| Transfer racing an unrelated member write | Unaffected. `assertWriteable` in `member.service.ts` refuses any operation aimed at a membership whose role is `owner`, and both writes here are guarded on the role they expect to find. |

**Repeat transfers are refused rather than made idempotent.** A second
identical request sent *after* the first has settled no longer comes from the
owner, so `requirePermission` refuses it with `403` before the service runs.
That is the correct answer: the operation's precondition is "you are the
owner", and it stopped being true because the first request succeeded. A
silent `200` would tell the caller they did something they did not do.

### 10. Consistency guarantees and the failure window, stated plainly

**What is guaranteed unconditionally, by MongoDB and not by this code:**

- **Never two owners.** Index B is unique and partial on `role: "owner"`. No
  sequence of requests, crashes, or races can produce a second owner document
  in one organization. This holds even if every line of this slice were wrong.
- **Never a partial promotion.** Each `findOneAndUpdate` is atomic on its own
  document.

**What is guaranteed by this slice's guards:**

- **Never two concurrent transfers.** §8b.
- **The organization is never left ownerless by a refusal.** Every refusal in
  §6 happens before any write; a step-2 failure compensates.

**The residual failure window, in full:**

Between step 1 and step 2 the organization has **zero owner memberships**. If
the Node process is killed, the database becomes unreachable, or the connection
is severed *in that window* — after the demote is durable and before the
promote and its compensation can run — the organization is left with no owner.

- **Duration:** one database round-trip. On the topology this project runs
  (application and `mongod` co-located, no replica set), single-digit
  milliseconds.
- **Reachability:** requires a process-level or network-level fault inside that
  specific window, on the rarest write in the product, bounded to five attempts
  per hour per user (§11).
- **What the state is:** a tenant whose previous owner is now `admin` — so they
  retain `organization.manage`, `member.manage`, both conversation
  permissions, and full access to the tenant — and in which **nobody** holds
  `organization.transfer_ownership`. Access is not lost, data is not lost, the
  inbox works, the roster works, and members can still be managed. The single
  lost capability is transferring ownership again.
- **What it is not:** it is *not* ADR-016 §3's unrecoverable orphan, which was
  an organization with no membership at all and therefore nobody who could
  reach it. Here every membership survives and the tenant remains fully
  administrable.
- **Recovery:** operator-side, by setting the intended membership's role to
  `owner` — a single write that index B still protects. **No self-service
  adoption path is added, and none should be**: ADR-016 §3 already recorded
  that "let an authenticated user claim an ownerless organization" is an
  account-takeover primitive, and that reasoning does not weaken because the
  window got smaller.
- **What would remove it:** a MongoDB replica set and a transaction around the
  two writes. That is a deployment change, not a code change, and it is
  recorded in SECURITY.md §3a beside the other single-node gates
  (`MemoryStore` rate limiting, `trust proxy`) rather than being solved with a
  transaction abstraction today's environment cannot execute.

This section exists because ADR-027 §7 refused to ship the operation without
it. The window is accepted, bounded, logged, and written down — which is a
different thing from being unnoticed.

### 11. Rate limiting: one new class, through the existing factory

`ownershipTransfer` — **5 per hour, keyed by the verified user** — built by
`createLimiter` in `lib/rateLimit`, with the same store, the same envelope, the
same standards-track headers, and the same safe-fields-only logging as every
other class. No separate limiter, no ad-hoc counter, no new mechanism; the
class name is added to `RateLimitClass`, the limits to `config/constants.ts`,
and a passthrough to `createDisabledRateLimiters` so the mounted middleware
order is identical under test and in production (ADR-018 §8).

Its own class rather than `authenticatedWrite`, for ADR-027 §12's reason
applied to a sharper case: this is the most destructive operation in the
product and the rarest. Sharing the 30/hour write budget would mean ordinary
widget-config edits could exhaust the transfer budget and vice versa, and would
make "someone is repeatedly attempting ownership transfers" invisible in the
limiter's own signal. Five per hour is far above any real need — a person
transfers an organization approximately once — and far below what any
brute-force or thrash pattern requires.

Mounted **before** `requireOrganization`, matching ADR-018 §3's placement
everywhere else, so a caller cannot spend database lookups probing organization
ids they hold no membership in.

The refusal is the existing `429 TOO_MANY_REQUESTS` with the existing generic
message. The class name reaches the log and never the response body
(ADR-018 §6).

### 12. Logging: ids, roles, and a count — never a name, an address, or a credential

Every line in this slice carries only: `event`, `reason` (refusals only),
`organizationId`, `actorUserId`, `previousOwnerMembershipId`,
`previousOwnerRole`, `newOwnerMembershipId`, `newOwnerUserId`, `ownerCount`,
`releasedConversations`, and `failureType` on a compensation failure. That is
the complete field set.

Never logged, here or anywhere: passwords, access tokens, refresh tokens,
widget tokens, widget keys, email addresses, personal names, message bodies,
`Authorization` headers, cookies, or request bodies. This is ADR-016 §9 and
ADR-027 §13 restated for a third surface, and the integration suite asserts it
against captured log output rather than trusting the assertion.

Events:

| Event | Level | When |
| --- | --- | --- |
| `organization.ownership_transferred` | `info` | success; carries `ownerCount` from §8e |
| `organization.ownership_transfer_refused` | `info` | every §6 refusal and the §8b conflict, distinguished by `reason` |
| `organization.ownership_transfer_compensated` | `info` | a step-2 failure was rolled back successfully |
| `organization.ownership_transfer_compensation_failed` | `error` | §10's window was entered and not closed — the one line an operator must be able to alert on |

`info` rather than `warn` for the compensated line, and the reason is a real
constraint rather than a preference: `AuthLogger` — the structural logger type
eight services share, so a controller can pass `req.log` and a test can pass a
capture function — declares `info` and `error` only. Widening it for one line
would edit every existing double that writes `satisfies AuthLogger`. A
successful compensation is also, correctly, an `info` event: the invariant
held, the caller was refused cleanly, and nothing needs attention. The line
that needs attention is `error`, and it is the only one.

The `reason` values — `membership_not_found`, `self_target`,
`membership_not_active`, `user_not_eligible`, `ownership_changed` — exist in
the log and reach **no** response body, the split ADR-015 §6, ADR-017 §6, and
ADR-027 §13 each established.

### 13. Conversation assignments: derived from `can()`, and today a no-op

ADR-027 §10 releases a member's conversation assignments when a role change
takes away `conversation.assign`. The same rule is applied here to the outgoing
owner, **derived from `can(PREVIOUS_OWNER_ROLE, "conversation.assign")` rather
than from a hardcoded role list**, and through the same
`conversationRepository.releaseAllForUser` + `conversationEvents.publish` seam
so a future release would reach connected agents with no new event type.

Under today's catalogue every role holds `conversation.assign`, so
`owner → admin` releases nothing, and the incoming owner only *gains*
permissions, releasing nothing either. The code is written anyway, for ADR-027
§10's stated reason: a future read-only role must not silently keep holding
conversations it can no longer release. The integration suite therefore asserts
the **complement** — that a transfer leaves both parties' assignments intact —
which covers the premise and fails loudly if the table changes.

Consequently this slice publishes **no** domain event in practice and adds no
socket traffic. §14 says why that is the right answer rather than an omission.

### 14. No ownership event, no broadcast — ADR-027 §15's reasoning, unchanged

ADR-027 §15 declined a roster broadcast because a broadcast has no single
reader to run `can(role, "member.read")` against. Every word of that applies to
ownership, and more sharply: who owns a tenant is staff-only information, the
inbox room contains every connected agent regardless of role, and there is no
room whose membership is "roles holding `member.read`".

**No customer receives anything.** The customer-facing rooms carry conversation
and message events only (ADR-026 §10), no service in this slice touches
`conversationEvents` on the success path, and nothing here imports `socket.io`.
A staff ownership change is invisible to every widget session, and the
integration suite asserts it by holding an open customer socket across a
transfer.

The dashboard refetches instead (§16).

### 15. Response projection: two membership ids and two roles, and nothing else

```json
{ "data": { "previousOwner": { "id": "…", "role": "admin" },
            "newOwner":      { "id": "…", "role": "owner" } } }
```

`id` is the **membership** id. No name, no email, no user id, no organization
echo, no permission list.

The caller holds `member.read` and could fetch all of it — so this is not
withholding secrets, it is declining to widen a payload. The client already
rendered the roster it selected from and knows the name; ADR-017 §10 already
refused to put a permission list in any payload, "because a client that
branches on it would be a client authorizing itself"; and the UI refetches the
roster and the organization context regardless (§16), so anything richer here
would be data with no reader.

The existing envelope (`success`) and the existing error envelope are reused
unchanged. Three new error classes are added because three new refusals are
thrown — `OwnershipTransferSelfTargetError` (409
`OWNERSHIP_TRANSFER_SELF_TARGET`), `OwnershipTransferTargetInvalidError` (409
`OWNERSHIP_TRANSFER_TARGET_INVALID`), and `OwnershipTransferConflictError` (409
`OWNERSHIP_TRANSFER_CONFLICT`) — each with one message, each thrown by this
slice, following `lib/errors/index.ts`'s standing rule that "only the error
classes an existing slice actually throws live here". `404 NOT_FOUND` reuses
ADR-027's `MemberNotFoundError` rather than adding a fourth.

### 16. The dashboard: owner-only, explicit about consequences, and confirmed

Inside the existing Team section (ADR-027 §16), a **Transfer ownership** block,
rendered only when `canTransferOwnership(role)` — one exported predicate beside
`canManageMembers`, in the same file, answering one question about one
server-confirmed role string.

It is a **UX affordance and never a boundary**, restated because it matters
most here: the server re-proves `organization.transfer_ownership` on every
request from the `Membership` document it reads on that request, so the block
un-hidden in a debugger still receives a `403`. And it is *not* a client-side
copy of `ROLE_PERMISSIONS` — a permission table in the browser is a second
authorization model that can disagree with the first.

Behaviour:

- **Eligible members only** in the picker: `status === "active"`,
  `role !== "owner"`, and a resolved account. Filtered from the roster the
  section already fetched, so no extra request and no additional disclosure —
  and the current owner is not selectable because they are not in the list.
- **Says what it does, before it does it.** The block states in words that the
  chosen person becomes the owner and that the reader becomes an admin (§7),
  rather than calling itself "irreversible" and leaving the reader to guess
  what changes.
- **Two-step confirmation naming the person**, following ADR-027 §16's removal
  pattern — one confirmation open at a time, and the confirming text names who
  is receiving ownership rather than asking "are you sure?" about nothing in
  particular.
- **Loading, validation, authorization, conflict, and success states**, mapped
  to the client's own words. The server's message text is never rendered,
  matching how `useTeamMembers` and `useAgentInbox` treat every other failure.
- **Refreshes both the roster and the organization context on success.** The
  roster refetch shows the new owner; the context refetch is what makes the
  outgoing owner's owner-only controls disappear — including this block —
  because `OrganizationSwitcher` re-reads the server-confirmed role from
  `GET /organizations/:id`, which resolves it from the database on that
  request. Nothing about standing is stored, remembered, or inferred
  client-side, and the new owner sees their owner controls on their next
  context load with no re-login required, because nothing caches a role
  (ADR-017 §5, ADR-027 §11).

### 17. What this slice does not do

- **No self-service "leave organization".** Named in ADR-027 §7b as its own
  operation with its own authorization, and still is.
- **No organization deletion.** Unrelated, and destructive in a way transfer is
  not.
- **No membership suspend/reactivate route.** `MembershipStatus` still supports
  both and still no route sets either.
- **No invitation email and no notification to the incoming owner.** There is
  no real email delivery in this project — the console provider is a
  development affordance — and inventing one here would be a second slice
  riding on this one. The new owner learns from the roster.
- **No audit-trail collection.** The log lines in §12 are the record. A
  queryable audit surface is Phase 18's "System logs and audit trails".
- **No `Organization.ownerUserId`, no second ownership store, no new role, no
  role cache, no client-side permission table, no transaction abstraction, no
  tickets, no AI, no Redis, no Docker.**

### 18. Known limitations carried forward

1. **§10's ownerless window.** Bounded, inert, logged, operator-recoverable,
   and removed by a replica set rather than by code. Recorded in SECURITY.md
   §3a beside the other single-node deployment gates.
2. **A compensation failure needs an operator.**
   `organization.ownership_transfer_compensation_failed` is the alertable line;
   nothing self-heals, and deliberately so.
3. **No notification reaches the incoming owner.** They find out from the
   roster or from the person who transferred it.
4. **The previous owner's role is not remembered as "was owner".** If the
   transfer was a mistake, reversing it is a fresh transfer from the new owner
   — which is correct, because it needs the new owner's consent.
5. **ADR-027 §18's limitations are unchanged**, except that
   `OrganizationOwnerProtectedError`'s "Transfer ownership first." now names a
   route that exists.

## Consequences

- `owner` and `admin` stop being permission-identical for the first time.
  `ROLE_PERMISSIONS`'s description of `admin` — "Everything the owner can do
  except what ownership itself confers" — becomes a statement about the running
  system rather than an intention, and the catalogue finally encodes what
  ownership *is* instead of only who holds the role name.
- ADR-027 §7's deferral closes, and the remedy
  `OrganizationOwnerProtectedError` has been naming since that slice becomes
  reachable.
- The project acquires its first documented **multi-document consistency
  boundary**. Every previous write was single-document or compensable without
  an exposed invariant gap; this one has a real window, and §10 is the template
  for how the next such operation states its own.
- MongoDB's index B stops being only a backstop and becomes the concurrency
  primitive the operation is built on. The guard `role: "owner"` in the demote
  filter is what makes "exactly one transfer wins" a property of the database
  rather than of a comparison that races.
- The dashboard gains its first **owner-only** surface, and with it the second
  permission predicate. `canManageMembers` and `canTransferOwnership` sit in
  one file, which is the seam every later permission-aware section reuses.
- ROADMAP Phase 3's "Ownership transfer" item moves from open to complete,
  leaving suspend/reactivate, invitations, and profile management as the
  phase's remainder.
