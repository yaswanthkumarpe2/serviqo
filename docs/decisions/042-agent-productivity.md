# ADR-042: Agent Productivity: Saved Replies, Internal Notes, Tags, Search and Shortcuts

**Status:** Accepted
**Date:** 2026-09-15
**Amends:** [ADR-026](./026-conversation-assignment-and-status.md) §11 (assignee names withheld from roles without `member.read`); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §5 (nothing queries customers by email)
**Related:** [ADR-040](./040-live-chat-essentials.md), [ADR-041](./041-files-emoji-and-links.md) (Phase 1)

## Context

Phase 1 made the chat feel live. Phase 2 makes the people answering it faster.
The first slice covers what an agent reaches for on every conversation:

- a stock answer;
- a word with a colleague that the customer must not see;
- a label;
- a way to find last week's conversation;
- a keyboard.

## Decisions

### 1. Saved replies

**Model.** A `SavedReply` is `{ organizationId, shortcut, title, body, createdByUserId }`.

- The organisation owns it, not its author: the team's answer to "where is my
  order?" survives a person leaving.
- A shortcut is 1–32 characters: lowercase letters, digits, `-` and `_`. It is
  unique per organisation (409 `SAVED_REPLY_SHORTCUT_TAKEN`).
- An organisation can keep up to 200 (422 `SAVED_REPLY_LIMIT_REACHED`).

**Routes** under `/organizations/:orgId/saved-replies`:

- **List:** `conversation.read`. Every agent can use them.
- **Create, update, delete:** a new permission, `saved_reply.manage`, held by
  owner, admin and supervisor. An agent uses the team's answers but does not
  rewrite them.
- **Tenant scope:** every query carries the organisation id with the reply id,
  so a reply id from another organisation finds nothing (404).

**In the composer.** A draft that is exactly `/word` lists replies whose
shortcut starts with `word`, then those whose title contains it. Arrow keys
move, Enter or Tab inserts the body, and Escape dismisses the list. Choosing
one sends nothing. **In Settings,** every member sees the list; the three
managing roles get a form.

### 2. Internal notes, @mentions, and colleagues' names

**Storage.** Notes are their **own collection**, not a `Message` with a third
`senderType`. Every customer-facing path reads `Message`: widget history, the
conversation room, `toMessageResponse`. So a note cannot reach a customer
through any of them, and there is no filter to forget.

**Routes** under `/organizations/:orgId/conversations/:id/notes`:

- `GET` needs `conversation.read`; `POST` needs `conversation.reply`.
- Both prove the conversation belongs to the organisation first, so another
  tenant gets the usual opaque 404.
- The request body is `{ body, mentionedUserIds }`.

**Mentions.**

- A mention counts only if the id belongs to an **active** member of this
  organisation. Other ids are dropped, not refused: a refusal would reveal
  whether an arbitrary id is on the team.
- The response names the author and the mentions `{ id, name }`, resolved when
  it is read.

**Live delivery.**

- `note:new` goes to the organisation's **inbox room only**, never a
  conversation room.
- In the inbox, notes interleave with messages by time. They are yellow and
  labelled "Internal note · Name".
- A mentioned teammate gets the inbox notification ("Olivia mentioned you").

**Teammates list.** `GET /organizations/:orgId/teammates` returns active
members as `{ id, name }` only, behind `conversation.read`. It feeds the
@mention picker.

**Colleagues' names are visible to anyone who works the inbox.** This amends
ADR-026 §11. Notes and mentions name colleagues by necessity, and "Assigned to
another agent" beside a note signed by that same agent hid nothing.
`resolveAssignees` now names the assignee for any reader with
`conversation.read`. Emails, roles and membership status still require
`member.read`, and broadcasts still carry no names.

**Mode switch in the composer.** Reply and Internal note are two tabs. Note
mode turns the box yellow, says "Only your team sees this", and changes the
button to "Add note". In note mode, attachments are unavailable and typing
sends no "typing" event to the customer.

### 3. Tags

**Storage.** `Conversation.tags` is a list of strings.

**Setting tags.** `PUT /conversations/:id/tags` takes `{ tags }` and needs
`conversation.reply`: tagging is working the conversation.

- Each tag is trimmed and lowercased, with runs of spaces collapsed.
- It must be letters and digits joined by single spaces, `-` or `_`, at most 32
  characters.
- Duplicates are removed, and a conversation can have at most 10 tags.

**Reading and filtering.**

- The inbox projection and `conversation:updated` both carry `tags`.
  `conversation:updated` goes to the inbox room only (ADR-026 §10), so tags
  never reach a customer.
- `GET /conversations/tags`, registered before `/:conversationId`, returns the
  distinct tags in use for the filter and the picker.
- The list accepts `?tag=`, using the index
  `{ organizationId, tags, lastMessageAt, _id }`.

### 4. Search

The list accepts `?q=` (2–100 characters), combined with the status, assignee
and tag filters. The search resolves inside one organisation, before paging:

- **Customers:** a case-insensitive match on name, email or phone. The query is
  escaped, so `a.b` matches only a literal `a.b`.
- **Messages:** a text query on the index `{ organizationId: 1, body: "text" }`.
  The organisation id is the index's equality prefix, so MongoDB refuses a text
  query that does not name one; cross-tenant search is impossible even by
  mistake.

Each side is capped at 500 matches. The results become an `$or` of `customerId`
and `_id` inside `$and` with the keyset cursor, so pagination stays correct.

This amends ADR-019 §5's "nothing queries customers by email" for staff search
within an organisation. It remains true that **no identity is ever resolved
from an email**: the widget never finds or resumes a customer this way.

In the inbox, the search box waits 300 ms after typing stops and needs two
characters. A slower response to an older search cannot overwrite a newer one.
The filters stay visible when nothing matches.

### 5. Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / previous conversation |
| `/` | Focus search |
| `r` | Reply |
| `n` | Internal note |
| `?` | Show or hide the shortcut list |
| `Esc` | Close the list |

Single keys work only while focus is **not** in a text field, so typing "j" in
a reply types "j". Combinations with Ctrl, Cmd or Alt are left to the browser.
In the composer, Enter sends and Shift+Enter adds a line.

### 6. Rate limits

- Note creation and tag changes use `agentConversationWrite` (ADR-041 §5).
- Saved-reply edits use `authenticatedWrite`.
- Every read uses `authenticatedRead`.

## Consequences

- Agents answer common questions in two keystrokes, talk about a customer next
  to the conversation, and find old conversations by name, email or word.
- Notes being a separate collection means customer-facing code needs no change
  to stay safe. A future "convert note to reply" is a deliberate copy, not a
  flag flip.
- Text search matches words, not substrings: "refund" finds "refunds", but
  "fund" does not. Customer fields use substrings.
- The rest of Phase 2 is next: customer profile, block visitor, auto-assign,
  "continue on another device", and merging contacts.
