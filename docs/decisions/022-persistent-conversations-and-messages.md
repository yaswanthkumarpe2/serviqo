# ADR-022: Persistent Conversations and Messages

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (persistence/API slice — precedes Socket.IO, the agent inbox, and AI)
**Implements:** ROADMAP.md Phase 6 ("Persistent conversations / messages")
**Related:** [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §1 (the four identifiers, none of them a lookup key), §6 (the widget token), §8 (widget token shape and verifier), §12 (one opaque refusal); [ADR-021](./021-embeddable-widget-loader-shell-and-isolation.md) §5 (the widget's minimal per-route CORS); [ADR-017](./017-organization-context-and-rbac.md) §1–2 (tenant identifiers are server-derived, never client-supplied); [ADR-018](./018-rate-limiting-and-security-headers.md) §3–4 (limiter classes, keyed reads/writes); ADR-010 §7 ("organizationId is derived server-side from the widget credential, never read from the request body" — this slice's central rule, applied to a second resource)

## Context

ADR-019 built the widget token and deliberately built nothing that uses it:
"It builds no conversation, no message, no socket, and no widget UI." ADR-021
closed the UI half of that gap. This closes the persistence half: a
`Conversation`, a `Message`, and the three endpoints that let an already-
authenticated widget visitor create one and populate it.

This is explicitly **not** the real-time slice. No Socket.IO, no agent
inbox, no AI, no typing indicators. A message sent through this slice is
durable the moment the response returns and invisible to everyone until a
later slice delivers it — which is an accurate description of a REST API
with no push transport, not a limitation to apologize for.

## Decisions

### 1. Conversation identity: two required keys, and no lookup path with fewer than both

A `Conversation` belongs to exactly one `organizationId` and one
`customerId`, both required, both immutable after creation. Every
repository method that reads or writes one takes both — there is no
`findById(conversationId)` alone, for the same reason `customerRepository`
has none: a comparison written by hand after a broader fetch has failure
modes that are all quiet, and the method's absence is the control rather
than a rule callers are trusted to follow (ADR-019 §4).

The customer-facing surface additionally requires the caller's OWN
`customerId`, sourced from the verified widget token and never from the
request (§5) — so a lookup on the customer-facing path is always
`{ _id: conversationId, organizationId, customerId }`, three keys in one
query, matching the exact shape ADR-019 §4 used for `Customer`.

### 2. `Conversation` fields

```
organizationId  ObjectId  required, ref Organization, immutable
customerId      ObjectId  required, ref Customer, immutable
status          "open" | "closed"   default "open"
lastMessageAt   Date      required, default now
createdAt       Date      timestamps
updatedAt       Date      timestamps
```

**`status` supports exactly two values.** ADR-010 §9's ticketing states
(`OPEN`, `IN_PROGRESS`, `WAITING_CUSTOMER`, …) belong to `Ticket`, a
different model with a different owner (support staff working a queue) and
a different lifecycle. A `Conversation` is simpler: it is being talked in,
or it is not. Introducing a third state now would be modeling a workflow
this slice has no consumer for.

**`lastMessageAt` is a real field, not a derived one**, because the next
slice's central query — "list this organization's conversations, most
recently active first" — needs a single sortable, indexed value. Computing
it by joining against `Message` on every read would make listing an
O(conversations × messages) operation; storing it makes updating one field
per message the cost instead. It defaults to the conversation's own
creation time, so a conversation with no messages yet still sorts
correctly rather than sorting as `null` or requiring a special case.

**`updatedAt` is kept**, unlike `Message` (§4) — `status` is expected to
change (closing a conversation is the one mutation this model has), so
`updatedAt` answers a real question here: "when did this conversation's own
state last change," distinct from "when did it last receive a message"
(`lastMessageAt`). The two are expected to diverge the moment a conversation
is closed without a new message, which is exactly the case that would make
one field ambiguous if it had to serve both meanings.

### 3. At most one open conversation per customer, enforced by the database

A customer has zero or one **open** conversation per organization, never
two. Enforced structurally, not by an application-level check-then-create:

```js
conversationSchema.index(
  { organizationId: 1, customerId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "open" } },
);
```

The exact instrument `membership.model.ts` index B uses for "at most one
owner per organization" (ADR-004's precedent, restated by ADR-019 §3),
applied here to mean "at most one open conversation per customer." Partial,
so it constrains only `open` documents — a customer may accumulate any
number of `closed` conversations over time, and closing one and starting a
new one is not a constraint violation.

**Why one, not many.** ADR-010 §7 left this open; nothing in the roadmap
between here and the agent inbox needs concurrent open conversations per
customer, and "one visitor, one active conversation" is the simpler
invariant for both the widget UI (no conversation picker needed) and a
future agent inbox (no "which of this customer's three open threads" — a
customer's card resolves to exactly one live conversation). Multi-topic
concurrency, if it is ever wanted, is additive: a database-level constraint
can be relaxed later; a race condition introduced by not having one cannot
be fixed by application code alone once concurrent creates have already
raced.

**Why database-level, not "check then create."** Two requests racing —
double-clicking a launcher button hard enough, or a retried fetch after a
flaky connection — would otherwise both observe "no open conversation
exists" and both create one, and the second `Customer.recordVisit`-style
resolution would silently orphan whichever conversation lost the race. The
unique index turns that race into a duplicate-key error on the losing
write, which `conversation.service.ts` (§7) catches and resolves by
**reading** the conversation the winner just created — the same "the
database is the arbiter, the service reacts to what it says" posture
`organization.model.ts`'s partial-unique slug-adjacent indexes already
establish elsewhere in this codebase.

### 4. `Message` fields

```
organizationId  ObjectId  required, ref Organization, immutable
conversationId  ObjectId  required, ref Conversation, immutable
customerId      ObjectId  required, ref Customer, immutable
senderType      "customer" | "agent"   required, immutable
body            String    required, trimmed, bounded (§9)
createdAt       Date      timestamps: { createdAt: true, updatedAt: false }
```

**`customerId` is stored on every message, including a future agent one.**
It is not "who sent this" — `senderType` is — it is "which customer this
conversation is with," copied from the owning `Conversation` at creation.
Denormalized deliberately: a message list is the highest-read-volume query
this slice has, and every response element already needs to prove it
belongs to the caller's conversation. Carrying the value avoids a join back
to `Conversation` for that proof and costs one ObjectId per document.

**`senderType` is an enum of two today, and the model does not assume
there will only ever be two.** ADR-010's `PROJECT_CONTEXT.md` §8 names five
eventual senders (`CUSTOMER`, `HUMAN_AGENT`, `AI_AGENT`, `SYSTEM`,
`AUTOMATION`); this slice implements the one sender that exists
(`customer`) and reserves `agent` as the type the model already supports so
the next slice extends an enum rather than migrating a schema. **No route
in this slice can produce `senderType: "agent"`** (§5) — the model
supporting a value and an endpoint being able to assign it are deliberately
two different questions, and only the first is this slice's to answer.

**No `updatedAt`.** Messages are immutable in this slice — there is no
edit and no delete endpoint — so `updatedAt` would be a field nothing ever
writes and nothing ever reads, the same category of absence ADR-019 §2
argued for `Customer.status`. Mongoose's `timestamps: { createdAt: true,
updatedAt: false }` gives exactly the one that means something.

**Not stored, and not a gap:** no read/delivery state (no consumer exists —
that is Socket.IO territory), no attachment reference (out of scope by the
prompt), no edit history. `IP address` and `user-agent` are deliberately
absent from `Message` for the identical reason ADR-019 §2 kept them off
`Customer`: this is visitor data collected for no consumer, and the
architecture already drew this line once.

### 5. The client never supplies `organizationId`, `customerId`, or `senderType` — structurally, not by convention

`widgetConversation.validation.ts`'s Zod schemas name every field a
request body is permitted to carry. `createMessageSchema` names exactly
`body`. A client that sends `customerId`, `organizationId`, `senderType`,
or `conversationId` in the body has every one of those fields **stripped**
by `validateBody` before the handler runs (ADR-019 §12's own instrument,
applied here) — not rejected, not ignored by convention, structurally
absent from what the service receives. `senderType` is never a schema
field on any customer-facing endpoint; the message service assigns the
literal `"customer"` itself. A client cannot make itself an agent by
sending the string `"agent"` anywhere, because no code path reads a
client-supplied value into that field at all.

`organizationId` and `customerId` come from exactly one place on every
route this ADR adds: `req.widgetPrincipal`, set by `requireWidgetToken`
(§6) from the verified token's claims. This is ADR-010 §7's rule —
"`organizationId` is derived server-side from the widget credential, never
read from the request body" — applied to the second identifier the same
credential asserts.

### 6. `requireWidgetToken`: the customer-facing authentication AND tenant boundary in one middleware

A new middleware, `middleware/requireWidgetToken.ts`, mirrors
`requireAccessToken` (verify the credential) fused with what
`requireOrganization` does for staff (prove the tenant is still real and
still active) — fused because a widget token has no separate "membership"
to check; the token's own `org` claim and the `Customer` it names are the
entire relationship.

```
Authorization: Bearer <widget token>
```

1. **Missing or malformed header, or a token that fails `verifyWidgetToken`**
   (bad signature, wrong issuer/audience, expired, malformed claims) →
   `401 INVALID_WIDGET_TOKEN` — a new error class, the widget-token
   sibling of `InvalidAccessTokenError`, with the identical one-message-for-
   every-reason posture (ADR-015 §6) and the identical reason this table
   restates: "expired" is withheld from the response because the only
   caller it would help is one holding a token they were not issued.
2. **The token verifies, but its `organizationId` no longer resolves to an
   active `Organization`** (deleted, or suspended after the token was
   issued — a widget token cannot be revoked early, ADR-019 §14) →
   `403 WIDGET_SESSION_REFUSED`, **reusing** the exact error ADR-019 built
   for `/widget/session` rather than minting a new one. This is
   deliberate: a suspended tenant refuses a widget request for the same
   reason whether the caller is presenting a fresh `widgetKey` or an
   already-issued token, and giving the two cases different response
   shapes would let a caller distinguish "your key is fine but the tenant
   is suspended" from "your session is fine but the tenant is suspended" —
   a distinction with no legitimate consumer.
3. **The token verifies and the organization is active, but no `Customer`
   exists at `{ _id: customerId, organizationId }`** (the record was
   removed) → the same `403 WIDGET_SESSION_REFUSED`, for the identical
   reason.

Every distinguishing `reason` above reaches the log and never the response
body — the established pattern this file's every predecessor uses.

On success, `req.widgetPrincipal = { customerId, organizationId }` is set —
a new, minimal request-augmentation type in `types/express.d.ts`, the
customer-facing sibling of `principal`/`organizationContext`. Nothing
downstream re-verifies the token; nothing downstream re-loads the
`Customer`. One verification, one database read for the organization, one
for the customer, per request — the same cost `requireOrganization` already
pays for staff traffic.

**Origin is not re-checked here.** ADR-019 §10's `allowedOrigins` policy
gates *minting* a token — a browser on an unapproved site was never able to
obtain one. Re-checking `Origin` on every subsequent authenticated request
would be a second control over an action (using a token you already hold)
that the first control was never designed to gate, and ADR-021 §5 already
established that CORS on this router is a *readability* concern, not the
authorization boundary. The authorization boundary for these routes is the
token, full stop — matching how a staff access token is never re-checked
against the `Origin` that originally produced a login.

### 7. Services: `conversationService.resolveOpen`, `messageService.create`, `messageService.list`

`conversationService.resolveOpen(organizationId, customerId)`:

1. Reads the customer's open conversation via the partial-index-backed
   query (§3).
2. If found, returns it.
3. If not found, attempts to create one. If the create raises a duplicate-
   key error on the §3 index — a race with a concurrent request from the
   same customer — it re-reads rather than propagating the error, because
   the outcome the caller actually wants ("my open conversation") exists
   either way; which request's `create()` call physically won is not a
   fact either caller has a use for.

This is the one place in this slice a database error is caught and
reclassified rather than left to `errorHandler`. It is caught narrowly —
by MongoDB's duplicate-key code, matching how `organization.repository.ts`
distinguishes a slug collision from every other write failure — so an
unrelated database fault still surfaces as the generic 500 it should.

`messageService.create(organizationId, customerId, conversationId, body)`:

1. Loads the conversation scoped by all three ids (§1) — a conversation
   that does not exist, or exists under a different organization, or
   belongs to a different customer, produces the identical outcome (§8).
2. Persists the message with `senderType: "customer"`, assigned as a
   literal, never a parameter that traces back to request input.
3. Best-effort updates `Conversation.lastMessageAt` (§10 — not a
   transaction, and here is why that is acceptable).
4. Returns the minimal message shape (§13).

`messageService.list(organizationId, customerId, conversationId, { cursor, limit })`
performs the identical ownership check as step 1 above, then delegates to
`messageRepository.list` (§11).

### 8. Enumeration resistance: an unknown conversation and someone else's conversation look identical

`ConversationNotAccessibleError` (`404 NOT_FOUND`) is raised for every one
of: no conversation exists at that id; a conversation exists but under a
different organization; a conversation exists under the right organization
but belongs to a different customer. One error class, one message,
mirroring `OrganizationNotAccessibleError` exactly and for the identical
reason (ADR-017 §6): a `403` here would confirm the id names a real
conversation, and telling a caller "this exists, but is not yours" is
strictly worse than telling them nothing, because it turns a guessed
ObjectId into a yes/no oracle. `404` rather than an opaque widget-style
`403` because this is a **resource-scoping** question, symmetrical with how
staff organization access already answers it — not a **credential**
question, which is what `WidgetSessionRefusedError` is reserved for (§6).

### 9. Message validation: non-empty, bounded, control characters rejected, never silently altered

```ts
body: z.string().trim().min(1).max(MESSAGE_BODY_MAX_LENGTH).refine(no disallowed control characters)
```

**Trimmed, not silently truncated.** A body that is only whitespace fails
`min(1)` after trimming and is rejected with a field-level validation
error, the same `400 VALIDATION_ERROR` shape every other boundary failure
in this codebase produces (ADR-007 §6). An over-length body is likewise
**rejected**, never cut down to fit — `CONTRIBUTING.md`'s "no silent
correctness-affecting behavior" posture, and specifically because silently
storing a truncated message is a worse failure than refusing to store one:
the sender believes they said something they did not.

**`MESSAGE_BODY_MAX_LENGTH = 4000`** (`config/constants.ts`) — a judgment
call, stated as one rather than dressed up as derived: long enough for a
genuine multi-paragraph support question, short enough to bound per-message
storage and the cost of rendering one. **Enforced at two layers**: the Zod
boundary (a client's mistake is rejected before any database call) and a
schema-level `maxlength` on `Message` (the model's own defense, for the
day a second caller — the eventual `AI_AGENT` or `SYSTEM` sender — writes
through the service without passing through this HTTP boundary at all).
Two enforcement points, one shared constant, matching how `allowedOrigins`
validation already runs at both the Zod boundary and the schema layer
(ADR-020 §3) rather than trusting one to imply the other.

**Control characters, not HTML.** This slice is plain text (the prompt's
own scope line). The validator rejects C0/C1 control characters except
`\t` and `\n` — a chat message is legitimately multi-line, unlike the
single-line `name` field ADR-019 §12 validated, so the blanket
`CONTROL_CHARACTERS` pattern that file uses is deliberately **not** reused
verbatim; a narrower pattern excluding the two whitespace controls a
message body needs is written instead. Nothing here escapes, strips, or
interprets HTML — the response contract (§13) hands the frontend a plain
string, and rendering it as text rather than markup is the consuming
component's obligation, stated explicitly here so it is not rediscovered as
an XSS report later.

### 10. Message creation and `lastMessageAt`: no transaction, and here is the trade-off

`Message.create` and `Conversation.findOneAndUpdate({ lastMessageAt })`
are two separate writes, not one multi-document transaction.

**Why a transaction is not introduced.** `database/connection.ts` connects
to a single `mongod`, not a replica set — Serviqo's MongoDB deployment
shape today, matching every other slice's assumption (the rate limiter's
`MemoryStore` is a documented single-instance assumption for the identical
reason). MongoDB transactions require a replica set. Introducing one would
mean either a second deployment prerequisite this slice invents
unilaterally, or a transaction that silently cannot run in development —
both worse than not having one.

**Why the trade-off is acceptable now.** `lastMessageAt` has **no reader**
in this slice — nothing sorts, filters, or displays by it yet; that
consumer is the agent inbox, a later slice. The failure mode a missing
transaction exposes is: a message is durably persisted, and the
conversation's `lastMessageAt` occasionally does not reflect it (a crash or
a transient write failure between the two calls). The message — the
artifact a customer and, eventually, an agent actually need — is written
**first** and is never at risk from a `lastMessageAt` failure; the second
write is attempted, and if it fails, the error is logged (organization id,
conversation id, message id — never the body) and the request still
succeeds, because the thing the caller asked for (send my message) did.

**When this stops being acceptable**: the moment a query orders or filters
conversations by `lastMessageAt` for a real consumer (the agent inbox), a
staleness bug becomes user-visible, and that is precisely the slice that
should decide whether to add a transaction (now newly justified,
replica-set requirement and all), a periodic reconciliation, or an
event-sourced recomputation. Deciding it here would be guessing at a
consumer that does not exist yet.

### 11. Ordering and pagination: sort and cursor by `_id`, not `createdAt`

Message history is returned in ascending `_id` order, and `_id` — not
`createdAt` — is both the sort key and the pagination cursor.

**Why `_id` rather than `createdAt`.** A MongoDB `ObjectId` embeds a
timestamp and a per-process monotonic counter; generated by one Mongoose
process (today's deployment shape, §10), successive `ObjectId`s are
strictly increasing — a **single field** that is simultaneously unique
(no tie-break ever needed) and chronologically faithful. `createdAt` is a
second, independently-generated `Date` from the same moment; using it as
the sort key would require a compound `(createdAt, _id)` key and a
two-branch keyset predicate (`createdAt > cursor OR (createdAt = cursor AND
_id > cursor)`) to stay deterministic on a tie — real complexity bought for
a guarantee `_id` alone already provides. `createdAt` is still stored and
still returned in every response (§13); it is a **display** fact, not the
ordering mechanism.

**Cursor shape.** `?cursor=<last-seen message _id>&limit=<n>`. The query is
`{ organizationId, conversationId, _id: { $gt: cursor } }`, sorted
`{ _id: 1 }`, limited to `n + 1` rows so the service can tell whether a
further page exists without a separate `count()` call — the extra row is
trimmed before the response is built, and `nextCursor` is the last
*returned* message's `_id` when a further page exists, `null` otherwise.

**Direction.** The first page (no `cursor`) returns the **oldest** messages
first, and each subsequent page moves forward in time. This is the
simpler of the two directions to implement correctly and is chosen
deliberately because no UI consumes this endpoint yet (the prompt's own
scope boundary: no composer, no message list this slice). A UI that wants
"show the latest N, then load older ones scrolling up" is a **different**
pagination shape — reverse-cursor, descending default page — and designing
that correctly should be driven by the actual scroll behavior of the
component that will call it, not guessed at here and rebuilt once that
component exists.

**Bounds.** `MESSAGE_PAGE_DEFAULT_LIMIT = 30`, `MESSAGE_PAGE_MAX_LIMIT =
100` (`config/constants.ts`) — judgment calls, stated as such: thirty is
roughly one loaded screen of history; one hundred bounds the worst case a
client (or a script) can request in one call regardless of what it asks
for. A `limit` above the maximum is **rejected** (`400`), not silently
capped — the same "never silently alter a request" posture §9 states for
the message body, applied to pagination.

**Index.** `{ organizationId: 1, conversationId: 1, _id: 1 }` on `Message`.
Trailing `_id` is what lets MongoDB serve the equality filter (both ids)
and the ranged, sorted scan (`_id > cursor`, ascending) from a single
index, with no in-memory sort stage — the query this slice's one read
endpoint performs, end to end.

### 12. Rate limiting: one new class, keyed by customer

`lib/rateLimit`'s `keyGenerator` gains a `keyByCustomer` option, reading
`req.widgetPrincipal?.customerId` — the exact shape `keyByUser` already has
for `req.principal?.userId`, falling back to the IP key if the field is
absent (a misordered mount degrades rather than throws, matching
`keyByUser`'s own stated reasoning).

**`widgetConversationWrite`** — `POST /widget/conversations` and
`POST /widget/conversations/:id/messages` — keyed by customer.
**60 per 5 minutes.** Not `AUTHENTICATED_WRITE_LIMIT` (30/hour): that class
governs rare, deliberate staff configuration changes, and applied to
message-sending it would throttle one moderately active conversation. Not
`widgetSession`'s numbers either (60/15 min, IP-keyed): that class exists
because *no* verified principal exists yet at that endpoint — here, one
already does (§6), so keying by customer rather than IP is both possible
and strictly fairer, the identical reasoning `authenticatedWrite`/`Read`
already apply to staff. Sixty in five minutes is one message every five
seconds sustained, generous for genuine rapid back-and-forth typing while
bounding a scripted flood to a low, non-disruptive rate — a **stated
judgment**, not derived from an existing number, because no existing class
has this shape (customer-keyed, sub-hour window, message-frequency
traffic).

**`widgetConversationRead`** — `GET .../messages` — keyed by customer.
**300 per 15 minutes**, the identical numbers `AUTHENTICATED_READ_LIMIT`
already uses, reused rather than invented: both are cheap, already-
authorized reads bounding a runaway client rather than defending against
an attacker, and the shape (per-principal, 15-minute window) transfers
unchanged.

One class covers both conversation-creation and message-sending rather
than two, because they are structurally identical — customer-keyed writes
with no threat-model difference between them — and ADR-020 §1 already
declined to invent a distinct class for two routes under an existing one
"with no threat model behind it." The same reasoning applies here to two
new routes under one new one.

`OPTIONS` preflight requests are not rate-limited by either class — they
carry no `Authorization` header for `requireWidgetToken` to key on, mount
before it, and cost no database read (ADR-021 §5). They remain subject to
the blunt `global` per-IP bound every request under `/api/v1` already
faces.

### 13. Response contracts

```json
// POST /widget/conversations → 201
{ "id": "…", "status": "open", "createdAt": "…", "lastMessageAt": "…" }

// POST /widget/conversations/:id/messages → 201
{ "id": "…", "conversationId": "…", "senderType": "customer", "body": "…", "createdAt": "…" }

// GET /widget/conversations/:id/messages → 200
{ "messages": [ { "id", "conversationId", "senderType", "body", "createdAt" }, … ],
  "nextCursor": "…" | null }
```

Conversation creation returns `201` **unconditionally**, resumed or newly
created, matching `POST /widget/session`'s own precedent exactly (ADR-019
§6 — that endpoint returns `201` whether it resumed an existing `Customer`
or minted one): the response's shape must not disclose which branch was
taken, because a caller who could distinguish "you already had one" from
"I made you one" would be a caller inferring something about server-side
history from a status code alone.

**No `organizationId` and no `customerId` in either response**, matching
`WidgetSessionCustomer`'s own minimalism (ADR-019 §12): the caller already
knows both — they hold the token — and the response has no legitimate use
for echoing an identifier back to the party that supplied it. No internal
Mongoose fields (`__v`), no `updatedAt` (§2, §4).

### 14. Logging

Every write logs an event name and safe identifiers only:
`conversation.opened` (with a `resumed: boolean`, mirroring
`widget.session.created`'s own field, §13), `message.created`. Fields:
`organizationId`, `customerId`, `conversationId`, `messageId`, `requestId`
(the last via `req.log`'s existing binding). **Never**: the message body,
a customer's name or email, the widget token, the widget key, or a JWT
secret — the identical redaction posture ADR-019 §12 established for the
session endpoint, extended to the two new write paths. `requireWidgetToken`
refusals log a `reason` (§6's taxonomy) and never the presented token,
matching `requireAccessToken`'s "credential, not content" logging rule.

### 15. What this slice does not do

- **No Socket.IO, no WebSocket, no push delivery of any kind.** A message
  is retrievable the moment `POST .../messages` returns 201, and by no
  other means. ROADMAP.md Phase 7 is untouched.
- **No agent-facing endpoint of any kind** — no agent inbox, no
  `POST .../messages` variant that can assign `senderType: "agent"`, no
  listing of an organization's conversations. `senderType: "agent"` exists
  in the schema (§4) and is unreachable through any route this slice adds.
- **No read receipts, no typing indicators, no unread counters.** Each
  needs either a push transport or a polling contract neither of which
  this slice builds.
- **No conversation reopening, archiving, or deletion.** `status` moves
  `open → closed` nowhere in this slice — no route sets it. The two-value
  enum (§2) is ready for that mutation; nothing performs it yet.
- **No AI, no automation, no ticketing.** `PROJECT_CONTEXT.md`'s dual-mode
  AI architecture and automation engine are untouched; this slice is pure
  persistence and one anonymous-visitor-facing API surface.
- **No transaction, and §10 states exactly why and exactly when that
  should be revisited.**
- **No re-check of `Origin` beyond CORS readability** (§6) — the token is
  the authorization boundary for every route this slice adds.

## Consequences

- `Conversation` and `Message` are Serviqo's second and third tenant-owned
  resource models (`Customer` was the first, ADR-019 §4's consequence
  entry); both inherit its pattern — mandatory `organizationId` on every
  repository method, no unscoped read.
- A widget visitor can now hold a durable conversation across page loads:
  the resumable widget token (ADR-019 §6) plus the one-open-conversation
  invariant (§3) mean returning to a tenant's site within the token's
  24-hour lifetime reconnects to the same conversation without any new
  concept — the pieces ADR-019 already built compose without a fourth
  identifier being invented here.
- `requireWidgetToken` is the customer-facing authentication boundary
  every future widget-authenticated route mounts, the same role
  `requireAccessToken`/`requireOrganization` play for staff routes — this
  is the pattern the eventual read-receipt and typing-indicator routes
  inherit rather than re-derive.
- `lastMessageAt` exists and is populated, but is inert — no query reads it
  yet. It becomes load-bearing the moment the agent inbox slice lists
  conversations by recency, which is also the moment §10's transaction
  trade-off should be re-examined.
- The rate-limiter table gains its first **customer-keyed** class,
  alongside the existing IP-keyed and user-keyed shapes — a third keying
  strategy for a third kind of caller, extending `lib/rateLimit` rather
  than working around it.
