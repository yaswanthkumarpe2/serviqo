# ADR-034: Customer Accounts, Agent Invitations, and Three Front Doors

**Status:** Accepted
**Date:** 2026-09-12
**Phase:** 3 (User / Team / Role management) and 4 (Customer chat experience)
**Amends:** [ADR-010](./010-principal-types-organization-users-and-customers.md) §5, which stated that customers never authenticate. They now may. Everything else ADR-010 decided is unchanged and is restated in §2 below.
**Implements:** ROADMAP.md Phase 3's "Member invitations", at platform scope; ROADMAP.md Phase 4's signed-in customer chat
**Related:** [ADR-005](./005-account-action-token-lifecycle.md) (single-use emailed credentials); [ADR-007](./007-registration-flow-and-account-enumeration.md) §3 (an unverified user is left in place), §10 (the provider is chosen at construction); [ADR-008](./008-resend-verification-and-silent-responses.md) §6 (delivery is not persistence); [ADR-011](./011-login-and-session-issuance.md) §7 (per-account lockout); [ADR-014](./014-logout-all-devices.md) §3 (revoking every session, including the caller's); [ADR-015](./015-access-token-verification-and-current-user.md) §7 (a valid signature identifies but does not entitle), §9–10 (`/me` is the identity a page renders); [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (a failed membership write leaves an inert record, not a rollback); [ADR-017](./017-organization-context-and-rbac.md) §1 (a URL cannot be addressed without naming a tenant); [ADR-018](./018-rate-limiting-and-security-headers.md) §3 (limiter classes by abuse shape); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §4–5 (the tenant-scoped customer lookup; why email must never find one), §10 (empty `allowedOrigins` means closed); [ADR-022](./022-persistent-conversations-and-messages.md) §5 (server-assigned literals, never request input), §8 (one opaque refusal for every unreachable conversation); [ADR-023](./023-socket-io-realtime-transport.md) (the widget-token socket handshake); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §5–6 (the staff-facing conversation surface); [ADR-027](./027-team-management-and-membership-lifecycle.md) §12 (`memberInvite`, for endpoints that mail an address the caller names); [ADR-030](./030-email-verification-codes.md) §3–4 (the code's TTL and attempt limit) — cited unlinked, that file is absent from the repository though the code cites it throughout; [ADR-031](./031-credential-rate-limit-classes.md) (the credential classes); [ADR-032](./032-platform-admin-and-operations-console.md) §1 (`platformRole` as a second axis), §3 (the admin API), §8 (read-only, and why); [ADR-033](./033-workspace-shell.md) (the agent workspace); CONTRIBUTING.md; SECURITY.md §2, §4

## Context

Serviqo had one kind of account. Everyone who registered became staff, which
is why the product asked a brand-new signup to name an organization before it
would show them anything. That is the right question for an agent and a
baffling one for a customer, and it was the visible symptom of a deeper
mismatch: the product being built is a support desk with three kinds of
person in it, and the codebase modelled one.

The three are:

- **Customers** — the people who buy from a tenant and ask it questions. They
  reached Serviqo only through the embedded widget, anonymously, and could not
  come back to a conversation from a different device or see what they had
  asked last week.
- **Agents** — the people who answer. They existed, but only by registering
  themselves at the same public front door a customer uses, which means
  anybody who found `/signup` could become one.
- **Admins** — the people who run the deployment. ADR-032 gave them a
  `platformRole` and a private console, but that console could only LOOK. The
  set of agents was still whoever had signed up.

ADR-010 §5 said customers never authenticate. That was correct when the only
customer surface was a widget on somebody else's website, and it is the
constraint this ADR changes — narrowly, and with the rest of ADR-010 intact.

## Decisions

### 1. `kind` on `User`: customer or agent

`User` gains `kind: "customer" | "agent"`, defaulting to `"customer"`.

A **third axis**, independent of the two that exist. `MembershipRole` says
what somebody may do inside one tenant. `platformRole` (ADR-032 §1) says
whether they operate Serviqo. This says which kind of person they are at all,
and the three do not substitute: an agent holds a membership and no platform
standing; a customer holds neither.

**Public registration writes `"customer"` and cannot write anything else.**
The value is not in the registration schema, so a body carrying
`kind: "agent"` cannot reach the model — asserted as an outcome in the suite,
not merely as a schema property. The only writer of `"agent"` is §7.

The default is the least-privileged value, which makes the field safe to add
to a populated collection: every account written before today reads back as a
customer, and no migration is needed to make that true.

`kind` is reported by **login** as well as by `/me`, because it decides where
the browser goes next and making that wait for a second round trip would show
every agent the customer dashboard for a frame first.

### 2. What ADR-010 still guarantees

ADR-010 §5's sentence changes; its reasoning does not. A customer with an
account still:

- holds **no `Membership`**, so no tenant surface is reachable by them at all;
- can address **no organization**, because the surface in §5 has nowhere to
  put one;
- sees **only their own conversations**, enforced by a query filter rather
  than by a check after the fact;
- reaches the same `Conversation` and `Message` documents the widget reaches,
  through the same services, so there is one implementation of tenant
  isolation rather than two.

The widget remains the anonymous path and is untouched. This is an
**additional** door, not a replacement, and the two produce the same kind of
`Customer` record at the end.

### 3. `Customer.userId`: the link, and the only lookup key

`Customer` gains `userId: ObjectId | null` — `null` for every widget visitor,
set for a customer who signed in — with a **unique partial index** on
`{ organizationId, userId }`, constrained to documents that actually carry
one.

Partial for a specific reason: anonymous visitors all have `null` there, and
a plain unique index would permit exactly one of them per organization.

The contrast with `email` on the same model is the whole point, and ADR-019 §5
drew it: **email must never find a customer**, because anyone who typed a
known address would inherit that person's history — an account-takeover
primitive reachable from an unauthenticated endpoint. `userId` is safe to look
up precisely because it **cannot be typed**: it is read from a verified access
token, so finding a customer by it proves the caller *is* that customer rather
than merely names them.

The record is created **lazily, on first use**, not at registration.
Registration happens before any organization may exist and before the person
has said anything; a row created then would record somebody who has never been
in touch.

### 4. The default organization, and `requireCustomerAccount`

A customer arriving at the product's own front door names no tenant — there is
no widget key in a login, and offering a list of companies to pick from would
expose the platform's tenant roster to anyone who registers.

So it is **derived: the oldest active organization**. Oldest rather than
newest because it is stable — a deployment's answer to "who does support" must
not change the moment somebody creates a second tenant — and `_id` ascending
is that order for free.

`requireCustomerAccount` is the middleware that turns "who is calling" into
"which customer, in which tenant", the authenticated sibling of
`requireWidgetToken`. It applies the same exists/active/verified gate every
other authenticated surface applies (ADR-015 §7), and refuses **agents**: they
have an inbox, this is the other side of it, and one account holding both
roles would make "who sent this message" a question with two answers.

When no organization exists it answers `404` with its own message, not `403`.
That is the one refusal here that is not about the caller, and telling them
"no permission" would send them looking for a mistake they did not make.

### 5. `/api/v1/me`: a surface that can address nothing

Four routes — list conversations, start one, list messages, send one — mounted
at `/api/v1/me`, the only prefix in the API that names neither a tenant nor a
resource.

That is the addressing model, not a convenience. Staff address a tenant
because they may belong to several (ADR-017 §1); a customer **cannot address
one at all**, so no request they make can cross a boundary even by accident.
A test asserts this from the client side too: every request the dashboard makes
contains `/api/v1/me/` and none contains `/organizations/`.

Each handler is the authenticated twin of one in `widget.controller.ts` and
calls the **same services with the same arguments**. Forking them would give
two code paths one chance each to get isolation wrong. The response shapes are
reused for a sharper reason: a customer must learn exactly as much on one path
as on the other, and a richer payload here would be a disclosure that exists
only because the reader happened to sign in.

The limiter classes are the **widget's**, because this is the same traffic — a
person typing in a chat — and metering it differently depending on which door
it came through would be arbitrary.

### 6. The customer dashboard, and why it polls

One screen, one job. No organization picker, no inbox, no team, no widget
installer: a customer is not staff.

**The chat polls every three seconds rather than using the socket**, and this
is a stated limitation rather than an oversight. Serviqo's realtime transport
authenticates a customer with a *widget token* (ADR-023), which a signed-in
customer does not hold; wiring this to the socket means teaching the handshake
a second customer credential, which is its own slice with its own security
argument. A three-second poll is indistinguishable from live at support-chat
pace, and it **stops when the tab is hidden** — a background tab polling
forever is a cost paid for nobody.

Sent messages are merged from the **response**, never optimistically: an
optimistic line has no server id, so the next poll cannot recognise it as
already-shown and renders it twice.

### 7. Agents exist only because an admin created them

`POST /api/v1/admin/agents`, behind `requirePlatformAdmin`, is the only way an
account with `kind: "agent"` comes into existence. It writes a `User`, a
`Membership` in the default organization with role `agent`, and an email
verification code — then sends one message carrying **two secrets**:

- a **generated password**, because the agent did not choose one and something
  must be the first credential;
- a **verification code**, because an admin typing an address is not evidence
  that anybody reads it.

**The account is created unverified and therefore cannot sign in.** That is
the requirement driving the whole shape: a working account at an address
nobody controls is an account somebody else may end up holding.
`login.service.ts` already refuses every unverified account with
`EMAIL_NOT_VERIFIED`, so "verify first" is enforced by machinery that predates
this feature rather than by a new check.

The generated password is **delivered once and is unrecoverable** — nothing
stores it, only its Argon2id hash. So unlike registration (ADR-008 §6), a
delivery failure here is reported **up** rather than swallowed: an undelivered
invitation produces an account nobody can ever sign into, and the admin must
know to try again.

The request schema is `.strict()` and carries `name` and `email` only. No
password (the server generates it; an admin-chosen one would be a credential
known to two people), no role, no `organizationId` (derived), and no `status`
or `emailVerifiedAt` — an admin who could send those could mint a verified
account for an address they do not control, which is the entire thing
verification exists to prevent.

`memberInvite` is the limiter class, because this mails an address the caller
names, which is exactly the abuse shape ADR-027 §12 created it for.

This is the **first write** on the admin router. ADR-032 §8's "every handler
is a GET" stands for everything else; adding an agent earned its place because
it is the only way agents can exist, and it creates rather than destroys.

### 8. Changing your own password

`POST /auth/change-password`, which is what an agent does with the password
they were emailed.

Not password RESET: reset proves control of an inbox for somebody who cannot
sign in, this proves knowledge of the current password for somebody who
already has, and `AccountToken`'s `password_reset` purpose remains unused.

**Knowing the current password is the whole authorization.** An access token
alone is not enough — a token lifted from an unattended machine would
otherwise let an attacker lock the owner out permanently.

A new password identical to the old one is **refused**, not absorbed as a
no-op: an agent who "changed" theirs back to the invitation's has left a
permanent working credential in an inbox.

It revokes **every other session and keeps the caller's own**. Changing a
password is what somebody does when they suspect another person has it, so
leaving other sessions alive would make it ceremonial; ending the caller's own
would sign them out of the page they just used, which reads as a failure.

The `credential` limiter class, keyed by IP rather than by user like other
authenticated writes, because this endpoint **verifies a password** and is
therefore a place where guessing is the attack.

### 9. Three front doors

| path | who | lands on |
| --- | --- | --- |
| `/signup`, `/login` | customers (and any agent who uses the general door) | `/dashboard`, or `/agent` if they are an agent |
| `/agent/login` | agents, from their invitation email | `/agent` |
| `/control/login` | admins (unlisted) | `/control` |

The public pages are the **customer's**, because that is where the marketing
site points and who the overwhelming majority of visitors are. `useLoginForm`
now routes on the `kind` login reports when no destination is given, so one
address serves both audiences without either seeing the other's surface first.

`/home` exists as the single answer to "where does a signed-in person belong",
so the three "you are already signed in" redirects cannot drift apart. It is a
route rather than a helper because the answer is not synchronous — it comes
from `/me`.

`AgentRoute` and `CustomerRoute` are deliberately **two components** rather
than one parameterised guard: they send people to different places for
different reasons, and a single `RequireKind` would turn both destinations into
arguments at a call site instead of decisions with reasons written beside them.
Their asymmetry is also deliberate — a `null` user (a `/me` failure that was
not a 401) is refused the agent surface and allowed the customer one, because
failing to confirm somebody is an agent must not grant the staff surface, while
failing to confirm they are a customer costs nothing.

### 10. Agents can no longer create organizations

The workspace's organization-creation form is gone. Tenants are the admin's to
set up; an agent who could create one could make themselves the owner of a
workspace nobody asked for.

An agent belonging to no organization is told to ask their admin rather than
handed a form. That state should be unreachable — the invitation that created
the account also created its membership — and is reachable only if that
membership write failed (ADR-016 §3), which is exactly when somebody needs to
be told plainly.

### 11. The console gains one form and one column

`AddAgentForm`, above the account list it changes so the result is visible
without scrolling, and a `Kind` column so an admin can see at a glance who is
a customer and who answers them.

The success message names the address **and the next step**. "Invitation sent"
alone would leave an admin believing the agent can sign in, which is the one
thing that is not yet true.

### 12. `npm run reset:platform`

A destructive script that empties the deployment and seeds one organization
and one admin, for starting over on a database whose contents were all test
data.

Three guards, in increasing order of how much they save you: it refuses
`NODE_ENV=production`; it requires `--yes-delete-everything` spelled out,
because a flag you must type deliberately is not one you pass by accident; and
it **prints what it is about to delete, with counts, before doing it** —
"deleting 4 users" and "deleting 40,000 users" are different decisions.

The seeded admin is `kind: "agent"`, because they are staff and need to be able
to open the workspace and answer a conversation.

### 13. What this slice does not do

- **No socket for signed-in customers.** §6. The poll is the interim.
- **No password reset.** §8 is not it. Somebody who has forgotten their
  password still cannot recover it, which is now more visible because agents
  receive one they are told to change.
- **No agent management beyond creation.** No suspend, no remove, no resend of
  an invitation, no role change from the console. Each is a write, and ADR-032
  §16's rule stands: the platform surface needs a real audit trail before it
  grows more of them.
- **No customer profile.** A customer cannot change their name, and their
  contact record copies the account's name and address at creation rather than
  staying in step with it.
- **No second organization for customers to choose between.** §4 derives one.
  A multi-tenant deployment with more than one active organization sends every
  signed-in customer to the oldest.
- **The default organization is not configurable.** It is derived, not set.
  A `defaultOrganizationId` on a platform settings document is the obvious
  next step and is deliberately not invented here for a deployment with one
  tenant.

## Consequences

- A person who signs up lands on a working chat with support, and an agent
  sees that chat in the inbox they already had. The two halves are the same
  documents through the same services.
- The set of people who can read a tenant's conversations is now exactly the
  set an admin put there. Before this, it was whoever found `/signup`.
- `ADR-010 §5` no longer reads as written. It is amended here rather than
  edited there, so the history of why customers could not authenticate — and
  what changed — stays readable.
- Three login pages is more surface than one, and it is the honest amount:
  each audience arrives from somewhere different and belongs somewhere
  different. The cost is that "where do I sign in" now has three answers, which
  is why the invitation email names the agent one explicitly.
- The customer surface polls. That is a real, bounded inefficiency with a
  named successor, and it is written down rather than discovered later.
