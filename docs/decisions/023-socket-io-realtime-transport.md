# ADR-023: Socket.IO Real-Time Transport

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (real-time transport slice — precedes the agent inbox and AI)
**Implements:** ROADMAP.md Phase 7 ("Socket.IO real-time communication")
**Related:** [ADR-022](./022-persistent-conversations-and-messages.md) (the `Conversation`/`Message` models and services this slice pushes over a socket, unchanged); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §6, §8 (the widget token this slice authenticates with, unchanged); §13 ("a preflight cannot know the tenant" — the reasoning this slice's own CORS posture extends to the socket handshake); ADR-022 §6 ("the authorization boundary for these routes is the token, full stop" — restated here for a second transport); ADR-018 §3–4 (rate-limiter classes and keying strategy, extended by two new classes); CONTRIBUTING.md ("Socket rooms must be scoped by organization" — this slice's own explicit mandate)

## Context

ADR-022 closed the persistence half of the widget conversation gap and named
exactly what it left open:

> No Socket.IO, no WebSocket, no push delivery of any kind. A message is
> retrievable the moment `POST .../messages` returns 201, and by no other
> means.

This is that slice. It adds exactly one thing: a push transport over the
`Conversation`/`Message` machinery ADR-022 already built and tested. It adds
no new persistence, no new business rule about who may send what, and no new
identity system — every fact this slice enforces about who a caller is and
what they may reach is a fact ADR-019 and ADR-022 already decided. This
slice's only job is delivering it in real time instead of on request.

Two things make this slice narrower than "add Socket.IO" might suggest.
First, a widget visitor is anonymous by design (ADR-019 §1) and carries
exactly one credential — the widget token — so socket authentication is not
a new problem, it is the existing one (`verifyWidgetToken` plus the
organization/customer liveness check `requireWidgetToken` already performs)
carried over a different handshake. Second, ADR-022 §7's `messageService`
and `conversationRepository` already enforce every isolation rule a message
send or a conversation join needs; this slice's obligation is to call them,
never to re-derive them.

## Decisions

### 1. One new top-level layer: `src/realtime/`, not a `modules/` domain

`CONTRIBUTING.md` reserves the top level of `src/` for cross-cutting
infrastructure — `config/`, `database/`, `lib/`, `middleware/`, `routes/` —
and domain business logic for `modules/<domain>/`. Socket.IO is neither: it
introduces no new persisted resource and no new business rule, so it does not
belong in `modules/conversations/` or `modules/messages/` (which own the
`Conversation`/`Message` models this slice only calls into) or in
`modules/widget/` (which owns the token this slice only verifies). It is a
second transport for two existing domains, playing the same role `routes/`
plays for HTTP — which is why it sits beside `routes/` at the top level
rather than inside any one domain module.

```
src/realtime/
├── createSocketServer.ts   — factory; mirrors createApp.ts's shape
├── socketAuthentication.ts — token → principal, reusing verifyWidgetToken +
│                              organizationRepository + customerRepository
├── socketRateLimit.ts      — fixed-window in-memory limiter for the socket
│                              transport (§8)
├── conversationRoom.ts     — room-name derivation (§4)
└── realtimeEvents.ts       — event-name and payload/ack contract (§5)
```

### 2. `createSocketServer`, kept separate from `main.ts`, mirroring `createApp`

`app.ts` deliberately builds an Express app without starting it, so tests can
exercise it with `supertest` and no listening socket. `createSocketServer`
follows the identical shape: it takes an already-constructed `http.Server`
and returns an `io` instance, performing no `listen()` of its own. This is
what lets `apps/server/tests/socket.realtime.test.ts` bind an ephemeral port
(`httpServer.listen(0)`) and drive real `socket.io-client` connections
against it without touching `main.ts`.

`main.ts` changes in exactly one way: `app.listen(env.PORT)` becomes
`const httpServer = http.createServer(app); createSocketServer(httpServer);
httpServer.listen(env.PORT)`. Socket.IO attaches to the same HTTP server
Express already owns — a second `listen()` on a second port was rejected as
an unforced deployment complication (two ports to open, two entries in every
firewall rule and reverse-proxy config, for two transports serving the same
one process). REST and WebSocket traffic sharing one port is Socket.IO's own
documented default posture and costs nothing here.

### 3. Authentication: the widget token, verified once more, by the same primitives

A socket presents its widget token in the handshake, not a header:

```js
io("http://localhost:3001", { auth: { token } });
```

**Why `auth`, not a query string.** A query string is logged by proxies,
appears in server access logs, and survives in browser history — exactly why
every REST widget route already takes the token as an `Authorization`
header rather than `?token=`. Socket.IO's `handshake.auth` payload is the
transport's own equivalent: carried in the client's initial packet, not the
URL, and not persisted to an HTTP access log the way a query string is.

**`socketAuthentication.ts` composes the exact same three primitives
`requireWidgetToken.ts` does** — `verifyWidgetToken`, `organizationRepository
.findById`, `customerRepository.findByIdAndOrganization` — in the same order,
checking the same three facts: the credential verifies; the organization it
names still exists and is `active`; the customer it names still exists inside
that organization. This is deliberately **not** a refactor of
`requireWidgetToken.ts` into a shared core: that file is tested down to its
exact log payloads and error instances (`requireWidgetToken.test.ts`), and
Express's `next(err)` control flow has nothing in common with Socket.IO's
`next(err)` handshake rejection beyond the name. Duplicating the
*orchestration* (three sequential awaits and three branches) while reusing
every primitive that actually does work — the verifier, and both
repositories — is the same trade-off `widgetSession.service.ts` and
`requireWidgetToken.ts` already made with each other: two call sites,
zero duplicated persistence logic, because the primitives are the reusable
unit, not the glue around them.

**Refusal is two-tier, matching ADR-022 §6 exactly:**

- Credential unusable (missing, malformed, bad signature, expired, wrong
  issuer/audience) → the handshake is rejected with the identical
  `"Authentication required"` message `INVALID_TOKEN_MESSAGE` already uses
  (exported from `requireWidgetToken.ts` rather than restated, so the two
  transports cannot drift onto two different wordings for one fact).
- Credential verifies but what it names has stopped being valid (organization
  suspended/gone, customer gone) → `"This chat widget is not available."`,
  `SESSION_REFUSED_MESSAGE`, same export.

Socket.IO surfaces a handshake rejection to the client as a `connect_error`
event carrying `err.message` — so the message text **is** the entire
response the client receives, which is exactly why it must be one of these
two constants and never a raw `Error` built inline: an inline message is one
edit away from leaking a reason.

**The refusal reason is logged, never returned** — the same rule
`requireWidgetToken.ts` follows, applied to a socket's own `req.log`-shaped
child logger (`logger.child({ socketId })`, the transport's equivalent of
`requestContext`'s per-request child logger).

### 4. Rooms: `org:{organizationId}:conversation:{conversationId}`, never bare `conversationId`

`CONTRIBUTING.md` states the rule this slice must satisfy structurally, not
by convention: "Socket rooms must be scoped by organization."

A `Conversation._id` is already globally unique — no two conversations,
across every tenant, share one ObjectId — so a room keyed on the bare id
would not currently *misroute* a message to the wrong tenant. It is scoped by
organization anyway, for the same reason `conversationRepository` takes
`organizationId` on every method despite `_id` alone being technically
sufficient (ADR-022 §1): a lookup key that is *structurally* two-part cannot
be weakened to one part by a future edit that forgets why the second part was
there. `conversationRoomName(organizationId, conversationId)` is the single
function that builds this string; nothing joins a room by any other
construction.

**No membership in a room grants nothing beyond delivery.** Joining
`org:…:conversation:…` makes a socket a recipient of `message:new` events
broadcast to it; it is not a second authorization check layered on top of the
first, and no handler trusts room membership as proof of identity — every
handler reads `socket.data.widgetPrincipal`, set once at handshake time from
the verified token, never from which rooms a socket happens to occupy.

### 5. Two client events, ack-based; one server broadcast

```ts
// realtimeEvents.ts
"conversation:join" → ack({ ok: true, data: ConversationResponse } | { ok: false, error })
"message:send"      → ack({ ok: true, data: MessageResponse } | { ok: false, error })
"message:new"        — server → room, no ack (broadcast)
```

**Acknowledgement callbacks, not a reply event, for the two client-initiated
actions.** Socket.IO's ack pattern (`socket.emit("event", payload, (response)
=> …)`) gives the caller a direct request/response — the same shape
`POST /widget/conversations` and `POST /widget/conversations/:id/messages`
already have over REST — without inventing a second `conversation:joined` /
`message:sent` event pair that a client would have to correlate back to its
own request by hand. This is a transport detail translating an existing REST
contract, not a new one.

**`message:new` is a broadcast with no ack**, because delivery has no single
recipient to acknowledge to — every socket in the room receives it,
including the sender's own connection. Echoing to the sender is deliberate:
it is what makes "the connected client receives the message in real time" a
single code path regardless of whether the receiving tab is the one that
sent the message or another tab/device holding the same widget token, and it
is what the runtime verification in this slice's test plan exercises
directly.

**`conversation:join` must precede `message:send` on the same socket — a
local, in-memory, socket-scoped rule, not a persisted one.** Each socket
tracks `Set<conversationId>` of conversations it has successfully joined
(`socket.data.joinedConversationIds`). A `message:send` for a conversation
not in that set is refused **before any database call**, with a
`NOT_JOINED` ack error. This is a cheap first gate, not the authorization
boundary — `messageService.create` (§6) still re-proves ownership from the
database on every send regardless, because socket state is process-local and
must never be trusted as a substitute for the check the service already
performs. The gate exists only to make "you must join before you may send"
true at zero query cost for the common case of a client that simply forgot,
and — as a side effect — it answers a caller who never joined with a fact
that depends on nothing about whether the id is real (§7 restates why that
matters).

### 6. Message send reuses `messageService.create` verbatim — no second write path

`socket.on("message:send", …)` calls exactly
`messageService.create(organizationId, customerId, conversationId, body,
socketLog)` — the identical function `widget.controller.ts`'s `createMessage`
calls. Every rule ADR-022 §7 wrote about that function — ownership proved by
`conversationRepository.findByIdForCustomer` before any write, `senderType:
"customer"` assigned as a literal never traceable to client input,
best-effort `lastMessageAt`, the `message.created` log line — applies
unchanged, because it is the same code, not a reimplementation of it.

**Order: persist, then broadcast.** `messageService.create` returns only
after the message is durably written; the room broadcast happens in the line
immediately after, from the *returned, persisted* document — never from the
input payload. A socket disconnecting between "the database commit succeeded"
and "the broadcast fired" loses only its own copy of an event it could have
gotten by requesting message history over REST; it never desynchronizes the
stored data from what was (or was not) delivered, because delivery is a
read of what persistence already committed, not a parallel write.

**Body validation reuses `createMessageSchema` from
`widgetConversation.validation.ts` verbatim** — the same Zod schema
`middleware/validate.ts` runs for the REST route, applied here with a direct
`.safeParse` call (there is no Express middleware chain over a socket event
to mount `validateBody` onto). One schema, one control-character rule, one
length bound, enforced identically regardless of which transport a message
arrives through — and doubly enforced at the `Message` schema's own
`maxlength` (ADR-022 §9's second layer), which this slice does not touch and
which therefore already defends this new call path for free.

### 7. Conversation join reuses `conversationRepository.findByIdForCustomer` verbatim

The ownership check a join performs is `conversationRepository
.findByIdForCustomer(conversationId, organizationId, customerId)` — the exact
repository method `messageService`'s own `requireOwnConversation` helper
calls (ADR-022 §7). A conversation that does not exist, belongs to a
different organization, or belongs to a different customer produces the
identical `null` from this one query, and the join handler acks the
identical opaque failure for all three — `NOT_FOUND`, `"Conversation not
found"`, word for word the message `ConversationNotAccessibleError` carries
over REST (ADR-022 §8's enumeration-resistance reasoning, restated for a
second transport rather than re-derived: a distinguishable "wrong tenant" vs.
"doesn't exist" vs. "wrong customer" would let a caller use a socket to probe
ids exactly as it would over HTTP, so the two transports must fail identically
or the weaker one becomes the one an attacker uses).

`conversationRepository` is not extended with a new method for this. The
existing one already returns exactly what a join needs to prove and to hand
back (`toConversationResponse`, moved into `modules/widget/widgetResponses.ts`
and imported by both `widget.controller.ts` and the join handler, rather than
copied — the one non-behavioral refactor this slice makes to ADR-022's own
code, verified against `widget.conversations.test.ts` afterward to confirm
the extraction changed no response byte).

### 8. Two new rate-limiter classes, same factory, separate counters from REST

`lib/rateLimit`'s `express-rate-limit`-based factory cannot key a Socket.IO
event — it is built around `req`/`res` and a per-HTTP-request lifecycle a
long-lived socket connection does not have. `realtime/socketRateLimit.ts`
implements the same **policy shape** — fixed window, `Map<key, {count,
resetAt}>`, refuse past the limit — as a small, dependency-free counter,
explicitly matching `lib/rateLimit`'s own documented assumption: `MemoryStore`
is correct for a single process and not behind a load balancer (ADR-018 §2).
The socket limiter inherits the identical constraint rather than introducing
a new one.

**`socketConnection`** — keyed by `socket.handshake.address` (the actual
socket address; `trust proxy` is off application-wide per ADR-018 §7, so this
is not spoofable via `X-Forwarded-For` any more than the REST limiters are),
applied inside the `io.use` auth middleware before a handshake is accepted.
Reuses `WIDGET_SESSION_LIMIT`/`WIDGET_SESSION_WINDOW_MS` — the same numbers
`widgetSession` already uses for the REST endpoint with the identical shape
(unauthenticated-at-the-point-of-limiting, IP-keyed, one relatively cheap
operation per call).

**`socketMessageWrite`** — keyed by `customerId`, applied inside
`message:send`. Reuses `WIDGET_CONVERSATION_WRITE_LIMIT`/
`WIDGET_CONVERSATION_WRITE_WINDOW_MS` verbatim — the same policy ADR-022 §12
already decided for message-sending traffic, because sending a message
through a socket is the same traffic shape as sending one over REST, not a
different one that happens to use a different wire format.

**This is a separate counter from the REST class, not a shared budget.** A
customer sending 60 messages over REST and 60 more over the socket in the
same five minutes is not refused by either limiter alone. Unifying the two
into one shared budget needs a store both transports read and write against
atomically — `MemoryStore`'s own single-process ceiling applies doubly here,
since the REST limiter and the socket limiter are two separate in-memory
maps in the same process today, and neither is a global source of truth
across processes. This is named explicitly as a residual gap in §11 rather
than solved here: closing it is exactly the problem ROADMAP Phase 8's Redis
adapter exists to solve, for presence *and* for rate-limit state, together.

No `socketConversationJoin` class is introduced as a third: joining is a
single indexed read with no side effect, gated first by the connection
limiter (a socket must have survived that to exist at all) and second by
`joinedConversationIds`'s own natural bound (a client can join at most as
many distinct conversations as exist for its customer, which ADR-022 §3
already caps at one open conversation at a time). Inventing a limiter for an
operation with no write and a structurally small ceiling would be a rule with
no threat model behind it — the reasoning ADR-020 §1 already established for
declining an unnecessary class.

### 9. CORS: the token is the boundary, restated for the handshake

Socket.IO's `cors.origin` decision runs at the transport handshake, before
`socket.handshake.auth.token` has been verified — structurally the same
"cannot know the tenant yet" problem ADR-019 §13 named for the widget
session preflight, except here there is no later moment to defer to: a
rejected handshake never reaches the `io.use` authentication step at all.

The resolution mirrors ADR-022 §6's own settled answer for the REST widget
router: **the token is the authorization boundary, not `Origin`.**
`cors.origin` is configured to reflect any origin (`(origin, callback) =>
callback(null, true)`), matching `widgetCorsHeaders.ts`'s own posture of
reflecting whatever `Origin` a request carries rather than checking it
against a per-tenant list at this layer. `credentials` stays `false` — the
widget token travels in the handshake `auth` payload, never a cookie, so
credentialed CORS is not merely unneeded, it is the specific combination
(reflected origin + credentials) that would matter if a cookie were ever
involved, and this transport has none.

A browser on a website nobody approved can *open* a socket exactly as it can
already `POST /widget/session` from anywhere (ADR-019 §10's `allowedOrigins`
governs whether *that* endpoint hands out a token in the first place — it is
unchanged and still the actual gate). Opening a socket without a valid token
grants nothing: the handshake is refused at `io.use` before any room exists
to join. `allowedOrigins` is not re-checked a second time inside the socket
layer, for the identical reason ADR-022 §6 declined to re-check `Origin` on
authenticated REST requests — it is a control over *minting* a token, already
enforced once, and re-checking it here would be a second control over using
a credential already held, gating an action the original control was never
designed to gate.

### 10. Reconnect is stateless by design; the client re-joins

A reconnect is, from the server's point of view, an entirely new handshake:
a new `socket.id`, a fresh run through the `io.use` authentication
middleware (so an expired or now-invalid token is caught exactly as it would
be on a first connection), and an empty room set. Nothing server-side
persists "this customer was in this room" across a disconnect — there is no
session store for it (ROADMAP Phase 8's presence layer is explicitly out of
scope, per the prompt), so the only correct behavior available in this slice
is the client re-emitting `conversation:join` after every `connect` event,
including reconnects. `socket.io-client`'s own reconnection logic (automatic
backoff, retried handshakes) requires no server-side change to work
correctly against this design — each retry is just another fresh handshake,
authenticated the same way as the first.

This is stated as a decision rather than left implicit because it is the
gap most likely to be "fixed" by a future edit that adds server-side room
memory keyed by `customerId` — which is precisely the presence/session
machinery ROADMAP Phase 8 owns, not this slice.

### 11. What this slice does not do

- **No agent-facing socket surface.** No agent room, no agent-side events, no
  `senderType: "agent"` reachable from any handler this slice adds — the
  identical boundary ADR-022 §15 drew for the REST surface, restated for
  sockets. `messageService.create` still assigns `"customer"` as a literal;
  nothing in this slice changes that function.
- **No typing indicators, no read receipts, no presence, no unread
  counters.** Each needs either a new persisted concept or a broadcast
  contract this slice was not asked to design (the prompt's own exclusion
  list).
- **No Redis, no cross-process room or rate-limit state.** Every room
  membership and every counter in §4 and §8 lives in this one process's
  memory, matching `lib/rateLimit`'s own already-documented single-instance
  ceiling (ADR-018 §2). A second server process would neither see the first
  process's rooms nor share its rate-limit counters — both become real
  problems only at the moment Serviqo runs more than one instance, which is
  ROADMAP Phase 8's Redis adapter to solve for both concerns at once, not
  two separate migrations.
- **No file attachments over the socket.** Messages remain plain-text bodies
  bounded by `MESSAGE_BODY_MAX_LENGTH`, identical to the REST route.
- **No change to the REST conversation/message endpoints.** `widget.routes.ts`
  is untouched; every existing test in `widget.conversations.test.ts` passes
  unmodified. The socket transport is additive.
- **No shared rate-limit budget between REST and socket message-sends**
  (§8) — a stated, not accidental, gap.

### 12. A REST-sent message is persisted but not broadcast, and that is a known gap

`POST /widget/conversations/:id/messages` writes through the identical
`messageService.create` a socket send uses, so the message is durably stored
and appears in `GET .../messages` immediately — but **no `message:new` event
fires for it**, so a socket already joined to that conversation's room will
not see it until it re-reads history over REST.

Making REST broadcast would mean handing the `io` instance to
`widget.controller.ts`, which today has no dependency on the realtime layer
at all: `createApp` builds an Express app with no HTTP server and therefore
no `io` to inject (§2), so wiring one in means either making `createApp`
depend on a socket server it does not own, or introducing a module-scope
`io` singleton that every existing controller test would then have to
account for. Both are larger structural changes than "this slice adds a
push transport", and both are the wrong shape if the eventual answer is a
domain event bus that the agent inbox will need anyway for agent-sent
messages.

**Why it is tolerable now.** The widget client this transport exists for
sends through the socket once connected — the REST send path is the
fallback for a client with no socket, and a client with no socket has
nothing to deliver to. The case that actually breaks is a *mixed* client
(socket open, message sent over REST), which no Serviqo client does today
and which the widget has no reason to do.

**When this stops being tolerable**: the moment a second writer produces
messages a customer must see live — an agent replying from the inbox, or an
AI responding — because that writer is by definition not the customer's own
socket. That slice needs an emit path that does not run inside a socket
handler, which is the same mechanism this gap needs, and deciding it there
means deciding it once with both consumers visible instead of guessing at
the second one now.

## Consequences

- Serviqo has a second live transport attached to the one HTTP server
  `main.ts` already starts, authenticated by the identical widget-token
  primitives the REST widget surface uses, with zero new persistence and
  zero new authorization rules — every fact this slice enforces traces back
  to ADR-019 or ADR-022.
- `realtime/` becomes the third top-level infrastructure concern (alongside
  `middleware/` and `routes/`) that mounts domain logic without owning any
  domain itself, extending `CONTRIBUTING.md`'s domain-first convention to a
  second transport rather than bending it.
- Two rate-limiter classes exist that are policy-identical to two REST
  classes but counted independently, which is a real, named ceiling on this
  slice's fairness guarantee until a shared store exists (§8, §11).
- A widget visitor can now hold a live conversation across tabs and devices
  sharing one token: any socket that joins the room receives every message
  sent from any other **socket** into that same conversation, because
  `message:new` is broadcast from the persisted document to the whole room.
  **A message sent over REST is persisted but not broadcast** — see §12.
- Reconnection is correct by construction (§10) rather than by a recovery
  mechanism, at the cost of the client owning re-join — a cost this slice
  accepts explicitly rather than building session persistence for a presence
  feature ROADMAP Phase 8 owns.
