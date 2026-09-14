# ADR-033: The Workspace Shell

**Status:** Accepted
**Date:** 2026-09-12
**Phase:** 5 (Agent workspace)
**Implements:** ROADMAP.md Phase 5's agent workspace, as a navigable product surface rather than a stack of sections
**Supersedes:** [ADR-032](./032-platform-admin-and-operations-console.md) §15's view switcher, which was the first step of this and is replaced by it
**Related:** [ADR-010](./010-principal-types-organization-users-and-customers.md) §1 (a user belongs to as many organizations as they hold memberships in), §5 (customers never authenticate; the `/auth` prefix is permanently organization-user authentication); [ADR-015](./015-access-token-verification-and-current-user.md) §9 (`/me` is the identity a page renders), §10 (fields a client reads survive a future state); [ADR-017](./017-organization-context-and-rbac.md) §10 (the client chooses a tenant and the server re-proves it); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) (a `Customer` exists because a visitor wrote in); [ADR-022](./022-persistent-conversations-and-messages.md) §1 (every conversation read is scoped by `organizationId`); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §5 (the conversation list and its paging), §11 (the inbox is keyed by organization so a tenant switch remounts it; a 403 is a state, not an error); [ADR-026](./026-conversation-assignment-and-status.md) §1 (`assignedTo` is null until claimed), §11 (an assignee's name is disclosed only to a reader holding `member.read`); [ADR-032](./032-platform-admin-and-operations-console.md) §15 (the sample metrics were removed rather than made real); CONTRIBUTING.md ("No business logic in JSX"; "Never rely only on frontend filtering"; demo data must say what it is); SECURITY.md §4 (security relies entirely on server-side validation, never on the client UI)

## Context

`/dashboard` was a single scrolling column: a greeting, an organization
switcher, widget installation, the inbox, the team roster, and a create-org
form, in that order. ADR-032 §15 improved it to a four-tab switcher and
removed the sample metrics that closed it.

That was still not a product. What a person saw immediately after registering
and verifying was an organization card and a form, with the thing the product
exists for — conversations — reachable only after they understood what a
"view" was. There was no overview, no sense of what was waiting, and no answer
to "what is in here" short of clicking every tab.

A mockup existed in another worktree (`apps/web/widget-test.html` on a
different branch) showing the intended shape: a top bar with primary
navigation, a greeting, quick-access cards, a recent-conversations panel, and
an activity panel. It was static HTML with hardcoded rows — "Support Team",
"Alex Morgan", "128 Messages", "1m 42s Avg. response". The layout was right.
The data was fiction, and reproducing it as fiction in React would have been
the exact thing ADR-032 §15 had just finished removing.

**One thing the mockup got wrong, and it matters.** Its copy is a customer
portal's — "Connect, communicate and get support in real time", "Start a
chat". Serviqo has no such surface and will not: customers never authenticate
(ADR-010 §5), they reach a tenant through the embedded widget, and they hold
no `User`. Everyone who can sign in is STAFF. So the layout is adopted and the
framing is inverted: "my chats" are the conversations in this agent's inbox,
and "contacts" are the visitors who wrote to them.

## Decisions

### 1. A shell, not a page

`DashboardPage` becomes a shell: a sticky top bar holding the wordmark,
primary navigation, and the account controls; beneath it, exactly one view.

**A top bar rather than a sidebar.** Five destinations do not justify
surrendering a column of horizontal space on every screen, and the inbox is a
two-pane layout that wants all of it.

The greeting lives in the SHELL, not in the overview. That is not cosmetic: it
was inside the overview first, which renders only once an organization is
confirmed — so somebody who had just registered and created nothing was met by
a bare form with no acknowledgement they had signed in at all. A greeting is a
fact about the person; an overview is a fact about a tenant.

### 2. Five destinations, and every one of them does something

`Dashboard`, `My Chats`, `Contacts`, `Team`, `Settings`, defined once in
`workspaceViews.ts` because three things must agree about them — the nav, the
shell's switch, and the overview's quick-access cards, which navigate by id.

The mockup also showed **Notifications**. It is deliberately absent: nothing
in Serviqo generates a notification yet, and a nav item that opens an empty
page is a promise the product does not keep.

The nav is a real `tablist` with `aria-selected`, roving `tabindex` and
arrow-key navigation. A tablist that ignores arrow keys announces itself to a
screen reader as navigable and then behaves like five unrelated buttons, which
is worse than not claiming the role.

**One view is mounted at a time** rather than all five hidden with CSS. This
matters most for the inbox: it holds an open socket, and a hidden-but-mounted
copy would keep streaming a tenant's messages into a component nobody is
looking at. The whole body is keyed by organization id, so switching tenants
tears the subtree down rather than reconciling one tenant's conversations,
contacts and roster into a tree that just finished rendering another's
(ADR-025 §11).

The nav renders only once a tenant is confirmed. Before that, five
destinations would each render nothing.

### 3. One request behind the overview

`useWorkspaceOverview` reads the first page of this tenant's conversations —
the same list the inbox opens with — and everything on the dashboard and the
contacts view is derived from it.

**Deliberately not `useAgentInbox`.** That hook owns a socket, a selected
thread, unread bookkeeping and a send path; mounting it twice would open a
second socket for a panel nobody is typing into. The overview is a snapshot
and re-reads on demand.

It writes no state synchronously inside its effect, for the reason
`useAgentInbox` already records: a synchronous `setState` in an effect body
cascades a render, and React's own lint rule refuses it. `isLoading` starts
`true`, so the first load has nothing to set on the way in; a refresh runs
from a click, which is an event, and may announce itself immediately.

### 4. Every figure is real, and a figure that is not a total says so

This is the decision the whole slice turns on.

The server pages conversations, so the first page is not necessarily the whole
tenant. A count derived from one page and rendered as "12 conversations" is
silently wrong for exactly the organizations big enough to care. So the hook
reports `isComplete` — true only when the server said there is no next page —
and the UI changes what it CLAIMS based on it: an exact total when the page is
the tenant, `"12+"` plus a footnote when it is not.

Nothing is invented anywhere in the tree. An empty organization gets an empty
state that names why it is empty and points at the action that changes it,
rather than sample rows that make a new workspace look busy.

Two figures from the mockup are **absent by decision**, not oversight:

- **Average response time.** Computing it needs per-message timing the API
  does not expose. No figure beats a plausible invented one.
- **Unread counts on the overview rows.** Unread is the inbox's own local
  hint (ADR-025 §12), held by the hook this panel deliberately does not
  mount. A second, differently-derived unread count would disagree with the
  inbox's, and two numbers that disagree are worse than one number in one
  place.

### 5. The shell's icons live with the shell

`workspaceIcons.tsx`, beside the feature rather than added to
`components/ui/icons.tsx`, which holds the marketing site's set. These are
24-grid stroked glyphs sharing one `strokeWidth` so a row of cards reads as
one family; mixing them into a module whose icons were drawn for a landing
page is how that consistency gets lost. None sets a colour — `currentColor`
means a card decides its icon's colour by deciding its text colour.

### 6. Contacts are derived, and the page says so

Serviqo has no contact book. A `Customer` exists because a visitor wrote in
(ADR-019), so the only honest contact list is the people behind this tenant's
conversations — collapsed by customer id, counted, and ordered by the
conversation ordering the server already applied.

The panel's own subtitle states this ("Serviqo creates a contact the first
time somebody starts a chat — there is nothing to import") rather than
implying an address list nobody has imported. It is read-only, because no
endpoint renames a customer, merges two, or adds a note — so there are no
controls here that would 404 on click.

A visitor who gave no name renders as "Anonymous visitor". Putting their email
or an id in the name column would be this client fabricating an identity the
customer withheld.

### 7. Opening a conversation from the overview

Clicking a recent conversation switches to My Chats and selects that thread.

The intent is formed in a view that is about to unmount, in a component that
does not exist yet, so it travels as `initialConversationId` — held by the
shell, passed to `AgentInbox`, and handed to `useAgentInbox`.

**Applied inside the hook's load callback, not in an effect that watches it.**
An effect calling `selectConversation` would be a synchronous `setState` in an
effect body — the same rule §3 cites — so `selectConversation` was moved above
`loadConversations` and is called from its promise callback once the list has
arrived. It is honoured **once**, and only if the conversation is actually in
the loaded page: selecting an id the page does not contain would leave the
thread pane loading a conversation this reader cannot see, and a stale click
is better ignored than obeyed.

### 8. What this slice does not do

- **No per-organization metrics endpoint.** The figures are derived
  client-side from a page of conversations, which is why §4's honesty
  machinery exists at all. A real aggregate endpoint would make them exact and
  is its own slice — the same gap ADR-032 §15 named when it deleted the sample
  metrics.
- **No live updates on the overview.** It is a snapshot with a Refresh. The
  socket belongs to the inbox, and a second subscriber for a summary panel is
  not worth a second connection.
- **No search, no filters, no saved views.**
- **No notifications, no presence dots.** The mockup showed both; neither
  exists behind them.
- **No customer portal.** Stated here because the layout invites the
  assumption. ADR-010 §5 is unchanged and this slice does not soften it.

## Consequences

- A person who has just registered lands on a workspace that greets them, says
  what is waiting, and offers four things to do — instead of a form.
- The dashboard and the contacts view share one request, so they cannot
  disagree.
- `useAgentInbox` gained an option and one internal reordering
  (`selectConversation` moved above `loadConversations`). Its behaviour is
  otherwise untouched and its suite still passes unchanged.
- Every count on the page is honest about its own precision, which is a
  standing constraint on whatever is added next: a new figure must either be
  exact or say that it is not.
- `DashboardPage.test.tsx` now reaches the inbox by selecting My Chats, which
  is what a person does. Tests that asserted the inbox rendered on load were
  asserting the old layout, not a requirement.
