# ADR-025: The Agent Inbox and Live Agent Replies

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (the staff-facing half of the conversation surface)
**Implements:** ROADMAP.md Phase 5 ("Agent workspace — dashboard for agents to view assigned conversations") in its smallest honest form, and Phase 7's last open item — "Broadcasting messages produced outside a socket handler (REST sends, and later agent/AI replies)"
**Closes:** [ADR-023](./023-socket-io-realtime-transport.md) §12's named gap — "the moment a second writer produces messages a customer must see live … that slice needs an emit path that does not run inside a socket handler". This is that slice, and it decides the mechanism with both consumers visible, exactly as §12 asked.
**Related:** [ADR-022](./022-persistent-conversations-and-messages.md) §1 (every repository method scoped by `organizationId`), §5 (`senderType` is assigned server-side as a literal), §8 (one opaque refusal for every unreachable conversation), §11 (keyset pagination), §13 (response projections), §15 (no agent surface — the boundary this slice crosses deliberately); [ADR-023](./023-socket-io-realtime-transport.md) §3 (handshake authentication), §4 (room naming), §5 (the event/ack contract), §8 (socket rate limiting), §11 ("no agent-facing socket surface"); [ADR-024](./024-widget-realtime-chat-client.md) §4 (id-based de-duplication at a single append point — the rule this slice reuses for a second client); [ADR-017](./017-organization-context-and-rbac.md) §1 (the tenant is a path segment), §5 (role read from the database per request), §6 (one opaque refusal), §7 (`requirePermission`); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §4 (tenant-scoped repository discipline); [ADR-015](./015-access-token-verification-and-current-user.md) §1 (the staff authentication boundary this slice reuses unchanged); [ADR-018](./018-rate-limiting-and-security-headers.md) §3–4 (limiter classes and keying); CONTRIBUTING.md ("Socket rooms must be scoped by organization"; "Never rely only on frontend filtering")

## Context

Every piece of a two-sided conversation exists except the second side.

ADR-022 built `Conversation` and `Message` and stopped at the customer's own
reach: its §15 states that no route can produce `senderType: "agent"`.
ADR-023 built a real-time transport and restated the same boundary in §11 —
"no agent room, no agent-side events, no `senderType: "agent"` reachable from
any handler this slice adds". ADR-024 gave the customer a live chat panel.
The dashboard, meanwhile, still renders three sample statistics with a
`SAMPLE DATA` badge and a note saying no conversation model is read.

So a customer can open Serviqo's widget, send a message, and watch it
persist — and nobody at the tenant can see it. This slice closes that, and
does so in the narrowest form that is genuinely usable: a list, a thread, a
composer, and live delivery in both directions.

Two structural facts shape everything below.

**First, ADR-023 §12 deferred a decision to this slice by name.** REST-created
messages do not broadcast, because `createApp` builds an Express app with no
HTTP server and therefore no `io` to inject. §12 refused to solve that with a
module-scope `io` singleton or a `createApp`-owned socket dependency, and said
the right answer was "a domain event bus that the agent inbox will need
anyway for agent-sent messages", to be decided "there … with both consumers
visible instead of guessing at the second one now". Both consumers are now
visible. §2 below is that decision.

**Second, the agent principal already exists in full.** ADR-015 verifies a
staff access token, ADR-017 resolves the tenant from a path segment and reads
the role from the database on every request, and `requirePermission` enforces
a named permission. This slice introduces **no new credential, no new token
format, no new login, and no new session store**. It adds two permissions to
an existing catalogue and one path through an existing handshake. That is the
whole of its identity story, and §9 states it as a hard constraint because
"the agent inbox needs its own auth" is the single most tempting wrong turn
available here.

## Decisions

### 1. A staff-facing surface module, `modules/agentInbox/`, mirroring `modules/widget/`

CONTRIBUTING.md reserves `modules/<domain>/` for business domains. An agent
inbox is not one: it introduces no persisted resource. It reads
`Conversation` and `Message` — models ADR-022 gave to `modules/conversations/`
and `modules/messages/` — and it writes a `Message` through the service that
already owns that write.

The codebase has already answered what to do with a *surface* that spans two
domains without owning either: `modules/widget/` is exactly that. It holds
routes, a controller, validation schemas, and response projections for the
customer-facing view of conversations and messages, while the models and
services stay where they belong. `modules/agentInbox/` is its symmetric twin
on the staff side.

```
src/modules/agentInbox/
├── agentInbox.routes.ts      — route definitions and the middleware chain (§3)
├── agentInbox.controller.ts  — request → service → response, nothing else
├── agentInbox.validation.ts  — query and body schemas (§6)
└── agentInbox.responses.ts   — the staff-facing projections (§7)
```

Naming it `agentInbox` rather than `conversations` is deliberate. A top-level
`modules/conversations/` already exists and owns the model; a second module
with a near-identical name would make "which one holds the repository?" a
question every reader has to re-answer. `agentInbox` names the *surface*, the
way `widget` does.

**Rejected: putting these routes in `modules/organizations/`.** They mount
under the organization path prefix (§3), which makes that tempting. But
`organization.routes.ts` owns the tenant record and its widget installation
settings; conversations are not organization configuration, and the file
would grow a second, unrelated concern whose tests, schemas, and projections
have nothing to do with its first.

**Rejected: adding agent routes to `modules/widget/`.** That module's own
header explains why not: it is the namespace ADR-010 §5 reserved for traffic
that carries no staff credential, and its whole design point is that
`requireAccessToken`, `requireOrganization`, and `requirePermission` are
absent. Mounting staff routes there would destroy the property the file
exists to hold.

### 2. `messageEvents` — an in-process domain event, published by the service, consumed by the transport

This is ADR-023 §12's deferred decision.

`messageService` gains one responsibility: after a message is durably
persisted, it publishes a `message.created` domain event. `createSocketServer`
subscribes to that event and performs every broadcast. **No service imports
`socket.io`, and no transport re-derives who should receive a message.**

```
messageService.create*(…)  ──persist──▶ MongoDB
        │
        └──publish──▶ messageEvents ──▶ createSocketServer's subscriber
                                              │
                                              ├─▶ conversation room (the customer)
                                              └─▶ inbox room (the tenant's agents)
```

The emitter lives at `modules/messages/messageEvents.ts` — in the domain that
owns the fact, not in `realtime/`. "A message was created" is true whether or
not a socket server exists in this process; it is not a transport concern that
happens to be phrased as an event. `realtime/` holds the *subscriber*, which
is the transport concern.

**Why this rather than the three alternatives §12 named.**

- *Injecting `io` into controllers* would make `createApp` depend on a socket
  server it does not construct (ADR-023 §2 keeps `createApp` free of an
  `http.Server` precisely so `supertest` needs no listening socket). Every
  existing controller test would have to supply an `io` stub.
- *A module-scope `io` singleton* has the same reach with none of the type
  safety, and makes "did this test leave a socket server behind?" a question
  every suite inherits.
- *Doing nothing* stops working the moment an agent replies, which is this
  slice.

The event carries the already-persisted, already-projected message plus the
`organizationId` and `conversationId` needed for routing. It carries no
Mongoose document — a subscriber must not be able to write through an event
payload — and no request-scoped logger.

**Publication is best-effort and never fails the write**, matching exactly
how `messageService` already treats `touchLastMessageAt` (ADR-022 §10): the
message the caller asked to send is durably stored before the event is
published, so a throwing subscriber must not turn a successful send into a
500. A subscriber error is caught, logged as an event name, and swallowed.
Node's `EventEmitter` dispatches synchronously, so without that guard one bad
listener would propagate into the caller's `await`.

**The subscriber is registered per socket server and unregistered with it.**
`createSocketServer` subscribes on construction and removes its listener when
the `http.Server` it is attached to closes. A module-scope emitter with
per-instance subscribers is only safe if the subscribers are actually removed;
tests construct and tear down several servers in one process, and a leaked
subscriber holding a closed `io` is a broadcast into nothing at best and a
cross-test delivery at worst.

**The inline broadcast in `handleSend` is deleted, not kept alongside.** ADR-023's
socket handler emitted `message:new` itself, immediately after
`messageService.create` returned. With the event seam in place that would fire
twice for every socket-sent message — the handler's own emit and the
subscriber's. One emit path, and it is the subscriber's. §8 covers why the
sender still does not see a duplicate.

### 3. Four routes under the organization path prefix, behind the existing four-middleware chain

```
GET  /api/v1/organizations/:organizationId/conversations
GET  /api/v1/organizations/:organizationId/conversations/:conversationId
GET  /api/v1/organizations/:organizationId/conversations/:conversationId/messages
POST /api/v1/organizations/:organizationId/conversations/:conversationId/messages
```

Mounted in `api.routes.ts` as its own prefix with `Router({ mergeParams: true })`,
so `:organizationId` reaches this router's middleware without
`organization.routes.ts` being touched.

**The tenant is a path segment because ADR-017 §1 made that structural**: a
URL cannot be addressed without naming a tenant, `requireOrganization` reads
`req.params.organizationId` and consults no other source, and a body or query
value is never looked at. That is also why this slice needs no new tenant
resolution code at all — it reuses the middleware verbatim.

Every route mounts the identical chain, in the order ADR-017 §8 fixed:

```
requireAccessToken            who is calling
rateLimiters.authenticated*   bound the now-identified caller (ADR-018 §4)
requireOrganization           which tenant, and may they act in it
requirePermission(…)          does their role hold this permission
validateBody(…)               (writes only) is the input well-formed
controller.…
```

The rate limiter sits before `requireOrganization` on every route, matching
`GET /organizations/:organizationId`'s own comment: a caller must not be able
to spend database lookups probing organization ids they hold no membership in.

**Rate-limiter classes are reused, not invented.** Reads take
`authenticatedRead`, the write takes `authenticatedWrite` — the same classes
`organization.routes.ts` uses, keyed by the verified user. ADR-018's own rule
is one policy answer per traffic shape; an agent reading an inbox is an
authenticated staff read, and an agent replying is an authenticated staff
write. A new class would be a second answer to a question already answered.

There is one honest caveat, stated rather than hidden:
`AUTHENTICATED_WRITE_LIMIT` is 30 per hour, chosen in ADR-016 §2 for
organization creation and reused in ADR-020 for configuration writes. An agent
sending replies is a *higher-frequency* activity than either. This slice
accepts the bound as-is rather than widening a shared class from inside a
feature slice, and §13 records it as a known limitation with the specific
follow-up (an `agentConversationWrite` class mirroring
`WIDGET_CONVERSATION_WRITE_LIMIT`, whose numbers already describe exactly this
traffic shape). The socket path, which is what the inbox UI actually uses for
sending under normal operation, is not affected — but the REST route is the
contract, and a contract with a low bound is a limitation, not a detail.

### 4. Two new permissions: `conversation.read` and `conversation.reply`

`permissions.ts` says a permission "joins this union in the slice that
enforces it", and names `conversation.read` as a `PROJECT_CONTEXT.md` §5
permission deliberately withheld until something enforced it. This is that
slice.

| | owner | admin | supervisor | agent |
|---|---|---|---|---|
| `conversation.read` | ✅ | ✅ | ✅ | ✅ |
| `conversation.reply` | ✅ | ✅ | ✅ | ✅ |

Every role holds both, and that is a real decision rather than a shrug.
`ROLE_PERMISSIONS`'s existing comments define `agent` as the role that
"handles conversations" and `supervisor` as the one that "oversees people and
queues" — both descriptions are of people who read and answer conversations.
Owner and admin already hold every permission in the catalogue.

The table being uniform today does **not** make the permissions redundant, for
two reasons. It separates reading from replying, so a future read-only role
(the "custom roles" `PROJECT_CONTEXT.md` §5 anticipates, or an analytics
integration) is a table edit rather than a code change. And `requirePermission`
is what makes the check exist at all — a route that named no permission would
be a route that could not later acquire one without auditing its callers.

`customer` is absent and stays absent: a customer holds no `Membership` and so
carries no role at all (ADR-010 §2).

### 5. Conversation listing: organization-scoped, most-recently-active first, keyset-paginated

`conversationRepository` gains two methods, both scoped by `organizationId`
and both following ADR-022 §1's rule that there is no lookup taking fewer keys
than the tenant boundary:

- `listByOrganization(organizationId, { cursor, limit })`
- `findByIdForOrganization(conversationId, organizationId)`

The existing customer-scoped methods (`findOpenByCustomer`,
`findByIdForCustomer`) are **unchanged and still used by the widget**. An
agent-facing lookup takes two keys rather than three because an agent is
legitimately entitled to every conversation in their own tenant, and to
none outside it. That difference is the entire agent/customer authorization
distinction, and it is expressed as *which repository method the caller may
reach*, not as a flag on one shared method.

**Ordering is `lastMessageAt` descending, `_id` descending as tiebreak.**
`conversation.model.ts` stored `lastMessageAt` rather than deriving it for
precisely this query, and said so: "a future 'most recently active first'
listing (the agent inbox's central query) sorts on one indexed field instead
of joining against `Message` per row". A supporting index
`{ organizationId: 1, lastMessageAt: -1, _id: -1 }` is added, covering the
equality filter and the sorted, ranged scan in one.

**Pagination is keyset, not offset**, reusing ADR-022 §11's shape and its
`limit + 1` probe for `nextCursor`. `lastMessageAt` is not unique, so the
cursor is a composite — `<lastMessageAt ISO>_<_id>` — and the range predicate
is the standard lexicographic-tuple form:

```
lastMessageAt < cursorDate
  OR (lastMessageAt = cursorDate AND _id < cursorId)
```

A cursor over a non-unique sort key that ignored the tiebreak would silently
skip or repeat rows whenever two conversations shared a millisecond, which is
common the moment a tenant is busy. The cursor is opaque to the client and
strictly validated on the way back in; a malformed one is a `400`, decided
purely by the submitted string's shape and therefore safe to answer
specifically (the same reasoning `widget.controller.ts` applies to a malformed
`:conversationId`).

`lastMessageAt` is maintained best-effort (ADR-022 §10), so a failed touch
means a conversation sorts stale rather than disappearing. That trade-off is
inherited knowingly, not re-litigated here.

### 6. `senderType: "agent"` is a literal in one function, and no schema anywhere accepts it

ADR-022 §5's rule was that `senderType` is assigned inside the service as a
literal and is never a parameter tracing back to request input. That rule does
not weaken because a second value is now reachable — it is applied a second
time.

`messageService` gains `createFromAgent`, whose body assigns
`senderType: "agent"` as a literal, exactly as `create` assigns `"customer"`.
There is **no** `senderType` parameter, no `create(…, senderType)` refactor,
and no shared internal helper that takes the value as an argument. Two
functions, two literals, two call sites — a caller reaches `"agent"` only by
calling the function that is mounted behind `requirePermission("conversation.reply")`.

The request body schema for the agent send is `{ body }` and nothing else,
matching `createMessageSchema` field for field. A client that posts
`senderType`, `customerId`, `organizationId`, or `conversationId` in the body
has those fields **stripped** by Zod before the controller runs (ADR-022 §5),
not rejected — so a forged value cannot even be observed downstream, let alone
used.

`customerId` on an agent's message is copied from the `Conversation` document
the server just loaded under the caller's own `organizationId`. It is never
read from the request in any form. This matters more than it looks:
`Message.customerId` means "which customer this conversation is with"
(ADR-022 §4), not "who sent this", so a forged value would mis-file a message
into another customer's history. The forgery is impossible because the field
has exactly one source and it is a document, not an input.

### 7. Staff response projections are their own file, and deliberately show more than the widget's

`agentInbox.responses.ts` holds the staff-facing projections. It does not
reuse `widgetResponses.ts`, and the difference is the point.

`toConversationResponse` in `widgetResponses.ts` deliberately omits
`organizationId` and `customerId` because the customer already knows both and
echoing them discloses nothing. An agent's list row needs something entirely
different: **which customer** a conversation is with, so the inbox is
readable. So the staff projection carries a small customer summary —
`{ id, name, email }` — where the widget's carries neither.

That is a genuine disclosure decision, so it is stated: an agent sees the name
and email a visitor typed into their own tenant's widget, and nothing else
about them. No `lastSeenAt`, no IP address, no user agent — `Customer` stores
none of the last two by design (`customer.model.ts` explains why), so there is
nothing here to leak even by accident.

Message projection is shared. `toMessageResponse` already returns exactly
`{ id, conversationId, senderType, body, createdAt }`, which is the correct
shape for both audiences, and it already lives in a file ADR-023 §7 extracted
from the controller so a second transport would call the same projection
rather than a second copy of it. A third consumer reusing it is that decision
working.

### 8. Rooms: the existing conversation room, plus one inbox room per organization

ADR-023 §4 established `org:<organizationId>:conversation:<conversationId>`.
That room is unchanged and still holds exactly the customer sockets that
joined it.

This slice adds one room name:

```
org:<organizationId>:inbox
```

Derived by a function beside `conversationRoomName`, in the same file, for the
same reason that file gives — "one function, so nothing joins or broadcasts to
a room built any other way". It is scoped by organization and by nothing else,
satisfying CONTRIBUTING.md's non-negotiable rule directly: an agent socket
joins its own tenant's inbox room and there is no room name it could construct
that would reach another tenant's.

Every `message.created` event is broadcast twice, to two disjoint audiences:

| Message | conversation room | inbox room |
|---|---|---|
| customer → | the customer's own sockets | the tenant's connected agents |
| agent → | the customer's sockets | the tenant's other agents (and the sender) |

An agent socket joins **only** the inbox room. It is never added to a
conversation room, so "which conversations is this agent watching?" is not
state the server tracks, and an agent cannot be in a conversation room for a
tenant they were never authorized in. Agents receive every message in their
own tenant and filter client-side for display — which is a UX decision, not a
security one, because the server has already proved tenancy before the socket
joined anything.

**Duplicate suppression.** A sender receives both an ack and the room
broadcast — for customers over the socket, and for agents whose REST `201`
response and inbox broadcast describe the same message. ADR-024 §4 already
solved this once, with a single append point keyed on the server-assigned
`Message._id`, and its own comment explains why `_id` is the right identity
(server-assigned, immutable, globally unique). The agent inbox uses the
identical rule with the identical justification. It is *one* mechanism at
*one* place in each client, not a per-path guard, because the number of paths
by which the same message can arrive only ever grows.

### 9. One authentication system: the socket handshake gains an agent path, not a second identity

`authenticateSocketToken` currently resolves a widget token. It gains a second
branch that resolves a **staff access token**, using the primitives that
already exist and no others:

| Step | Reused from |
|---|---|
| verify the bearer credential | `verifyAccessToken` (ADR-015 §2) |
| prove membership in the tenant | `membershipRepository.findByUserAndOrganization` (ADR-017 §3) |
| membership is `active` | ADR-017 §2 gate 2 |
| organization exists and is `active` | ADR-017 §2 gates 3–4 |
| role holds `conversation.read` | `can()` (ADR-017 §7) |

That is `requireOrganization`'s exact sequence of proofs, in its exact order,
against its exact repositories. **No new token format, no new signing key, no
new session store, no socket-specific credential.** ADR-023 §3 already
established the shape — orchestration is not shared with the Express
middleware because the control-flow models differ, while every primitive that
touches a credential or the database *is* shared — and this branch follows it
verbatim.

**Which branch runs is decided by the handshake payload's shape, not by
trial-and-error.** A handshake presenting `{ token, organizationId }` takes the
agent path; `{ token }` alone takes the widget path. Sniffing — try one
verifier, fall back to the other — is rejected: the two token formats are
signed with *different keys* and carry different audiences (ADR-019 §8), and a
fallback chain is exactly the structure in which a future third format
silently verifies as the wrong principal type. An explicit discriminator makes
the intended principal type part of the request.

The agent handshake carries `organizationId` because a staff access token
deliberately contains no tenant claim (ADR-011 §2: role and organization are
resolved per request, never baked into a token). The client naming a tenant is
**not** the client authorizing itself — the server proves membership in that
exact tenant before the connection is accepted, and a forged `organizationId`
resolves to a membership lookup that returns `null`. This is the identical
posture ADR-017 §1 takes for the REST path segment, and `OrganizationSwitcher.tsx`
already states the principle for the dashboard: "selecting one changes which id
the client puts in subsequent URLs and nothing else. The server re-proves the
choice on every request."

**Refusals stay opaque.** Every agent-handshake failure — bad token, expired
token, not a member, membership suspended, unknown organization, suspended
organization, role without `conversation.read` — produces the same
`connect_error` message the widget path already uses for a session refusal.
The distinctions are logged with a `reason` for operators and reach no client,
which is ADR-017 §6's rule applied to a handshake. In particular, "not a
member" must not be distinguishable from "no such organization": that
difference would turn any authenticated staff account into an oracle for which
tenant ids are real.

Socket connection rate limiting (ADR-023 §8) applies to the agent handshake
unchanged — it is keyed by address inside `io.use` before either branch runs.

### 10. Cross-tenant and unknown conversation ids stay indistinguishable

An agent requesting a conversation that does not exist, and an agent
requesting one that exists inside another tenant, receive byte-identical
responses: `404` with `ConversationNotAccessibleError`'s single message.

This is not a comparison the controller performs. It falls out of
`findByIdForOrganization` taking both keys in one query (ADR-022 §1, ADR-019 §4):
a conversation under another `organizationId` simply does not match, and the
service raises the same error it raises for a fabricated id. There is no
branch that could drift, because there is no branch.

The same holds one level up: an agent naming another tenant in the *path*
never reaches a conversation lookup at all — `requireOrganization` refuses
first, with `OrganizationNotAccessibleError`'s own single message, which is
likewise identical for "no such organization" and "not a member".

`403 INSUFFICIENT_PERMISSION` is the one specific refusal, and it is specific
for ADR-017 §6's stated reason: by the time `requirePermission` can run,
membership has been proved, so the caller demonstrably already knows the
organization exists and that they work there. Telling them their role is
insufficient discloses nothing new. The permission's *name* is still withheld
from the response.

### 11. The inbox is a dashboard feature, mounted keyed by organization

`features/inbox/` in `apps/web/src`, following the folder convention
`features/organizations/` established, and rendered from `DashboardPage`
beneath the organization switcher.

**Keyed by `organizationId`**, exactly as `WidgetInstallation` already is, and
for a reason this slice makes sharper: switching tenants must *remount* the
inbox, not reconcile one tenant's conversations, unread counts, selected
thread, and open socket into a component that just finished rendering
another's. A `key` makes that structural — React discards the subtree,
including the socket connection, which is the only way to be certain no
message from the previous tenant can land in the new one's list. Filtering by
`organizationId` in an effect would be the "rely only on frontend filtering"
CONTRIBUTING.md forbids; the key makes the state itself unable to survive.

The socket layer is one module (`features/inbox/inboxRealtime.ts`) that owns
the `socket.io-client` import and takes an injectable factory, mirroring
`widget/realtime.ts` — which is what lets every test in this slice run against
a fake with no network.

Dev-server note: `vite.config.ts` proxies `/api` so the dashboard and the API
share an origin. `/socket.io` needs the same treatment with `ws: true`, or the
dashboard's socket would be cross-origin in development while being
same-origin in production — a difference that hides exactly the kind of bug
the existing proxy comment exists to prevent.

States rendered: loading, empty, error, forbidden (`403`), and the ordinary
list. **Forbidden is its own state, not an error message**, because it is the
one refusal that is neither transient nor retryable — a role without
`conversation.read` will get the same answer forever, and offering "try again"
would be a lie.

### 12. What this slice does not do

- **No ticketing, no AI, no attachments, no typing indicators, no read
  receipts, no presence.** Each is a named ROADMAP phase and each needs either
  a persisted concept or a broadcast contract this slice was not asked to
  design.
- **No persisted unread state.** The unread indicator is client-side and
  per-mount: a count of messages that arrived over the socket for a
  conversation that is not currently selected, cleared on selection and gone on
  reload. Persisting it means deciding what "read" means for a conversation
  with several agents, which is read-receipt design — explicitly excluded. The
  indicator is honest about being a session-local hint because it never claims
  otherwise in the UI.
- **No conversation assignment, no ownership, no queues.** Every agent in a
  tenant sees every conversation in it. ROADMAP Phase 5's "assigned
  conversations" needs an assignment model that does not exist.
- **No closing or reopening conversations.** `status` supports it; no route in
  this slice sets it, which is unchanged from ADR-022.
- **No Redis, no cross-process rooms.** The inbox room lives in one process's
  memory alongside the conversation rooms, inheriting ADR-023 §11's ceiling
  unchanged. A second server process would see neither.
- **No agent-initiated conversation.** An agent replies to a conversation a
  customer opened; there is no "message a customer first", which would need a
  delivery channel to a visitor who is not on the page.
- **No change to any widget behaviour.** `widget.routes.ts`,
  `widget.controller.ts`, `widgetResponses.ts`, and the customer-facing
  service methods are untouched. The one observable change on the customer
  side is a *fix*: a REST-sent message now broadcasts, closing ADR-023 §12.

### 13. Known limitations carried forward

- **`authenticatedWrite`'s 30/hour bound is low for an agent replying over
  REST** (§3). The socket path is the one the UI uses; the REST route is
  correct but tightly bounded. The follow-up is a dedicated
  `agentConversationWrite` class reusing `WIDGET_CONVERSATION_WRITE_LIMIT`'s
  numbers, which already describe this exact traffic shape.
- **Socket and REST message-sends still do not share a rate-limit budget**
  (ADR-023 §8's stated gap), now true for agents as well as customers.
- **The inbox list is not live-reordered on every message.** A new message
  updates the unread indicator and the thread; the list's `lastMessageAt`
  ordering refreshes on the next fetch. Continuous re-sorting under live
  traffic is a UX problem (rows moving under a click) that deserves its own
  decision.
- **No pagination UI.** The first page of conversations and the first page of
  messages are fetched; `nextCursor` is returned by both endpoints and unused
  by the client. The server contract is complete and the client is not, which
  is the honest split for a first slice.

## Consequences

- Serviqo has a working two-sided conversation for the first time: a customer
  message reaches a connected agent live, and an agent reply reaches the
  customer's widget live, over the transport ADR-023 built.
- Message broadcasting is decoupled from the socket handler. Any future writer
  of messages — an AI responder, an automation rule, an email-to-conversation
  ingest — broadcasts correctly by calling the message service, with no
  knowledge that Socket.IO exists. ADR-023 §12 and ADR-024 §11's shared gap is
  closed for every producer at once rather than for one.
- `senderType: "agent"` becomes reachable, through exactly one function,
  behind exactly one permission, with no schema anywhere accepting the value
  from a client. ADR-022 §15 and ADR-023 §11's boundary is crossed
  deliberately and narrowly rather than eroded.
- The permission catalogue gains its first non-organization permissions, and
  `requirePermission` gains its first enforcement outside
  `modules/organizations/` — evidence that ADR-002 §7–19's "no scattered
  `if (role === 'admin')`" shape holds as the product widens.
- The dashboard reads real tenant data for the first time. The `SAMPLE DATA`
  section stays exactly as it is, still labelled, because nothing in this slice
  makes those three figures real.
