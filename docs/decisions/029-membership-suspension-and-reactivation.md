# ADR-029: Membership Suspension and Reactivation

**Status:** Accepted
**Date:** 2026-08-26
**Phase:** 3 (User / Team / Role management)
**Implements:** ROADMAP.md Phase 3's "Suspend / reactivate a membership" item
**Closes:** [ADR-027](./027-team-management-and-membership-lifecycle.md) §17's standing gap — "`MembershipStatus` supports `active`, `invited`, and `suspended`; no route sets either of the last two." This is the slice that gives `suspended` a writer. It also closes the **live-socket revocation gap** (§9) that ADR-027 §10's removal path shipped silently: a revoked member's already-open agent socket kept receiving the tenant's traffic until it happened to disconnect.
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) §7–19 (permission-based authorization; no scattered role checks); [ADR-010](./010-principal-types-organization-users-and-customers.md) §2 (a customer holds no membership); [ADR-015](./015-access-token-verification-and-current-user.md) §6–7 (one opaque refusal; a valid signature identifies but does not entitle); [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (an unowned tenant is unrecoverable), §9 (tenant content stays out of logs); [ADR-017](./017-organization-context-and-rbac.md) §1 (the tenant is a path segment), §2 (the four gates — including the `status === "active"` one this slice finally exercises), §5 (role read from the database on every request), §6 (one opaque refusal; `403` only after membership is proved), §7 (`requirePermission`), §8 (the middleware order); [ADR-018](./018-rate-limiting-and-security-headers.md) §3–4 (limiter placement and user-keyed classes), §6 (the class never reaches a response body), §10 (safe fields only); [ADR-022](./022-persistent-conversations-and-messages.md) §5 (server-assigned literals, never request input); [ADR-023](./023-socket-io-realtime-transport.md) §12 (declining to design a seam before its second consumer); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §2 (the domain-event seam), §8–9 (the agent handshake and the inbox room), §10 (cross-tenant ids stay indistinguishable); [ADR-026](./026-conversation-assignment-and-status.md) §2 (the path names the field being changed), §9 (`conversationEvents`), §10 (`conversation:updated` reaches the inbox room and never the customer), §15 (the stale-assignment hole); [ADR-027](./027-team-management-and-membership-lifecycle.md) §1 (four member routes; why `/role` is its own route), §3 (`invited` is reserved for the email-backed flow), §4 (the acting identity is never named by the request), §7 (owner protection and self-modification), §9 (isolation produced by the query), §10 (releasing assignments through the seam), §11 (nothing caches a role; removal does not revoke sessions), §12 (limiter classes), §13 (ids, roles, counts — never an email or a name), §14 (the roster projection), §15 (no membership broadcast), §16 (the dashboard's permission-aware Team section), §17–18 (what it did not do); [ADR-028](./028-organization-ownership-transfer.md) §2 (`organization.transfer_ownership`, owner-only), §4 (server-derived identity), §7 (the previous owner becomes `admin`), §8 (guarded writes as preconditions); CONTRIBUTING.md ("Never rely only on frontend filtering"; "No business logic in JSX"); SECURITY.md §2 (tenant isolation), §3a (deployment gate status)

## Context

`MembershipStatus` has had three values since ADR-010 and two of them have
never been writable. `membership.model.ts` declares
`"active" | "invited" | "suspended"`; ADR-027 §3 reserved `invited` for an
email-backed flow that does not exist yet and shipped every membership as
`active`; and ADR-027 §17 listed the remainder plainly:

> **No membership suspend/reactivate route.** `MembershipStatus` still
> supports both and still no route sets either.

The striking thing about building it is **how little has to be added**. The
authorization gate that makes suspension mean anything is already written, in
two places, and has been since ADR-017:

- `requireOrganization` proves four things per request, and the second is
  `membership.status === "active"` — a non-active membership is refused with
  the same opaque `404` an outsider gets (ADR-017 §2, §6).
- `socketAuthentication.ts` applies the identical gate in the agent handshake
  branch (ADR-025 §9).

Neither reads a cache. `requireOrganization` re-reads the `Membership`
document on **every single request**, which is the property ADR-017 §5 chose
deliberately and ADR-027 §11 first got to test when roles became changeable.
So the entire answer to "suspension must take effect immediately, without
re-login, without a cached status" is: **write `status: "suspended"` and
change nothing else.** §8 records that as a decision rather than letting it
look like an omission.

What is genuinely new is smaller and sharper than the endpoint:

**First, a suspended member with an open socket is still receiving the
tenant's traffic.** Both gates above run at *request time* and *connect time*.
The Socket.IO fan-out in `createSocketServer.ts` is room-based and performs
**zero** membership lookups per event — by construction, because re-proving
membership per broadcast would put a database round-trip on every message.
An agent whose membership is suspended therefore keeps receiving
`message:new` and `conversation:updated` for as long as their socket happens
to stay open. That is not a theoretical gap: suspension exists precisely to
cut access *now*, and a feature whose name promises that must not leave a
live channel streaming customer messages to the person it just revoked.
ADR-027's removal path has the same hole and did not name it. §9 closes it
for both.

**Second, a suspended member's conversations must not be stranded.**
ADR-026 §15 described the failure mode and ADR-027 §10 closed it for removal.
Suspension produces exactly the same state — someone holding conversations
they can no longer reach — so it takes exactly the same cleanup, through
exactly the same seam.

**Third, the owner must never be suspendable.** ADR-016 §3 established that an
unowned tenant is unrecoverable and ADR-027 §7a made the owner un-removable
and un-demotable. A *suspended* owner is a fourth way to reach the same dead
end — a tenant with an owner who cannot sign into it — and §7 refuses it with
the error that already exists for the other three.

## Decisions

### 1. One route: `PATCH …/members/:membershipId/status`

```
PATCH /api/v1/organizations/:organizationId/members/:membershipId/status
      { "status": "suspended" | "active" }
```

The fifth route on `createMemberRouter`, beside `PATCH …/:membershipId/role`,
and shaped identically: **the path names the field being changed and the body
carries the value** — ADR-026 §2's form, which `PATCH …/conversations/:id/status`
already uses for the same reason.

**One route rather than `/suspend` and `/reactivate`.** ADR-027 §1 drew the
line precisely:

> Keeping them separate means the next thing a membership can change —
> suspension, ownership transfer — arrives as its own route with its own
> permission rather than as a discriminator in a body doing authorization
> work.

The test that paragraph implies is whether the body value decides
*authorization*. Here it does not: suspending and reactivating both require
`member.manage` and nothing else, so `status` selects a *transition*, not a
permission. A `/suspend` and a `/reactivate` route would be two endpoints with
one guard, one service, and one set of refusals — the duplication ADR-026 §7
refused when it declined a separate `/reopen` route because "'open' and
'closed' are one field and a second endpoint would be a second name for one
write."

Ownership transfer went the other way (ADR-028 §1) and that remains right: it
needed a *different permission*, which is the thing that actually justifies a
separate surface.

`PATCH` rather than `POST`, matching `/role`: this edits a field of an
existing resource.

### 2. `member.manage`, and the catalogue is not touched

`requirePermission("member.manage")` — the same permission `/role` and
`DELETE` already require. `owner` and `admin` hold it; `supervisor` holds
`member.read` only; `agent` holds neither.

No permission is added. A `member.suspend` would be a row identical to
`member.manage`'s for every role in the catalogue, which is the "anticipated
rather than enforced" shape ADR-026 §3 rejected for `conversation.close` and
`permissions.ts` states as its own rule. Adding one would also be the second
RBAC system this project has refused four times.

So: a supervisor receives `403 INSUFFICIENT_PERMISSION`, an agent receives the
same, and a caller with no active membership in the tenant never reaches the
permission check at all — `requireOrganization` answers `404` first
(ADR-017 §6).

### 3. A request may name `active` or `suspended`, and never `invited`

The schema accepts exactly two values.

`invited` is refused at the boundary, for ADR-027 §3's reason unchanged: an
invitation is *accepted by the invitee*, and a manager writing `invited` onto
an active membership would be manufacturing a pending invitation nobody sent
and nobody can accept. When the email-backed flow ships it will own that
value, and it will not reach it through this route.

The two values are **spelled out** rather than derived. `MembershipRole` could
be derived from `ROLE_PERMISSIONS` because that table is a runtime value
(ADR-027 §6); `MembershipStatus` is a TypeScript type with no runtime
counterpart, so there is nothing to derive from — the same situation
`agentInbox.validation.ts` documents for `ConversationStatus`. A `satisfies`
annotation ties the literal list back to the type, so a fourth status added to
the model fails to compile here until this file decides whether a request may
name it.

### 4. Every identity comes from the server; the body carries `status` alone

| Fact | Where it comes from | Why a client cannot supply it |
| --- | --- | --- |
| acting organization | `req.organizationContext.organizationId` | built by `requireOrganization` from the **path segment**, after proving an active membership (ADR-017 §1–2) |
| acting user | `req.principal.userId` | the verified subject of the access token |
| acting role | `req.organizationContext.role` | read from the membership document on **this** request (ADR-017 §5) |
| target membership | the **path** segment, resolved by `findByIdForOrganization(membershipId, organizationId)` | the tenant half of that pair is the server's (§5) |
| target's current status | the loaded document | never the client's claim about it (§6) |

A body carrying `organizationId`, `userId`, `membershipId`, `role`, or
`invitedByUserId` is **stripped by the Zod schema before any handler runs**
(ADR-007 §6, ADR-027 §4, ADR-028 §4). A forged field never becomes observable
to application code, which is why no handler, service, or repository in this
slice contains a comparison defending against one — there is nothing to
compare.

Note in particular that the request never states the *current* status. "Only
an active membership may be suspended" is checked against the document the
server loaded, never against a client's assertion about what it was.

### 5. Cross-tenant isolation is produced by the query, exactly as ADR-027 §9

The target is resolved by
`membershipRepository.findByIdForOrganization(membershipId, organizationId)` —
two keys, one indexed query, the organization half server-derived.

A membership id belonging to another organization returns `null`
**identically** to one that does not exist, so the refusal is produced by the
query missing rather than by a branch comparing tenants. No line in this slice
reads `membership.organizationId` and compares it to anything.

Refused with `404 NOT_FOUND` and ADR-027's existing `MemberNotFoundError`
message. A malformed `:membershipId` is a `400 VALIDATION_ERROR` from the
controller's existing `requireWellFormedMembershipId` guard, before any query
runs — it depends only on the submitted string's shape, so it is not an
existence oracle.

### 6. The transition table, and one error for every transition that is not one

Checked in this order, all before any write:

1. **Reachable inside this tenant** → else `404 NOT_FOUND` (§5).
2. **Not the owner membership** → else `409 ORGANIZATION_OWNER_PROTECTED` (§7).
3. **Not the caller's own membership** → else `409 MEMBER_SELF_MODIFICATION`.
4. **The transition is one of the two that exist** → else
   `409 MEMBER_STATUS_TRANSITION_INVALID`.

| from | to `suspended` | to `active` |
| --- | --- | --- |
| `active` | ✅ suspend | ❌ no-op |
| `suspended` | ❌ no-op | ✅ reactivate |
| `invited` | ❌ | ❌ |

**A no-op is refused rather than absorbed**, which is the one debatable call
here and is made deliberately. `PATCH` invites an idempotent reading, and
answering `200` for "suspend an already-suspended member" is defensible — but
this operation's whole purpose is that a manager knows what state a colleague
is in. Two managers acting on one roster, or one manager on a stale page, are
exactly the situations where a silent success reports work that was not done.
`ConversationRepository.setStatus` takes the opposite position for
conversations and says so ("both transitions are idempotent, so there is no
'only if currently open' precondition to express") — and a conversation's
status is a workflow label, while a membership's status is an *access
control decision*. Access-control writes should not be silently absorbed.

`invited` gets the same refusal rather than its own, because a manager cannot
resolve it here in either direction: they can neither accept an invitation on
someone's behalf nor suspend something not yet granted. When the invitation
flow ships it owns that row.

The refusal is **specific rather than opaque**, and safely so for ADR-027 §8's
reason: `member.manage` is strictly wider than `member.read` in the catalogue,
so a caller who can reach this route can already fetch the roster that shows
every status this message describes. It discloses nothing `GET …/members`
would not.

### 7. The owner cannot be suspended, and the invariant is defended twice

Refused with `OrganizationOwnerProtectedError` — the **existing** error, whose
message ("The organization owner cannot be changed or removed. Transfer
ownership first.") is already true of this operation and already names the
remedy ADR-028 built.

A suspended owner is a *fourth* route to ADR-016 §3's unrecoverable state: the
tenant would hold its unique slug with an owner who cannot sign in, nobody
able to administer it, and — because ADR-028 §2 gives
`organization.transfer_ownership` to `owner` alone — nobody able to transfer
it out. ADR-027 §7a refused change, demotion, and removal for exactly this
reason; suspension joins that list.

Defended in two places on purpose:

- **The service** checks `membership.role === "owner"` and raises the specific
  error, so the caller learns the actionable thing.
- **The repository filter** carries `role: { $ne: "owner" }`, so the write
  itself cannot land on an owner document even if a future branch reached it
  wrongly. A backstop, never the error path — the same relationship ADR-027 §7a
  set between its schema and index B.

**Item: "no operation may leave the organization without an owner."** This one
structurally cannot. Ownership is carried by `role`, suspension writes only
`status`, and the one document whose role is `owner` is unreachable by this
route. The ordering rule that follows is the one ADR-028 already established:
**transfer first, then suspend.** After a transfer the previous owner is an
`admin` (ADR-028 §7) and becomes an ordinary suspension target, while the new
owner is protected from that moment on.

### 8. Suspension takes effect on the next request because NOTHING was added

The most important decision in this slice is a decision not to build.

`requireOrganization` already refuses every non-`active` membership
(ADR-017 §2), reading the document on every request (§5). The agent socket
handshake applies the identical gate (ADR-025 §9). Therefore:

- A suspended member's **existing access token keeps authenticating them** —
  correctly, because they are still a Serviqo user — and stops **authorizing**
  them in this tenant on their very next request.
- No re-login is required, no session is revoked, no token is invalidated, and
  no cache is purged, because there is no cache.
- Their other organizations are untouched, which is not this tenant's decision
  to make (ADR-027 §11's reasoning for removal, applied unchanged).
- Reactivation restores access the same way and just as immediately.

Adding a status check anywhere else — in a service, in a controller, in a
second middleware — would create a second place that can disagree with the
first, which is the failure ADR-017 §3 and ADR-027's `assertWriteable` both
warn about. The suites therefore assert the property against the EXISTING
gate: a token minted before suspension is refused after it, on the next call,
with no intervening login.

### 9. Revocation reaches live sockets: a third event seam, and a subscriber that disconnects

Both gates in §8 run **once** — at request time and at connect time. The
Socket.IO fan-out does not re-run them, and must not: `createSocketServer`
emits into rooms and performs zero membership lookups per event, because
proving membership per broadcast would put a database round-trip on every
message in the product.

So an agent whose membership is suspended, and whose socket is already in
`org:<id>:inbox`, keeps receiving `message:new` and `conversation:updated`
until that socket closes. **Suspension whose entire purpose is immediate
revocation cannot ship with a live channel still delivering customer messages
to the revoked member.**

`membershipEvents` closes it — the third instance of the seam ADR-025 §2 built
and ADR-026 §9 reused:

```
member.service  →  membershipEvents.publish({ organizationId, userId })
                                     ↓
createSocketServer subscriber → disconnect that user's agent sockets in that tenant
```

Four properties:

- **The service still does not import `socket.io`**, and the transport still
  does not know what a membership is. The event says "this person's staff
  access to this tenant has ended"; the subscriber decides that means closing
  their sockets.
- **It is a targeted action, not a broadcast**, which is why ADR-027 §15's
  refusal does not apply. §15 declined a *roster* event because "a broadcast
  has no single reader to run `can(role, "member.read")` against". Nothing is
  delivered to anyone here: the payload never leaves the server, and the only
  observable effect is that one person's own connections close. No other
  agent learns anything, and **no customer socket is touched** — the
  subscriber filters on the agent identity `socketAuthentication` established,
  and widget sockets carry a customer principal that can never match.
- **Removal publishes it too.** ADR-027 §10's `removeMember` produces the
  identical state — revoked access, live socket — and the fix is the same one
  line. Writing the publisher in only one of the two places would leave the
  older and more severe case open while the newer one was closed. One
  subscriber, two writers.
- **Reactivation publishes nothing.** The member simply connects again; a
  "reconnect now" push would be a client instruction, which this seam is not.

**On generalizing the seam.** `conversationEvents`'s own header invited this
question at exactly this point — "the third consumer will be able to see what
actually varies between these two files". Now that the third exists, the
answer is that a shared bus is still the wrong move: `messageEvents` and
`conversationEvents` differ in payload and audience, and this one differs in
payload, audience, **and in what the subscriber does** — it does not emit at
all. Abstracting over the subscriber's *action* is abstracting over the thing
that varies most. Three small files stay three small files, and the fourth
consumer can revisit it.

### 10. Suspension releases the member's conversations; reactivation restores none

**On suspend**, every conversation assigned to that member in that tenant is
released — `assignedTo: null`, the conversation itself untouched — and each
release publishes `conversation:updated` through `conversationEvents`, so every
connected agent's list re-renders the row as unassigned with no new event type
and no refetch. That is ADR-027 §10's machinery, called from a second place.

**Unconditionally, not derived from `can()`.** ADR-027 §10 and ADR-028 §13
both gate their release on `can(newRole, "conversation.assign")`, because a
role change takes away *one permission*. Suspension takes away *the whole
tenant*: a suspended member fails `requireOrganization` before any permission
is consulted, so no role they hold can matter. Reusing the `can()` predicate
here would be applying a test whose premise does not hold, and it would
release nothing under today's catalogue — leaving conversations stranded on
someone locked out, which is precisely ADR-026 §15's hole reopened.

**Best-effort and never throws**, matching removal: the status write has
already succeeded, revocation is the security-relevant half, and the caller's
outcome must not change because bookkeeping did not. The response reports
`releasedConversations` for the reason ADR-027's removal does — it is the
invisible consequence of the action, and a manager should learn it here rather
than from the inbox.

**On reactivate, nothing is restored, and this is a decision.** The
conversations were returned to the unassigned queue and other agents may have
claimed them; silently re-assigning on reactivation would take live work off
colleagues' desks without anyone asking. There is also no record of the prior
assignment to restore from, and adding one would be building a
suspension-history feature inside a status route. A reactivated member picks
work up the ordinary way — `conversation.assign`, which their restored role
grants.

### 11. Rate limiting: the existing write class, and no new one

`rateLimiters.authenticatedWrite` — 30/hour, keyed by the verified user —
mounted before `requireOrganization` (ADR-018 §3), exactly as `/role` and
`DELETE …/:membershipId` already are.

**No new class**, and the contrast with the two slices that did add one is the
justification. `memberInvite` exists because `POST …/members` discloses
whether a verified account exists for a submitted email (ADR-027 §12);
`ownershipTransfer` exists because ownership transfer is the rarest and most
destructive operation in the product (ADR-028 §11). Suspension is neither: it
discloses nothing a caller holding `member.read` cannot already fetch, and it
is ordinary team administration of the same shape and frequency as a role
change. A class per route would make the limiter a routing table.

### 12. Logging: ids, roles, statuses, counts — never a name, an address, or a credential

Every line carries only: `event`, `reason` (refusals only), `organizationId`,
`actorUserId`, `membershipId`, `targetUserId`, `previousStatus`, `status`,
`role`, `releasedConversations`, `disconnectedSockets`, and `failureType` on a
best-effort failure. That is the complete field set.

Never logged, here or anywhere: passwords, access tokens, refresh tokens,
widget tokens, widget keys, email addresses, personal names, message bodies,
`Authorization` headers, cookies, or request bodies. ADR-016 §9 and
ADR-027 §13 restated for a fourth surface, and asserted against captured log
output rather than trusted.

| Event | Level | When |
| --- | --- | --- |
| `member.status_changed` | `info` | a completed suspension or reactivation |
| `member.status_change_refused` | `info` | every §6 refusal, distinguished by `reason` |
| `member.assignment_cleanup_failed` | `error` | the existing ADR-027 §10 line, reused |
| `socket.membership.revoked` | `info` | the subscriber closed a revoked member's sockets |

The `reason` values — `membership_not_found`, `owner_protected`,
`self_modification`, `invalid_transition` — exist in the log and reach **no**
response body, the split ADR-015 §6, ADR-017 §6, ADR-027 §13 and ADR-028 §12
each established.

### 13. Response: the roster projection the sibling route already returns

```json
{ "data": { "member": { "id": "…", "role": "agent", "status": "suspended", … },
            "releasedConversations": 2 } }
```

`toMemberResponse` unchanged — the same projection `GET …/members` and
`PATCH …/role` return, so a client updates its row from the response with no
second fetch and no second shape to understand. `releasedConversations`
accompanies it for §10's reason, matching `DELETE …/:membershipId`'s envelope
exactly.

The existing success and error envelopes are reused. **One** new error class is
added, because one new refusal is thrown: `MemberStatusTransitionError`
(`409 MEMBER_STATUS_TRANSITION_INVALID`). Owner protection, self-modification,
and unreachable-membership all reuse ADR-027's existing classes rather than
adding near-duplicates — `lib/errors/index.ts`'s standing rule is that only
classes an existing slice actually throws live there, and its corollary is that
a slice throwing an existing meaning uses the existing class.

### 14. The dashboard: one control per row, confirmed in one direction

Inside the existing Team section (ADR-027 §16), each actionable row gains a
single status control:

- **`Suspend`** for an `active` member — **confirmed**, and the confirmation
  names the person and states the consequence, because suspension cuts a
  colleague's access immediately and silently releases their conversations.
  The same treatment removal gets, for the same reason.
- **`Reactivate`** for a `suspended` member — **not confirmed**. It restores
  access rather than taking it away, it is trivially undone by suspending
  again, and a confirmation on every safe action is how people learn to click
  through confirmations on unsafe ones.
- **Nothing** for an `invited` member, whose row already explains itself
  through the existing `STATUS_HINT`.

Gated on `canManageMembers(role)` and on the existing `isActionable(member)`,
which already withholds controls from the owner row and the reader's own —
so the two structural refusals of §6 are never offered as buttons whose only
outcome is a `409`. As always: **a UX affordance, never a boundary.** The
server re-proves `member.manage` on every request from the membership document
it reads on that request, so a control un-hidden in a debugger still receives a
`403`.

Every control is disabled while any mutation is in flight, through the existing
`isBusy`/`pendingAction` mechanism, which gains one `TeamActionKind`. The
roster refetches after the operation for ADR-027 §15's reason unchanged — the
roster is not live, a status change reorders nothing but does change a row's
controls, and a refetch is what makes a second manager's concurrent change
visible.

The suspended state is already rendered: `STATUS_HINT.suspended` reads "Access
revoked — cannot sign in to this organization", which ADR-027 §14 shipped and
which this slice finally makes reachable through the product rather than only
through a direct database write.

### 15. What this slice does not do

- **No invitation flow, no acceptance, no email of any kind.** `invited`
  remains unwritable (§3).
- **No session revocation.** ADR-027 §11's reasoning is unchanged: the person
  remains a Serviqo user, and their other tenants are not this tenant's
  business (§8).
- **No suspension reason, no audit trail, no "suspended until".** The log lines
  in §12 are the record; a queryable audit surface is Phase 18's.
- **No self-service leave, no organization deletion, no profile management.**
- **No new permission, no new rate-limit class, no new role, no role or status
  cache, no client-side permission table, no second RBAC system, no tickets,
  no AI, no Redis, no Docker.**

### 16. Known limitations carried forward

1. **Assignment cleanup is best-effort and not transactional** (§10) —
   ADR-027 §18's limitation, now reachable from a second route. A crash
   between the status write and the release leaves conversations assigned to a
   suspended member. Bounded to a crash window; the state is inert because
   they cannot reach the tenant.
2. **Socket eviction is best-effort and single-process** (§9). It closes
   sockets held by *this* Node process; a multi-node deployment would need the
   Redis adapter's cross-node disconnect, which is Phase 8's and is recorded
   alongside ADR-018 §2's other single-process ceilings in SECURITY.md §3a.
   The window it leaves is bounded by the next request or reconnect, both of
   which are gated.
3. **A suspended member keeps their sessions and refresh tokens** (§8). Correct
   for a multi-tenant product, and it means suspension is not a way to force
   someone out of Serviqo entirely.
4. **The roster is still not live** (ADR-027 §15). Two managers see each
   other's status changes on their next fetch.
5. **`invited` remains a value nothing can write** (§3), so the model still
   describes one more state than the product has.

## Consequences

- `MembershipStatus` stops being a partially-fictional type. Two of its three
  values are now written by the product, and ADR-017 §2's `status === "active"`
  gate — dormant since the slice that wrote it — becomes a gate with a real
  writer on the other side of it.
- Serviqo gains its first **reversible** access-control operation. Every prior
  membership write either granted access or destroyed the relationship;
  suspension is the first that revokes without discarding, which is what makes
  the "reactivation restores nothing but access" decision (§10) load-bearing
  rather than incidental.
- The domain-event seam gets its third instance and its first **non-broadcast**
  subscriber, which is what settles the generalization question
  `conversationEvents` left open (§9).
- ADR-027's live-socket revocation gap closes for removal as well as
  suspension, through one subscriber with two writers — the older and quieter
  of the two holes being the one that had been open longest.
- ROADMAP Phase 3 loses its penultimate item. What remains is the invitation
  system and profile management, both of which need real email delivery, which
  nothing in the project provides.
