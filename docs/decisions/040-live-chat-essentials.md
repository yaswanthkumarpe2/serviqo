# ADR-040: Live Chat Essentials

**Status:** Accepted
**Date:** 2026-09-15
**Amends:** [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §8 (an agent socket emits nothing) and §12 (unread counts are session-local); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §12 (the session response names nothing about the organisation)
**Related:** [ADR-023](./023-socket-io-realtime-transport.md) (the socket transport); [ADR-024](./024-widget-realtime-chat-client.md) (the widget client); [ADR-038](./038-one-chat-link-per-organisation.md) (the chat link)

## Context

The chat worked, but it did not yet feel like a modern chat:

- Nobody could tell whether a person was on the other end.
- Agents could not see a customer typing, and customers could not see an agent
  typing.
- Nothing said a message had been read.
- Unread counts vanished on reload.
- Every organisation's chat looked identical.

This ADR adds those features. Attachments, emoji and link rendering are the next
slice.

## Decisions

### 1. Each organisation styles its chat

`Organization.widgetAppearance` holds:

- `accentColor` (`#RRGGBB`);
- `title` (defaults to the organisation's name);
- `welcomeMessage` and `awayMessage`;
- `businessHours`: `enabled`, an IANA `timezone`, and seven days, Sunday first,
  each `{ open, close }` or `null` for closed.

`PUT /organizations/:id/widget-config/appearance` needs `organization.manage`.
The schema rejects a non-hex colour, an unknown timezone, a week that is not
seven days, and a day that closes before it opens.

The chat-link lookup and the widget session both return `appearance`. That means
the organisation's name now appears in the session response, amending ADR-019
§12. The name is the chat's visible title, so returning it discloses nothing a
visitor cannot already see.

The workspace's Settings view has a form for all of this, with a live preview of
the chat in both states: available and away.

### 2. Availability: agents online, within business hours

`realtime/presence.ts` counts agent socket connections per organisation. The
organisation is **online** when:

- at least one agent (or a super admin acting in it) is connected; **and**
- the time falls inside its business hours, when hours are enabled.

How visitors learn availability:

- **On load:** the chat-link lookup and the widget session return
  `availability { online, agentsOnline, withinBusinessHours }`.
- **Live:** widget sockets join a per-organisation *visitors* room. When an
  organisation goes from nobody online to somebody, or back, that room receives
  `presence:update { agentsOnline }`. It carries only a boolean: never who is
  online, never a message.
- **Hour boundaries:** the widget recomputes business hours itself every minute,
  using the same rule as the server, so opening and closing times take effect
  without another request.

The count is in-process. That is correct for the single server process Serviqo
runs today. Several processes would need the count in a shared store (Redis),
and only `presence.ts` would change.

### 3. Typing indicators, in both directions

Clients send `typing { conversationId, isTyping }` at most once every 2.5
seconds, and send `isTyping: false` after 3 seconds idle or on sending. Receivers
also clear the indicator after 6 seconds, in case a "stopped" event is lost.

- **Customer typing** goes only to the organisation's inbox room. The server
  first checks the customer's socket joined that conversation.
- **Agent typing** goes to the conversation room (the customer sees "typing")
  and to the other agents of the same organisation (they see "A colleague is
  replying", which stops two agents answering the same person).
  - The agent socket must prove the conversation belongs to its organisation.
    Each socket proves it once per conversation and caches the result.
  - The event never names who is typing.
- **Rate limit:** typing and read events share a per-principal socket limit of
  240 per minute.

This amends ADR-025 §8. The agent socket now emits `typing` and
`conversation:read`. Replies still go over REST, so the one path that creates
agent messages is unchanged.

### 4. Seen receipts and stored unread counts

`Conversation` gains four fields:

- `unreadByAgents`: customer messages the team has not read. It is shared
  across the team, because the inbox is one queue.
- `unreadByCustomer`: agent replies the customer has not seen.
- `agentLastReadAt` and `customerLastReadAt`: when each side last read the
  conversation.

How the counts change:

- **A message:** increments the other side's counter and marks the sender's side
  read. Replying implies having read. This happens in the same update that sets
  `lastMessageAt`.
- **Reading:** `conversation:read` over the socket marks one side read and
  broadcasts `{ conversationId, reader, readAt }`.
  - A customer can only mark read a conversation their socket joined.
  - An agent can only mark read a conversation in their own organisation.

Where the state is shown:

- **Inbox list:** `unreadCount`, so badges survive a reload. This amends ADR-025
  §12.
- **Widget conversation response:** `agentLastReadAt` and `unreadCount`.
- **"Seen":** the widget shows it under the visitor's latest message once the
  team has read past it. The inbox shows it under the last reply the customer
  has read.
- **Widget launcher:** a badge counts replies that arrived while the panel was
  closed.

### 5. Agent notifications

The inbox can alert an agent to new customer messages:

- **Sound:** a short generated chime, on by default.
- **Desktop notifications:** off until the agent turns them on, which is when
  the browser permission prompt appears.
- **When they fire:** for a customer message in a conversation that is not open,
  or while the tab is hidden.
- **Tab title:** carries the total unread count, e.g. "(3) Serviqo".
- **Storage:** both switches are this browser's preference, kept in
  `localStorage`. Nothing is sent to the server.

## Consequences

- Visitors see a branded chat with an honest status: "online" only when somebody
  can actually answer.
- Agents see who is typing and what has been read, and are warned when a
  colleague is already replying.
- Unread state is stored on the server and survives reloads and devices.
- Presence is per process. Scaling to several processes means moving
  `presence.ts` to a shared store.
