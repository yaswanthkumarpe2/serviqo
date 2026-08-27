# ADR-026: Conversation Assignment and Status

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (the ownership and lifecycle half of the agent workspace)
**Implements:** ROADMAP.md Phase 5's first deferred item — "Assignment and ownership — every agent currently sees every conversation in their organization; 'assigned conversations' needs an assignment model that does not exist" — and Phase 6's "Archiving and closing conversations — `status` supports it; no route sets it yet"
**Closes:** [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §12's two named exclusions: "No conversation assignment, no ownership, no queues" and "No closing or reopening conversations. `status` supports it; no route in this slice sets it, which is unchanged from ADR-022"
**Related:** [ADR-022](./022-persistent-conversations-and-messages.md) §1 (every repository method scoped by `organizationId`), §3 (the partial unique index — at most one open conversation per customer), §5 (server-assigned literals, never request input), §8 (one opaque refusal for every unreachable conversation), §10 (best-effort follow-up writes never fail the write that caused them), §13 (response projections); [ADR-023](./023-socket-io-realtime-transport.md) §4 (room naming), §5 (the event/ack contract); [ADR-024](./024-widget-realtime-chat-client.md) §4 (id-based de-duplication at a single append point), §7 (the widget renders its own copy, never the server's); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §2 (the domain-event seam this slice reuses for a second event), §5 (the keyset-paginated inbox list), §7 (staff projections and what they disclose), §8 (the per-organization inbox room), §9 (the socket handshake's agent branch), §10 (cross-tenant ids stay indistinguishable), §11 (the inbox is mounted keyed by organization); [ADR-017](./017-organization-context-and-rbac.md) §1 (the tenant is a path segment), §5 (role read from the database per request), §6 (one opaque refusal), §7 (`requirePermission`); [ADR-010](./010-principal-types-organization-users-and-customers.md) §2 (a customer holds no membership and no role); CONTRIBUTING.md ("Socket rooms must be scoped by organization"; "Never rely only on frontend filtering"; "No business logic in JSX")

## Context

ADR-025 gave a tenant's staff a working inbox: every conversation in the
organization, every message in each, a composer, and live delivery in both
directions. It also stated, in §12, exactly what it was leaving out — and
named the two items this slice picks up:

> **No conversation assignment, no ownership, no queues.** Every agent in a
> tenant sees every conversation in it.

> **No closing or reopening conversations.** `status` supports it; no route in
> this slice sets it, which is unchanged from ADR-022.

Both gaps have the same shape: the *data* is either present or trivially
addable, and what is missing is the decision about who may change it and what
changing it means.

Three structural facts shape everything below.

**First, `status` already exists and is already load-bearing.** ADR-022 §3
enforces "at most one OPEN conversation per customer" with a partial unique
index over `{ organizationId, customerId, status }`. That index is not
incidental to this slice — it is the single thing that makes reopening a
closed conversation a genuinely interesting operation rather than a field
write, because the customer may well have opened a new conversation in the
meantime. §7 below is that decision.

**Second, `messageService` currently does not consult `status` at all.**
`requireOwnConversation` and `requireTenantConversation` prove tenancy and
stop. So today a `closed` conversation accepts messages exactly as an open one
does, and "closed" is a label with no behaviour attached. Giving agents a
button that sets a field with no consequence would be worse than not shipping
the button. §6 is that decision, and it is the one with the widest blast
radius in this slice.

**Third, the agent principal, the tenant boundary, the permission catalogue,
and the broadcast seam all already exist.** ADR-017 resolves the tenant from a
path segment and reads the role from the database on every request; ADR-025 §2
built a domain-event seam explicitly so that "any future writer … broadcasts
correctly by calling the message service, with no knowledge that Socket.IO
exists". This slice introduces **no new credential, no new transport, no new
authentication path, and no new broadcast mechanism**. It adds one nullable
field, one permission, two routes, and a second event through the seam that
was built to take one.

## Decisions

### 1. `assignedTo` on `Conversation` — nullable, a `User` id, and nothing else

`Conversation` gains one field:

```ts
assignedTo: Types.ObjectId | null;   // ref: "User", default null
```

Nullable rather than absent-or-present. `null` is the honest representation of
"nobody has picked this up", it is a value the list filter can query directly
(`{ assignedTo: null }`), and it means every conversation document has the same
shape whether or not anyone has claimed it. An optional field would make
"unassigned" and "written by an older version of the code" indistinguishable at
the storage layer.

It references `User` and not `Membership`. The thing being recorded is *which
person* is handling this conversation, and a person outlives any particular
membership document — a membership that is deleted and re-created for the same
user in the same tenant is the same human being, and an assignment that
dangled across that operation would be a bug with no upside. Tenancy is not
carried by this field and does not need to be: the conversation itself is
tenant-scoped, and every read and write of `assignedTo` goes through a
repository method that already takes `organizationId` as a mandatory key
(ADR-022 §1).

**Deliberately not stored:** who assigned it, when it was assigned, and any
history of previous assignees. Each is an audit-trail concern, ROADMAP Phase 18
names "system logs and audit trails access" as its own body of work, and a
half-audit — one `assignedAt` with no actor and no history — is the kind of
field that gets trusted for exactly the question it cannot answer. `updatedAt`
already records that *this document's own state* changed, and ADR-022's model
comment already says so.

**Deliberately not indexed as a partial unique index.** There is no "at most
one conversation per agent" rule and there must not be one — an agent handles
several conversations at once, which is the entire premise of an inbox.

One index is added, matching the shape of the query §5 introduces:

```ts
conversationSchema.index({ organizationId: 1, assignedTo: 1, lastMessageAt: -1, _id: -1 });
```

Key order matches the query exactly, as ADR-025 §5's index does: equality on
the tenant, equality on the assignee, then the sort key and the cursor's
tiebreak. `status` is *not* in this index and is filtered rather than sought,
because it is two-valued — an index whose extra key roughly halves the
candidate set earns less than the write cost it imposes, and the existing
`{ organizationId, lastMessageAt, _id }` index already serves the sort for
every status-only filter.

### 2. Two routes, not one `PATCH`, because a route names exactly one permission

The obvious shape is one endpoint:

```
PATCH /api/v1/organizations/:organizationId/conversations/:conversationId
{ "assignedTo": "…", "status": "closed" }
```

It is rejected. Assignment and status are gated by **different permissions**
(§3), and `requirePermission` takes one permission per route by construction.
A single `PATCH` accepting both fields would have to check the second
permission *inside the handler*, which moves the authorization decision out of
the route file and into a branch — precisely the "scattered `if (role === …)`
checks" that ADR-002 §7–19 forbade and that `requirePermission` exists to
prevent. "Which permission does this route need?" must stay answerable by
reading `agentInbox.routes.ts`, which ADR-025 §3 states as the reason every
middleware is spelled out on every route there.

So the surface is two routes, both under the organization path prefix ADR-025
§3 established, both behind the same four-middleware chain in the same order:

```
PATCH /api/v1/organizations/:organizationId/conversations/:conversationId/assignment
  body: { "action": "claim" | "release" }
  permission: conversation.assign

PATCH /api/v1/organizations/:organizationId/conversations/:conversationId/status
  body: { "status": "open" | "closed" }
  permission: conversation.reply
```

`PATCH` rather than `POST`: both are partial updates of an existing resource,
addressed by its own id, and neither creates anything. `PATCH` on a
sub-resource path rather than on the conversation itself, so the sub-path *is*
the field being changed — which is what lets each route carry exactly one
permission without a discriminator inside the body doing authorization work.

**The assignment body takes an `action`, never a user id.** `"claim"` and
`"release"` are the two verbs, and the *subject* of both is the authenticated
caller, resolved server-side from `req.principal.userId` — a value
`requireAccessToken` derived from a verified token and that has no
client-reachable source. There is no `assignedTo` field in any request schema
in this codebase, so a client cannot express "assign this to someone else" even
malformedly. That is ADR-022 §5's rule ("assigned as a literal … never a
parameter that traces back to request input") applied to identity rather than
to `senderType`, and it makes §4's constraint structural instead of checked.

Both routes return the same projection the inbox list and detail reads already
return (§11), so a client updates its row from the response with no second
fetch and no second shape to validate.

### 3. `conversation.assign` joins the catalogue; status changes ride on `conversation.reply`

One permission is added:

```ts
| "conversation.assign"
```

held by `owner`, `admin`, `supervisor`, and `agent`. Every role that can reply
can also claim, because claiming is how an agent takes responsibility for the
reply they are about to write; a role that could answer conversations but not
pick them up would be a role that can only ever work on someone else's queue.

The permission is named for the *capability* ("change who owns this
conversation") rather than for the verb ("claim"), following the catalogue's
existing shape — `organization.manage` covers rename, settings, and suspend
rather than naming three permissions.

**Status changes are gated by `conversation.reply`, not by a new permission,
and not by `conversation.assign`.** Three reasons, in order of weight:

1. Closing a conversation is *acting in* it, which is what `conversation.reply`
   already means: it is the permission that separates a participant from a
   reader. ADR-025 §4 introduced it as "send a message as the organization",
   and the standing it describes — this person may change what this
   conversation is, not merely look at it — is the same standing closing needs.
2. `conversation.assign` is about *ownership*, which is orthogonal. A tenant
   that later wants "supervisors assign, agents close" or "agents claim,
   supervisors close" gets both from a table edit, and would get neither if the
   two rode on one permission.
3. Adding a `conversation.close` permission now would put a third entry in the
   catalogue that every role holds and no route distinguishes.
   `permissions.ts` states the rule directly — "a permission guarding nothing
   is the same unexercised security surface" — and adds the corollary this
   slice follows: "A permission joins this union in the slice that enforces
   it." A permission whose row is identical to `conversation.reply`'s in every
   role is not being enforced; it is being anticipated.

If a read-and-close-but-not-reply role ever exists, splitting
`conversation.close` out is a one-line change to `permissions.ts` and a
one-line change to the route — no handler, service, or repository is touched,
because none of them mentions a role or a permission.

### 4. Claim is self-assignment; release gives up your own; neither steals

The two actions have deliberately narrow semantics:

- **`claim`** sets `assignedTo` to the caller. Permitted when the conversation
  is unassigned **or already assigned to the caller** (idempotent). Refused
  when it is assigned to someone else.
- **`release`** sets `assignedTo` to `null`. Permitted when the conversation is
  unassigned (idempotent) **or assigned to the caller**. Refused when it is
  assigned to someone else.

Both share one precondition — *`assignedTo` is `null` or is me* — which is what
makes them symmetric rather than two rules that can drift apart.

Both are executed as a **single conditional update**, never a read followed by
a write:

```ts
ConversationModel.findOneAndUpdate(
  { _id: conversationId, organizationId, $or: [{ assignedTo: null }, { assignedTo: userId }] },
  { $set: { assignedTo: userId } },       // or null, for release
  { returnDocument: "after" },
);
```

Two agents clicking *Claim* on the same unassigned conversation in the same
instant is not a hypothetical — it is the ordinary contention an inbox exists
to arbitrate. A check-then-write would let both succeed and the second to write
would silently win, so the losing agent's UI would show them as the owner while
the database disagreed. The filter above makes MongoDB the arbiter: exactly one
update matches, and the other returns `null`.

A `null` return is ambiguous — the conversation may be unreachable, or it may
be assigned to someone else — so the service disambiguates with **one further
tenant-scoped read**, on the failure path only:

- the read returns `null` → `ConversationNotAccessibleError` (404), the same
  opaque refusal every unreachable conversation produces (§12);
- the read returns a document → `ConversationAlreadyAssignedError` (409).

The 409 is safe to answer specifically, by the same reasoning ADR-017 §6 uses
for `InsufficientPermissionError`: by the time it can be raised, the caller has
already proved membership in the tenant and the conversation has already been
proved to be inside it, so "someone else has this one" discloses nothing the
caller did not already have access to. **It names no user**, because who that
someone is depends on the caller's own entitlement to the roster (§11), and a
refusal is the wrong place to make that distinction.

**Taking a conversation from another agent is deliberately not possible in this
slice** — for anyone, including an owner. That is a real limitation and it is
recorded as one in §15 rather than smuggled in: an override needs a second
permission (`conversation.assign.any`, or a `force` flag with its own gate),
and it needs an answer to "what does the agent who just lost their conversation
see?" — which is a notification design, not a field write. Shipping the
override without those is how a workflow guard turns into a way for one agent
to quietly hand another's work to themselves.

### 5. Filtering the inbox: `status` and `assignee`, where `assignee` names a relation and never an id

`GET /organizations/:organizationId/conversations` gains two optional query
parameters:

```
?status=open|closed
?assignee=me|unassigned
```

Both absent means "everything", which is exactly ADR-025 §5's behaviour, so no
existing client changes and the default stays the honest one — an inbox that
hides rows by default is an inbox whose emptiness cannot be trusted.

`assignee` takes **`me` or `unassigned` and never a user id.** This is the same
decision as §2's `action`, in the place it matters most: a filter that accepted
`?assignee=<userId>` would be a client naming a person, and the server would
then have to decide whether this caller may ask about that person — a question
with the roster-disclosure shape §11 works to avoid. `me` is resolved from
`req.principal.userId` in the controller, so the only identity the filter can
express is one the server already proved. A caller who wants another agent's
queue is asking a supervision question that ROADMAP Phase 5's
"multi-conversation handling" and Phase 19's analytics own.

Both filters are applied **in the database query**, never in memory after the
fact. CONTRIBUTING.md's rule is about frontend filtering, and the same logic
binds here for a different reason: keyset pagination over a filtered set is
only correct if the filter is part of the query the cursor pages through.
Filtering a page after it was fetched would silently return short pages and,
eventually, an empty page with a non-null `nextCursor`.

### 6. A closed conversation accepts no new messages — from either side

This is the decision that gives `status` behaviour, and the one this slice
would be dishonest without.

`messageService.create` (customer) and `messageService.createFromAgent` (staff)
both gain the same check, immediately after the ownership proof they already
perform:

```ts
if (conversation.status === "closed") throw new ConversationClosedError(…);
```

`409 CONVERSATION_CLOSED`, and it is answered **specifically** rather than
folded into the opaque 404. Both callers have already proved they may reach
this conversation — the customer holds a token naming it and owns it, the agent
holds a membership in its tenant — so naming the reason discloses nothing about
existence or ownership. It also has a *remedy*, which is the same test ADR-011
§6 applied when it made `EmailNotVerifiedError` the one non-generic
authentication refusal: a caller who cannot tell "closed" from "gone" cannot
recover, and the recovery is different for each (§8).

**Symmetric across both senders, deliberately.** An agent-only or
customer-only rule would mean "closed" meant two different things depending on
who asked, and the first bug report would be an agent replying into a thread
the customer can no longer answer in. One rule, one meaning: a closed
conversation is a finished conversation, and speaking in it again requires
reopening it (§7) — an explicit act, by someone who holds `conversation.reply`,
that is visible to every other agent in the tenant the moment it happens (§10).

The socket transport carries the same refusal. `realtimeEvents.ts` gains one
ack code:

```ts
CONVERSATION_CLOSED: "This conversation has been closed."
```

and `handleSend` maps `ConversationClosedError` to it, exactly as it already
maps `ConversationNotAccessibleError` to `NOT_FOUND`. The two transports refuse
the same write for the same reason with the same words, which is the property
ADR-023 §6 established by having the socket handler reuse
`messageService.create` verbatim rather than reimplementing it.

**What is deliberately *not* blocked on a closed conversation:** reading it,
reading its history, listing it, claiming it, releasing it, and reopening it.
Closing ends the exchange, not the record. An agent who cannot open a closed
conversation to read what happened has an archive they cannot consult, and
ROADMAP Phase 6 calls this feature "archiving", not "deletion".

### 7. Reopening is explicit, and the open-conversation uniqueness index is the thing it can collide with

`PATCH …/status` with `{ "status": "open" }` reopens. It is the same route and
the same permission as closing, because "open" and "closed" are the two values
of one field and a separate `/reopen` endpoint would be a second name for one
write.

Reopening is where ADR-022 §3's partial unique index becomes visible:

```ts
conversationSchema.index(
  { organizationId: 1, customerId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);
```

The sequence that collides is ordinary, not adversarial:

1. An agent closes Grace's conversation.
2. Grace writes in again. `conversationService.resolveOpen` finds no open
   conversation and creates a new one — the behaviour ADR-022 §7 already
   specifies, unchanged by this slice.
3. An agent reopens the *first* conversation.

Step 3 would make two open conversations for one customer, and the index
refuses the write with a duplicate-key error. **That refusal is correct and is
kept.** The alternative — closing the newer conversation to make room, or
dropping the index's partial filter — would either destroy a thread the
customer is actively using or discard the invariant ADR-022 §3 chose the
database to enforce specifically so that application code could not get it
wrong.

So the duplicate-key error is caught and translated, exactly as
`conversationService.resolveOpen` already catches `11000` for its own race:

```
409 CONVERSATION_REOPEN_CONFLICT
"This customer already has an open conversation."
```

Specific, and safe for the same reason §6's refusal is: the caller has proved
tenancy, and the fact disclosed — that this customer has a newer conversation —
is one the caller's own inbox list already shows them. It is also the only
refusal in this slice whose message tells the agent what to do next, because
what to do next (go to the newer conversation) is not guessable from
"conflict".

Reopening a conversation that is already open, and closing one already closed,
are both **idempotent successes**. Neither is an error: the caller's intent is
already satisfied, and the alternative is a UI that must disable a button based
on state it may have fetched a second ago.

### 8. The widget recovers from a closed conversation by resolving a new one

§6 introduces a refusal the customer's widget has never seen, and "preserve
existing customer access" is not satisfied by a visitor watching their message
fail while an agent looks at a closed thread.

The widget's `submitMessage` gains one recovery, on exactly one ack code:

```
CONVERSATION_CLOSED  →  resolveConversation()  →  join(new id)  →  retry the send once
```

`resolveConversation` is ADR-022 §7's resolve-or-create, already called on
every session open, and it returns a *new* open conversation precisely because
the old one is closed. So the visitor's message lands, in a new thread, and the
agent sees a new row in their inbox — which is the truthful representation of
what happened, and better than either of the alternatives (silently writing
into a closed thread, or telling the visitor chat is unavailable when it is
not).

**Retried exactly once, and only for this code.** An unbounded retry against a
conversation that keeps being closed is a loop, and every other failure is
already handled by the existing branch that restores the typed text and shows
the notice. The widget still renders its own copy of every message and never
the server's (ADR-024 §7); `RealtimeError` already carries the ack `code` for
callers to branch on, which is the seam that makes this a branch rather than a
new mechanism.

No other widget behaviour changes. The visitor is never told a conversation was
closed, because from their side nothing was: they typed a message and it was
delivered.

### 9. `conversationEvents` — the second domain event, published by the service, consumed by the transport

ADR-025 §2 built `messageEvents` and stated the shape it was establishing:
services publish a fact, `realtime/createSocketServer.ts` subscribes and
performs every broadcast, and "no service imports `socket.io`, and no transport
re-derives who should receive a message."

`modules/conversations/conversationEvents.ts` is that file again, for
`conversation.updated`, and it is a deliberate **second instance of the pattern
rather than a generalization of it**. A shared `domainEvents` bus with a string
topic would be the natural refactor and it is declined here for the reason
ADR-023 §12 declined to design the message seam early: two instances is where
a pattern becomes visible, not where it becomes a framework. The two files are
each about eighty lines, they are read by different subscribers, and the third
consumer — whenever it arrives — will be able to see what actually varies.

Everything ADR-025 §2 decided carries over unchanged and for unchanged reasons:

- **The payload is a projection, never a `ConversationDocument`.** A subscriber
  must not be able to write through an event.
- **`publish` never throws.** A subscriber's error is caught and logged as an
  event name and an error class. The state change is durably persisted before
  the event is published, so nothing here may fail the write that caused it —
  the same posture ADR-022 §10 takes for `touchLastMessageAt`.
- **`subscribe` returns its own unsubscribe**, and `createSocketServer` ties
  both of its unsubscribes to `httpServer.close`. A module-scope emitter with
  per-instance subscribers is safe only if the subscribers are actually
  removed, and the suites construct and tear down several socket servers in one
  process.
- **No request-scoped logger travels with the event.** A subscriber runs
  outside the request that caused it and logs as itself.

The event is published by `conversationService` — for claim, release, close,
and reopen alike — from one helper, so four operations cannot assemble four
differently-shaped events for what is one fact.

### 10. `conversation:updated` reaches the tenant's inbox room and never the customer's

`messageEvents`' subscriber broadcasts to **two** disjoint rooms: the
conversation room, which holds the customer's sockets, and the tenant's inbox
room, which holds its agents (ADR-023 §4, ADR-025 §8).

`conversation.updated` broadcasts to **the inbox room only**.

That asymmetry is a disclosure decision, not an oversight. The payload carries
`assignedTo`, and `assignedTo` is a member of the tenant's staff. A customer
learning which employee is handling their ticket — or that it was handed from
one to another, or that nobody has picked it up in an hour — is internal
operational detail crossing the boundary SECURITY.md §2 draws, and ADR-025 §7
already made the same call for the customer's own data in the other direction
by listing exactly which three customer fields an agent sees.

Filtering the field out of a customer-bound copy of the event was considered
and rejected: it would mean one payload with two audiences and a projection
whose correctness depends on a branch being right forever. One event, one
room, one audience — and the field cannot reach a customer because no code path
sends it to one.

The consequence is honest and stated here so nobody later mistakes it for a
bug: **a customer's widget is not told that their conversation was closed.**
They discover it the moment it matters — when they send a message — and §8
makes that discovery invisible to them by resolving a new conversation. A
customer-facing "this conversation was closed" event is a product decision
about what a visitor should be told, and it belongs to the slice that designs
what the widget does with it.

The room name is built by `organizationInboxRoomName(organizationId)` from the
organization the server itself proved at handshake time (ADR-025 §9), so — as
with every other broadcast in this codebase — there is no room name a client
can cause to be constructed that reaches another tenant.

### 11. The assignee's name is disclosed only to a caller who holds `member.read`

An inbox row showing `assignedTo: "68a3f1…"` is useless, and a row showing
`assignedTo: { name: "Ada Lovelace" }` to every agent in the tenant discloses
the staff roster — which `member.read` exists to gate and which the `agent`
role **does not hold**:

```ts
agent: ["organization.read", "conversation.read", "conversation.reply"],
```

Rendering colleague names into every agent's inbox would hand that role,
through a conversation projection, exactly what the permission table withholds
from it.

So the projection is conditional on the reader:

```ts
assignedTo: { id: string; name: string | null } | null
```

- `null` when the conversation is unassigned.
- `{ id, name: "…" }` when the caller's role holds `member.read`.
- `{ id, name: null }` when it does not.

The `id` is always present and is what the client compares against its own user
id to render **"Assigned to you"** — so an agent can always tell their own work
from someone else's without learning who anyone else is. That is the whole of
what the `agent` role needs to operate, and it is strictly less than the
roster.

The decision is made through `can(role, "member.read")`, the boolean form
`permissions.ts` exports and describes in exactly these terms:

> Exported for the rare caller that needs a boolean rather than a refusal — a
> controller shaping a response to what the reader may see, for instance — so
> that even those comparisons go through this table rather than re-deriving it.

This is that caller. The comparison happens in the controller, once, against
the role `requireOrganization` read from the database on this request
(ADR-017 §5) — not in the service, not in the repository, and never against a
role a client supplied.

Names are resolved in **two batched, tenant-scoped queries** for a whole page —
memberships in this organization for the assignee ids, then users for the ids
that survived — mirroring ADR-025 §7's batched customer lookup and for the
identical reason: one query per row is the N+1 that a list endpoint must not
have. The membership query is first and is not skippable, because it is what
makes "this user is a member of this tenant" a fact the server proved rather
than one `assignedTo` asserted; an assignee whose membership has since been
revoked resolves to `{ id, name: null }`, which renders as an assignment to
someone no longer on the team rather than as a name leaking across a boundary
that has already closed.

The whole lookup is **skipped entirely** when the caller lacks `member.read` —
no memberships read, no users read — so the cheaper path is also the one that
discloses less.

### 12. Refusals, isolation, and rate limiting reuse what already exists

**Cross-tenant and unknown conversation ids stay indistinguishable.** Every new
operation reaches its conversation through
`conversationRepository.findByIdForOrganization` or through a conditional
update carrying `organizationId` in its filter — two keys in one query, so a
conversation under another organization returns `null` identically to one that
does not exist (ADR-022 §1, ADR-025 §10). The 404 is produced by the query
missing, not by a branch comparing tenants, so there is no branch to drift.

**Nothing about identity comes from the client.** The tenant comes from the
path segment `requireOrganization` proved; the acting user comes from
`req.principal`, which `requireAccessToken` derived from a verified token; the
role comes from the `Membership` document read on this request. The request
schemas name `action` and `status` and nothing else, so `organizationId`,
`customerId`, `userId`, and `assignedTo` are *stripped by Zod* before any
handler runs (ADR-022 §5) — not rejected, stripped, which is why a forged value
is not merely refused but unobservable.

**A suspended organization or a non-active membership refuses every route in
this slice**, because `requireOrganization` proves all four of ADR-017 §2's
gates before `requirePermission` or any handler runs. This is not new code and
is tested here anyway, for the reason ADR-025 tested it: a route that forgot to
mount the chain would fail exactly these assertions.

**Rate limiting reuses the existing classes**, unchanged: `authenticatedWrite`
for both `PATCH` routes (keyed by the verified user, ADR-018 §4) and
`authenticatedRead` for the list. ADR-025 §13 already records that
`authenticatedWrite`'s 30/hour bound is low for an agent working over REST and
names the follow-up — a dedicated `agentConversationWrite` class reusing
`WIDGET_CONVERSATION_WRITE_LIMIT`'s numbers. That limitation now covers claim,
release, and close as well as replies, and it is still not widened from inside
a feature slice; §15 carries it forward with the added weight.

**Logging carries safe fields only.** The new log lines name the event, the
organization, the conversation, and — for an assignment — the acting user id.
No message bodies, no customer email, no names, no tokens. `assignedTo` is an
ObjectId, and the *name* resolved in §11 is never logged, because a log line is
read by operators who did not go through `can()`.

### 13. The inbox UI: claim, release, close, reopen — and other agents' actions arriving live

`AgentInbox.tsx` stays presentation-only and `useAgentInbox.ts` keeps every
fetch and socket subscription (CONTRIBUTING.md: "No business logic in JSX"),
unchanged in shape from ADR-025 §11 — including the `key={organizationId}`
mount that makes tenant isolation structural.

The thread header gains an assignment line and two controls:

- **Unassigned** → a *Claim* button.
- **Assigned to you** → a *Release* button.
- **Assigned to someone else** → the assignee (a name for a reader who holds
  `member.read`, "another agent" for one who does not), and no button — §4's
  refusal is represented as an absent control rather than as a button that
  always fails.
- **Open** → a *Close* button. **Closed** → a *Reopen* button, and the composer
  is replaced by a line saying the conversation is closed, because §6 means a
  send would be refused.

Each action has its own pending state, so a slow claim does not disable the
close button, and each renders the same three outcomes the inbox already
distinguishes: a generic failure message, a *forbidden* state for a role
without the permission (not retryable, so no "try again" is offered —
ADR-025 §11's rule), and, for the two 409s, **the one place in this UI where a
specific reason is shown**: "Another agent has this conversation" and "This
customer already has an open conversation." Both are the client's own copy, not
the server's text (ADR-019 §12), and both are shown because they are the two
refusals an agent can actually act on.

`conversation:updated` is handled beside `message:new` in the same client, and
merges by id into the existing row — `assignedTo` and `status` replaced, the
customer left alone because it did not change and the event does not carry it.
A conversation the list has never seen is ignored, exactly as ADR-025 §13
decided for `message:new`: the next fetch brings it in, and rows do not appear
under a reader's cursor. So an agent watching their inbox sees a colleague
claim a conversation, and the *Claim* button on that row becomes the
colleague's name, with no refresh.

### 14. What this slice does not do

- **No ticketing, no AI, no email notifications, no Redis, no Docker, no
  deployment.** Each is a named ROADMAP phase.
- **No reassignment to another agent, and no override.** §4 states the
  constraint and why the override needs a second permission and a notification
  design it does not have.
- **No assignment or status history, no `assignedAt`, no `closedAt`, no
  `closedBy`.** §1 states why a half-audit is worse than none; ROADMAP Phase 18
  owns audit trails.
- **No queues, no routing rules, no auto-assignment, no round-robin.** Those
  are ROADMAP Phase 10's automation engine, and every one of them needs a
  policy model this slice would have to invent.
- **No SLA, no due dates, no priority.** ROADMAP Phase 9.
- **No customer-visible conversation status.** §10 states the disclosure
  decision and §8 states what the customer experiences instead.
- **No bulk actions.** Claiming or closing twenty conversations at once is a
  different endpoint with a different failure model (what does a partial
  success return?), and the inbox has no multi-select to drive it.
- **No pagination UI, still.** The filters in §5 make the first page more
  useful; `nextCursor` remains returned by the server and unused by the client,
  which is ADR-025 §13's limitation unchanged.
- **No change to any widget behaviour except §8's recovery**, which exists only
  because §6 created the refusal it recovers from.

### 15. Known limitations carried forward

- **`authenticatedWrite`'s 30/hour bound now covers claim, release, and close
  as well as replies** (§12). ADR-025 §13 already named the follow-up — a
  dedicated `agentConversationWrite` class — and an agent working a busy queue
  now reaches the bound faster than one who only replies. Still not widened
  from inside a feature slice.
- **An agent cannot take a conversation from a colleague, and neither can an
  owner** (§4). The workflow answer today is that the colleague releases it.
- **A conversation assigned to someone whose membership was revoked stays
  assigned to them**, rendering as an assignment with no name (§11). Nothing
  sweeps `assignedTo` when a membership ends, because membership removal has no
  endpoint yet (`member.manage` guards nothing today). The slice that builds it
  owns that cleanup.
- **The inbox list is still not live-reordered**, and a conversation whose
  status changes to one the current filter excludes stays on screen until the
  next fetch. Removing rows under a reader's cursor is the same UX problem
  ADR-025 §13 declined to solve by re-sorting.
- **`conversation:updated` is in-process only**, inheriting ADR-023 §11's
  single-process ceiling unchanged: a second server process would broadcast to
  its own inbox room and no other.
- **Two near-identical event modules** now exist (§9). That is deliberate, and
  the third one is where the generalization should be considered.

## Consequences

- A tenant's conversations have an owner for the first time. "Who is handling
  this?" is a question the product can answer, and `assignedTo` is the field
  every later ownership feature — queues, routing, SLA, analytics on
  resolution time — reads rather than re-derives.
- `status` stops being a label and becomes a rule. ADR-022 shipped the field
  and ADR-025 shipped the inbox without either giving it behaviour; a closed
  conversation now refuses messages on both transports, from both principal
  types, through one check in one service.
- The domain-event seam ADR-025 §2 built for messages carries a second, wholly
  different kind of fact with no change to the transport's structure — the
  subscriber gained one more subscription and one more room-scoped emit. That
  is the evidence the seam was the right shape and not a message-specific
  mechanism wearing a general name.
- The permission catalogue gains its first permission that is *not* about
  reading or writing content, and `requirePermission` gains its first pair of
  sibling routes gated by two different permissions — which is what forced §2's
  route shape and demonstrated that the "a route names one permission" rule has
  design consequences rather than being a formality.
- `can()`'s documented-but-unused second role — a controller shaping a response
  to what the reader may see — has its first caller (§11), and the staff
  roster stays inside `member.read` even as a new surface has an obvious reason
  to render it.
- ROADMAP Phase 5's inbox is no longer "every agent sees every conversation":
  it has ownership, a lifecycle, and filters for both. Phase 6's archiving item
  is closed. What remains in Phase 5 — the context panel, internal notes, and
  multi-conversation handling — needs no further conversation-model work.
