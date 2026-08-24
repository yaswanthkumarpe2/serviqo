# ADR-024: The Widget's Real-Time Chat Client

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (the widget's first conversational surface)
**Implements:** ROADMAP.md Phase 7's remaining client half — "Client-side socket connection management"
**Closes:** [ADR-021](./021-embeddable-widget-loader-shell-and-isolation.md) §10's named gap — "No message composer or send action, even a disabled or 'coming soon' one — that would render a promise this slice does not keep." This is the slice that keeps it.
**Related:** [ADR-023](./023-socket-io-realtime-transport.md) §3 (handshake auth), §4 (rooms), §5 (the event contract and ack shapes), §10 (reconnect is stateless; the client re-joins), §12 (REST sends do not broadcast); [ADR-022](./022-persistent-conversations-and-messages.md) §11 (cursor pagination), §13 (response contracts); [ADR-021](./021-embeddable-widget-loader-shell-and-isolation.md) §2 (no framework dependency), §3 (Shadow DOM), §6 (token in `sessionStorage`, never logged), §7 (lazy session), §8 (panel states); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §6 (the resumable token this slice reuses and does not replace)

## Context

ADR-023 built a real-time transport and shipped it with no client: its own
consequences note that the widget "sends through the socket once connected"
while §12 records that nothing in the widget connects yet. ADR-021 built a
panel whose entire feature surface is a "ready" state, and deliberately
refused to render a composer for a conversation that could not exist.

Both halves now exist on the server. This slice connects them: the widget
gains a message list, a composer, a socket connection, and history loading —
and gains **no new authentication, no new endpoint, and no new persistence**.
Every server-side fact this client relies on was decided in ADR-019, ADR-022,
or ADR-023; this ADR is about the client's own sequencing, its
de-duplication rule, and one dependency decision that has to be argued
against a prior ADR rather than assumed.

## Decisions

### 1. `socket.io-client` is bundled, and ADR-021 §2 is not violated by it

ADR-021 §2 says `src/widget/` "imports nothing from `src/app`,
`src/features`, or `src/components` — not `react`, not the design system, not
the dashboard's `fetch` wrapper," and justifies it on artifact size:
"Bundling React would roughly quadruple the artifact for a UI of one button
and one panel."

`socket.io-client` is a different kind of dependency and the distinction is
load-bearing:

- **React was rejected as a UI framework** — an alternative way to build DOM
  that the widget can do without, because the DOM API already does it.
- **`socket.io-client` is the protocol client for a server Serviqo already
  runs.** The alternative is not "use the platform instead"; it is
  *reimplementing the Engine.IO and Socket.IO protocols* — the polling-to-
  WebSocket upgrade handshake, packet framing and the four packet types,
  ping/pong heartbeat with server-supplied intervals, ack-id correlation, and
  reconnection backoff. A hand-rolled version of that is not smaller in any
  sense that matters: it is a second implementation of a wire protocol whose
  first implementation is already the thing on the other end of the socket,
  free to change with any `socket.io` upgrade, and it would be the only
  security-relevant parser in this codebase written to save 12 KB.

**Measured, and the measurement corrected a wrong prediction.** The
pre-slice bundle was **12.7 KB raw / 4.1 KB gzip**. After this slice it is
**65.1 KB raw / 20.1 KB gzip** — an increase of 52.4 KB raw / 16.0 KB gzip.

That is *larger* than `socket.io-client`'s own standalone browser build
(40 KB raw / 12.8 KB gzip), and this ADR originally predicted the opposite on
the assumption that importing the ESM entry would let Vite tree-shake the
unused transports. **It does not.** `Manager` imports every transport
statically, so the HTTP long-polling code ships whether or not it can ever
run. Passing the exported `WebSocket` transport *class* instead of the
`"websocket"` string was tried and measured to change the output by 6 bytes.
The number above is what a tenant's visitor actually downloads.

20 KB gzip is accepted for a chat widget that holds a live conversation, and
it is recorded here as the figure future slices are accountable to rather
than smoothed over. Two ways down exist if it ever needs to come down, both
deliberately out of scope here: loading the transport lazily on first panel
open (the launcher would not pay for it), or serving the standalone
`socket.io.esm.min.js` as a separate cacheable file.

**`transports: ["websocket"]`, no HTTP long-polling fallback.** Given the
above, this is a **runtime** decision and not a size one: a polling fallback
would make the widget issue repeated cross-origin HTTP requests to
`/socket.io/` against a router whose CORS posture ADR-023 §9 deliberately set
to "reflect any origin, because the token is the boundary" — correct for one
authenticated handshake, and a needlessly larger surface when repeated as a
transport. A visitor on a network that blocks WebSocket loses real-time
delivery and keeps everything else: history still loads over REST (§3), and
the composer reports the connection as failed rather than pretending (§7).

### 2. One module owns the socket; `widget.ts` never touches `io()` directly

`src/widget/realtime.ts` exports `createRealtimeClient(...)` returning a
`{ connect, join, send, destroy }` handle over callbacks
(`onMessage`, `onStatusChange`). `widget.ts` renders and calls it.

This mirrors how `session.ts` already isolates the one REST call ADR-021
made, and it is what lets the transport be tested under `jsdom` against an
injected fake — the `io` factory is a constructor parameter with the real
one as its default, the same seam `createApp`'s `emailProvider` uses on the
server. No test in this slice reaches for a network, and none of them
monkey-patches a module registry to avoid one.

### 3. Opening the panel runs one ordered sequence, and REST comes first

```
open panel
  → POST /widget/session          (ADR-019; existing, unchanged)
  → POST /widget/conversations    (ADR-022; existing, unchanged)
  → GET  .../messages             (ADR-022; existing, unchanged)
  → socket connect + conversation:join   (ADR-023; existing, unchanged)
```

**History loads over REST before the socket connects, deliberately.** The
inverse ordering — connect first, then fetch — has a real gap: a message
delivered by `message:new` between the fetch's snapshot and the socket's
first listener would be dropped by a client that had not attached one yet.
Fetching first and connecting second cannot lose a message; it can only
*duplicate* one (a message arriving live that the fetch also returned), and
duplication is the failure this slice can eliminate completely (§4) while a
dropped message is one it could only paper over.

**All three REST calls are the endpoints ADR-022 shipped, called as
specified.** No endpoint is added, no response shape is changed, and the
widget sends no field beyond what each schema already names — `organizationId`
and `customerId` are never in a request body, exactly as ADR-022 §5 requires,
because the widget has no way to know them and no reason to.

**The socket is not connected until the panel is first opened**, extending
ADR-021 §7's lazy-session posture to the transport: a visitor who never opens
the widget holds no socket, consumes no `socketConnection` rate-limit budget
(ADR-023 §8), and costs the server no connection to track.

### 4. De-duplication: one `Set` of message ids, checked at the single append point

Every rendered message passes through one function, and that function is the
only place a message is appended:

```ts
function appendMessage(message: WidgetMessage): void {
  if (seenMessageIds.has(message.id)) return;
  seenMessageIds.add(message.id);
  // …render…
}
```

`Message._id` is server-assigned, immutable, and globally unique
(ADR-022 §11 makes it the sort key and pagination cursor precisely because
of those properties), so it is the correct identity for this check — not the
body text (two identical messages are two messages), not a client-generated
id (the client does not assign one; §6), and not array position.

**This one rule covers every duplication path at once**, which is why it is
one rule rather than a special case per path:

| Path | Why a duplicate could arrive |
|---|---|
| History fetch overlapping a live event | §3's deliberate ordering |
| The sender's own `message:new` | ADR-023 §5 echoes to the whole room, sender included |
| The send ack *and* the broadcast | Both carry the persisted message (§6) |
| Re-join after reconnect | The catch-up fetch (§5) may re-return a message already rendered |
| Two panel opens in one page life | State is retained across close/open |

A guard applied at each call site instead would be five guards, and the
failure mode of forgetting the sixth is a visibly duplicated conversation.

### 5. Reconnect: the library retries, the client re-joins and catches up by cursor

ADR-023 §10 fixed the server's half — a reconnect is an entirely new
handshake, re-authenticated from scratch, with an empty room set, and "the
only correct behavior available in this slice is the client re-emitting
`conversation:join` after every `connect` event, including reconnects."

This client does exactly that. `socket.io-client`'s own reconnection
(exponential backoff, capped) is left enabled and unconfigured except for its
bounds; the widget's contribution is that **`conversation:join` is emitted
from the `connect` handler**, not once after the first connection — so the
first connect and the thousandth are the same code path, and there is no
"reconnect" branch that could rot from never running in development.

**After a successful re-join, the client fetches messages since the last one
it rendered**, using `GET .../messages?cursor=<last rendered id>` — the
keyset cursor ADR-022 §11 already built, used for the purpose it was built
for. This closes the window a disconnected socket leaves: messages persisted
while the client was away were broadcast to a room it was not in, and no
server-side replay exists (ADR-023 §10 declined to build one). Combined with
§4's id `Set`, the catch-up is safe to run unconditionally — it either finds
nothing, or finds messages the client has genuinely not seen, and anything it
re-returns is dropped at the append point.

This is a **client-side** catch-up over an existing endpoint, not the
server-side session persistence ADR-023 §10 explicitly reserved for
ROADMAP Phase 8's presence layer. Nothing new is stored anywhere.

### 6. Sending: no optimistic render, no client-generated id

`message:send` is emitted with an ack callback. The composer clears and
disables on emit, and re-enables when the ack settles. **The message is
rendered when it arrives as data from the server** — via the ack payload, or
via `message:new`, whichever lands first, both funnelled through §4's single
append point so the second is a no-op.

**Why not optimistic rendering.** An optimistic bubble needs a temporary
client-side id, then reconciliation when the real message arrives —
which means either a second identity space to keep consistent with §4's
`Set`, or a "replace this pending one" path that is exactly the duplicate-
message bug this slice is required to prevent. The latency being optimized
away is one already-established WebSocket round trip on a connection the
client is holding open, which is the cheapest thing in this sequence.
`CONTRIBUTING.md`'s "no fake functionality" applies in miniature: a bubble
rendered before the server has it is a claim the server has it.

**A failed send restores the composer's text** rather than discarding it — a
visitor who typed a paragraph and lost their connection must not lose the
paragraph — and shows one inline, non-blocking notice. The conversation
stays open and the socket keeps retrying underneath.

### 7. Four transport states, and the panel stays usable in three of them

The socket's status is surfaced as `connecting | connected | reconnecting |
failed`, rendered as a small status line above the composer.

The message list and the loaded history stay visible in **every** state.
Only `failed` disables the composer, because only then is there no path for a
message to reach the server. `reconnecting` deliberately keeps the
conversation readable — a visitor who reads while the connection blips
should not watch their own history disappear and return.

**`connect_error` carries the server's refusal message and the widget
renders none of it.** ADR-023 §3's two constants ("Authentication required",
"This chat widget is not available.") are server-side taxonomy; the widget
maps both to one visitor-facing sentence and one action, matching ADR-021
§8's Error state and ADR-019 §12's rule that a refusal names no reason. The
error object is not logged either (§9).

**A refused handshake clears the stored token** (§8) and returns the panel to
its Error state with a retry that re-runs §3's sequence from the top —
opening a fresh session, since the most likely cause of a rejected token is
an expired one and ADR-019 §6's resume path already handles "expired →
new anonymous customer" correctly.

### 8. Token handling is ADR-021 §6, extended by exactly one rule

The widget token stays in `sessionStorage`, namespaced by widget key, read
once to attempt resumption, written after every successful session response.
None of that changes.

**It is passed to the socket in the handshake `auth` payload**, matching
ADR-023 §3's own decision and its reasoning: `auth` rather than a query
string, because a query string reaches proxy logs, server access logs, and
browser history, and this value is a credential.

**The one new rule: a handshake refused as an authentication failure clears
the stored token.** Keeping a token the server has just refused would make
every subsequent retry — and every reload for the rest of the tab's life —
fail identically, with the widget dutifully re-presenting a credential it has
been told is no good. Clearing it means the next attempt takes ADR-019 §6's
anonymous path and works.

### 9. Nothing sensitive is logged, and the composer's contents are not an exception

ADR-021 §6 established the rule for the token ("never `console.log`, never
assigned to `window`, never included in an error message") on the grounds
that the widget's console is the tenant's own site. This slice adds three
things that must be held to it: **message bodies**, the **visitor's typed
name and email**, and **socket error objects** (which name internal hosts and
ports in their `description` field).

The widget's total console output remains what ADR-021 §4 specified: the
misconfiguration `console.warn`s at startup. There is no debug flag, no
verbose mode, and no `window.__serviqo` handle — a debug surface on a page
Serviqo does not control is a debug surface for whoever else is on that page.

`socket.io-client`'s own `debug` logging is disabled by default (it requires
a `localStorage.debug` opt-in the widget never sets), and the bundle does not
enable it.

### 10. Shadow DOM, mobile layout, and accessibility are extended, not reworked

Everything new renders inside the existing shadow root, styled by additions
to the same single `WIDGET_STYLES` string (ADR-021 §3). No new host element,
no second shadow root, no stylesheet link, no CSS reaching the host page.

The message list is a `role="log"` with `aria-live="polite"`, so a delivered
message is announced without stealing focus from the composer — the correct
pairing for an incoming-message surface, and the reason the list is not
`aria-live="assertive"`.

The mobile breakpoint ADR-021 §3 established (`max-width: 480px`, full-screen
panel) is preserved: the panel becomes a column of header, scrolling list,
and pinned composer, so the composer stays reachable above the keyboard
instead of scrolling away with the conversation.

**Message bodies are rendered with `textContent`, never `innerHTML`.**
ADR-022 §9 stated this obligation and assigned it here: "the response
contract hands the frontend a plain string, and rendering it as text rather
than markup is the consuming component's obligation, stated explicitly here
so it is not rediscovered as an XSS report later." This is the consuming
component, and it uses `textContent`.

### 11. What this slice does not do

- **No agent inbox, no agent UI, no AI, no email notifications, no ticketing,
  no Redis, no Docker, no deployment.** The widget renders `senderType:
  "agent"` messages correctly if one ever arrives (the model has supported
  the value since ADR-022 §4), and nothing in Serviqo can produce one yet.
- **No typing indicators, no read receipts, no presence, no unread badge.**
  Each needs a server-side contract ADR-023 §11 explicitly did not build.
- **No file attachments.** Bodies remain plain text bounded by
  `MESSAGE_BODY_MAX_LENGTH`, enforced client-side as a composer `maxlength`
  *in addition to* — never instead of — the server's two existing layers
  (ADR-022 §9). The client bound is a courtesy that prevents a doomed
  round-trip; it is not a validation boundary, and the server still rejects
  an over-length body exactly as before.
- **No REST send path in the widget.** With a socket connected, sending over
  REST would produce a message that does not broadcast (ADR-023 §12) — the
  known gap — and the widget must not be the client that trips it. When the
  socket has failed, the composer is disabled rather than silently falling
  back (§7).
- **No change to any server file.** This slice is `apps/web/src/widget/*`
  and its tests. Every endpoint, event, room, limiter, and log line ships
  from ADR-022 and ADR-023 unchanged.
- **No second authentication system.** The widget token is issued by the
  endpoint ADR-019 built, stored where ADR-021 §6 put it, and verified by
  the handshake ADR-023 §3 already performs.

## Consequences

- The widget is a working chat client: a visitor opens it, sees their history,
  types, sends, and sees messages arrive live — the first end-to-end
  conversational path in Serviqo, and the first consumer of the transport
  ADR-023 shipped without one.
- `apps/web/dist/widget.js` grows from 4.1 KB to 20.1 KB gzip (§1). This is
  the first runtime dependency the widget bundle has ever had, it is a
  bigger increase than this ADR first predicted, and the bundle-size
  discipline ADR-021 §2 set now has a real number attached to it that future
  slices are accountable to.
- Duplicate suppression is centralized in one `Set` at one append point (§4),
  so every future message source — an agent reply, an AI response, a
  server-side replay — inherits it without a new rule.
- The client performs a cursor catch-up on every re-join (§5), which makes
  the ADR-023 §10 "no server-side replay" decision survivable from the
  visitor's side without the presence machinery Phase 8 owns.
- ADR-023 §12's REST-does-not-broadcast gap is now load-bearing in one
  direction it was not before: any future writer that is not a customer
  socket (an agent, an AI) still cannot reach this client. The widget is
  ready to display those messages and will not receive them until that gap
  is closed — which is the agent-inbox slice's first obligation, not a
  limitation of this one.
