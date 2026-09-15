# ADR-043: Customer Profiles, Blocking and Merging

**Status:** Accepted
**Date:** 2026-09-15
**Amends:** [ADR-033](./033-workspace-shell.md) §6 (no endpoint edits a customer); [ADR-022](./022-persistent-conversations-and-messages.md) §4 (`customerId` on conversations and messages never changes)
**Related:** [ADR-037](./037-customers-never-authenticate.md), [ADR-038](./038-one-chat-link-per-organisation.md), [ADR-042](./042-agent-productivity.md)

## Context

Customers never sign in (ADR-037). The team still needs to:

- see **who** they are talking to, and what they already know about that
  person;
- stop someone who is abusing the chat;
- tidy up when one person has become two contacts — a phone and a laptop, or a
  cleared browser.

## Decisions

### 1. The contact panel

When a conversation is open, the inbox shows a third column with:

- name, email and phone;
- when the person was first and last seen;
- a **team note** about them;
- their earlier conversations, which can be opened from the panel.

It is served by `GET /organizations/:orgId/customers/:id` (`conversation.read`),
which returns that data plus the 20 most recent conversations and who blocked
the customer, if anyone. Every query names the organisation, so another
tenant's customer is a 404.

### 2. Editing a contact

`PATCH /organizations/:orgId/customers/:id` takes
`{ name?, email?, phone?, profileNote? }` and needs `conversation.reply`: an
agent correcting a typo in a contact is part of the conversation.

- **Validation:** the same rules as the widget session. `null` or an empty
  string clears a field; an empty update is refused.
- **Logging:** the log records which fields changed, never their values.
- **Broadcast:** `customer:updated` (`{ id, name, email, phone, blocked }`) goes
  to the organisation's inbox room, so every open row renames itself.
- **The visitor never sees** the team note or the edits. The widget's own
  details form still only adds to the record.

`GET /organizations/:orgId/customers?q=` (2–100 characters, case-insensitive,
literal) finds up to 10 contacts by name, email or phone. It is used to pick a
duplicate. As in ADR-042 §4, this is a staff search inside one organisation;
no visitor is ever identified by email.

### 3. Blocking

**Endpoints.** `POST` / `DELETE /organizations/:orgId/customers/:id/block` need
a new permission, `customer.manage`, held by owner, admin and supervisor.
Agents escalate: blocking is a decision about a person, not a reply.

**What a block does.** It records `blockedAt` and `blockedByUserId`, then:

1. closes the customer's open conversations and announces each closure to the
   team;
2. disconnects their widget sockets. The server finds them in the
   organisation's visitors room by verified identity, as membership revocation
   does for agents (ADR-029 §9);
3. refuses them from then on, with the **same** answers a vanished or suspended
   customer gets:
   - REST with their token: 403 `WIDGET_SESSION_REFUSED`;
   - a new session resumed by token or visitor key: 403
     `WIDGET_SESSION_REFUSED`. The visitor is **not** silently given a fresh
     identity;
   - a socket handshake: refused.

The inbox marks blocked contacts, and unblocking restores everything. Operators
see the reasons in the logs (`customer_blocked`); the visitor sees only the
generic refusal.

**Limitation, stated plainly.** Without accounts, a visitor who clears their
browser storage becomes a new anonymous visitor and is not blocked. Blocking
stops the abusive *session and device*; it is not identity enforcement. Rate
limits (ADR-022 §12) still bound what any new visitor can do. IP or device
fingerprint blocking was considered and deferred: shared IPs make it block
bystanders, and fingerprinting is a privacy cost this product has not decided
to pay.

### 4. Merging duplicates

`POST /organizations/:orgId/customers/:targetId/merge` takes
`{ sourceCustomerId }` and needs `customer.manage`. The source, a duplicate, is
folded into the target.

**Preconditions:**

- Both customers are live and belong to this organisation. A self-merge is
  400; a source from another tenant is 404.
- They do not **both** have an open conversation. One customer may have only
  one open conversation (ADR-026), so a double-open merge is 409
  `CUSTOMER_MERGE_CONFLICT` and the agent closes one first.

**What moves:**

- Every conversation and message of the source is re-pointed to the target.
  This amends ADR-022 §4's "`customerId` never changes": a merge is the one
  sanctioned rewrite, done with native updates because Mongoose treats the
  field as immutable everywhere else.
- The target keeps its own details and fills only the ones it lacks from the
  source (name, email, phone, note), plus a block if the source was blocked.
- The steps run in a transaction where the deployment supports one (a replica
  set, as Atlas is), detected once with `hello`. On a standalone server they run
  in order; each is idempotent, so an interrupted merge completes when re-run.

**The source becomes a pointer.** It stays as `mergedIntoCustomerId` plus
`mergedAt`:

- Its old token and sockets are refused and disconnected.
- Its **visitor key** resumes the target: widget session resumption follows the
  pointer one hop inside the organisation. The person on the duplicate's device
  simply carries on as the merged contact, with the whole history.
- It no longer appears in profiles or search.

The inbox receives `customer:merged` (`{ sourceCustomerId, customer }`), and
rows belonging to the source take the target's details.

## Consequences

- The team works from a real contact record without customers ever creating
  one.
- Blocking is immediate and complete for the device and session that abused
  the chat, and honest about what it cannot do without accounts.
- Merging is safe to repeat and keeps both devices of one person in one history.
- Still to come in Phase 2: auto-assignment and "continue on another device".
