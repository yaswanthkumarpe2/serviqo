# ADR-032: Platform Admins and the Private Operations Console

**Status:** Accepted
**Date:** 2026-09-11
**Phase:** 18 (Admin experience) — the first slice of it, pulled forward
**Implements:** ROADMAP.md Phase 18's "Comprehensive dashboard for organization metrics", at platform scope and read-only
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) §7–19 (permission-based authorization, centralized, no scattered role checks); [ADR-010](./010-principal-types-organization-users-and-customers.md) §1 (a user belongs to as many organizations as they hold memberships in), §3 (`User` carries no tenancy; ownership lives on `Membership`), §5 (the `/auth` prefix is permanently organization-user authentication); [ADR-011](./011-login-and-session-issuance.md) §1–2 (tokens carry no personal data and no role claims); [ADR-015](./015-access-token-verification-and-current-user.md) §1 (the authentication boundary), §6 (one opaque refusal), §7 (a valid signature identifies but does not entitle), §10 (fields a client can read survive a future state), §13 (authorization is not this middleware's job); [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (an unowned tenant is a real, unrecoverable state), §9 (tenant content stays out of logs); [ADR-017](./017-organization-context-and-rbac.md) §1 (a URL cannot be addressed without naming a tenant), §5 (role read from the database on every request), §6 (`403` only after membership is proved), §7 (`requirePermission`); [ADR-018](./018-rate-limiting-and-security-headers.md) §3–4 (classes and user-keyed placement); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §9 (a key-less organization is inert), §10 (empty `allowedOrigins` means closed); [ADR-022](./022-persistent-conversations-and-messages.md) §1 (every conversation read is scoped by `organizationId`); [ADR-025](./025-agent-inbox-and-live-agent-replies.md) §11 (the inbox is keyed by organization so a tenant switch remounts it); [ADR-027](./027-team-management-and-membership-lifecycle.md) §13 (ids, roles, counts — never an address in a log); [ADR-028](./028-organization-ownership-transfer.md) §11 (a class of its own for the rarest operation); ADR-030 (verification codes; an unverified account cannot sign in); CONTRIBUTING.md ("Never rely only on frontend filtering"; "No business logic in JSX"; demo data must say what it is); SECURITY.md §2 (tenant isolation), §4 (security relies entirely on server-side validation, never on the client UI)

## Context

Serviqo has exactly one notion of standing: `MembershipRole`, which is
`owner | admin | supervisor | agent` and is scoped to one organization by
construction. That is correct and it answers only one question — *what may
this person do inside that tenant*.

It cannot answer the question the people running Serviqo actually have. When
a sign-up does not complete, when a tenant reports that its widget never
loads, when someone asks how many organizations exist on this deployment,
there is no principal who can look. The available answers are all bad:

- **Query MongoDB by hand.** Which is what has been happening, and it means
  routine operational questions require production database credentials.
- **Give an operator an `owner` membership in every tenant.** Which is not
  read-only, is visible to that tenant's staff, and grows without bound.
- **Make it a fifth `MembershipRole`.** Which is a category error: every role
  in that enum is scoped to the organization its membership names, and
  "operates the platform" is scoped to none.

There is also a product shape to decide. An operations console is not part of
the customer's experience, and a support product whose marketing site
advertises a staff door invites people to knock on it.

## Decisions

### 1. `platformRole` on `User`, a second axis

`User` gains `platformRole: "none" | "admin"`, defaulting to `"none"`.

This is a **second axis**, not an extension of the first. `MembershipRole`
says what someone may do inside a tenant; `platformRole` says whether they
operate Serviqo itself. An organization owner is the most powerful principal
inside their own tenant and has **no** platform standing whatsoever — the test
that asserts an owner receives 403 from the admin API is the one that keeps
that true.

It lives on `User` because ADR-010 §3 put tenancy on `Membership` and kept it
off `User` entirely. A field on `User` is therefore a fact about the person
and not about any relationship, which is exactly what platform standing is.

`"none"` is a stored value rather than an absent field, so "this account has
no platform standing" is something the database states rather than something
code infers from `undefined`. Mongoose's `default` applies on read for
documents written before the field existed, so every existing account reads
back as `"none"` and **no migration is required**.

### 2. Nothing in the product can write it

Registration cannot set it, no endpoint updates it, no request body is parsed
into it, and no amount of organization ownership confers it. The only writer
is `scripts/grantPlatformAdmin.ts` (§11).

This is the whole security argument for the field. The most powerful role in
the system is reachable only by someone who already holds the database
credentials, so there is no self-service escalation path and no request an
attacker can forge to acquire it.

### 3. `/api/v1/admin`, its own top-level prefix

Three routes: `GET /overview`, `GET /organizations`, `GET /users`.

**Its own prefix, deliberately not nested under an organization.** ADR-017 §1
made "a URL cannot be addressed without naming a tenant" structural, and every
other authenticated route in this API honours it. These are the exception that
proves it: they read *across* tenants, and a tenant path segment would be a
lie.

**Named `/admin` rather than something unguessable.** The console that
consumes it is unlisted (§14), but a URL protects nothing on its own and a
secret path is worse than a plain one because it invites the belief that it
does. What protects these routes is §4, on every one of them.

**Every route is a `GET`, and that is the slice rather than a stage of it.**
This gives operators *sight* of the platform and no reach into it. Disabling
an account, deleting a tenant and reading a conversation each deserve their
own audit trail and their own argument; shipping them beside a dashboard would
smuggle all three in without either.

**`authenticatedRead` rather than a new limiter class.** ADR-027 §12 and
ADR-028 §11 each argued for a new class because their endpoint's abuse shape
differed from every existing one. These are ordinary authenticated reads
performed by a handful of people; inventing a limit for them would be
inventing a number.

### 4. `requirePlatformAdmin`, and the grant is read from the database every time

A new middleware, mounted after `requireAccessToken`:

```ts
router.get("/overview", requireAccessToken, requirePlatformAdmin, rateLimiters.authenticatedRead, controller.overview);
```

It is written out on every route rather than hoisted into `router.use`,
following the convention that "is this route protected?" is answered by
reading the route file — which matters more here than anywhere else, because
this is the only router in Serviqo whose handlers read across tenants.

**The order is load-bearing.** `requireAccessToken` establishes who is
calling; `requirePlatformAdmin` re-reads their grant and refuses everyone
else; only then does the limiter run, so it keys on a verified user rather
than a socket address (ADR-018 §4).

**The grant is never a token claim** (ADR-011 §2). It is read from the `User`
document on every request, exactly as ADR-017 §5 reads a role from the
`Membership` document. That costs one query per admin request — traffic that
rounds to nothing — and buys the property that matters most for the most
powerful role in the system: revoking it takes effect on the holder's very
next request rather than whenever their access token happens to expire. The
test holds one token across a revocation to prove it.

The same exists / active / verified gate `currentUser.service.ts` applies runs
here too (ADR-015 §7). It is repeated rather than shared because the two
refuse *differently* — that service throws 401 because the question is "who
are you", and this throws 403 because the question is "may you", and a caller
who reached this point has already answered the first.

It sets `req.platformContext`, a sibling of `organizationContext` rather than
a field on it. A platform admin's requests name no tenant, and folding
platform standing into a per-tenant context would invite a handler to read
`role` without noticing which axis it was on.

### 5. One refusal, naming nothing

Every refusal is `403` with the same message `requirePermission` uses, which
names no role, no threshold and no endpoint behaviour. An ordinary user who
probes the admin API learns that they may not use it, and nothing about what
it is or who can. A test asserts the words "platform" and "admin" appear
nowhere in a refusal body.

The *reason* — `no_principal`, `unknown_user`, `user_not_entitled`,
`not_platform_admin` — is logged at `warn`, with the user id. That is the one
place the distinctions exist, and the last of them is worth an alert.

**403 rather than 404.** A 404 would hide the endpoint's existence, and the
client bundle names these paths anyway; pretending otherwise would be
security theatre with a worse failure mode, because a genuine 404 and a
disguised refusal would then be indistinguishable during an incident.

### 6. `/auth/me` reports `platformRole`

A seventh field on the `CurrentUser` projection, so a signed-in client knows
which of the two surfaces to render.

Safe to report, because this endpoint tells the authenticated **owner** of an
account a fact about that same account — the caller learns nothing they did
not already have. It follows ADR-015 §10's rule for `status`: a client that
reads it survives a future platform role being added.

It is an **affordance and never a boundary**. A client that set the field to
`"admin"` in its own memory renders the console shell and receives 403 from
every request that shell makes (SECURITY.md §4).

### 7. One repository, and it is the only unscoped read in the codebase

`platformAdmin.repository.ts` reads `Organization`, `User`, `Membership`,
`Conversation`, `Message` and `Customer` without an `organizationId`.
CONTRIBUTING.md's "no unscoped read" rule exists because one tenant's data
must never reach another tenant's request, and none of these methods could be
called on a tenant's behalf without breaking it.

Two things make the exception safe, and neither is this file:

1. Every caller sits behind §4.
2. The methods return **counts and administrative summaries only** — never a
   message body, never a customer identity, never anything a support
   conversation actually said. An operator needs to know a tenant holds 412
   conversations; they have no business reading them, and the way to keep that
   true is for the capability not to exist.

It is its own repository so that "does this codebase contain an unscoped
read?" is answered by reading one file. A `countAll` quietly added to
`conversation.repository.ts` would be the same capability with none of the
visibility.

`countDocuments` rather than `estimatedDocumentCount`, despite the latter
being cheaper: it reads collection metadata, which can lag, and a console
whose numbers are approximately right is one nobody can use to answer "did
that tenant's conversations actually save".

### 8. What the console is told

`/overview` returns platform totals, a user breakdown (verified, unverified,
disabled, platform admins) and a conversation breakdown (open, closed,
unassigned). `/organizations` and `/users` return administrative summaries.

Every field is a count, a status, or an administrative identifier. The staff
**email address** is the one piece of personal data present, and it is there
because the console's whole job is answering "which account is this" — an
operator looking at a stuck sign-up must recognise the address, and a list of
opaque ids cannot be acted on. Customer identities are absent entirely;
customers are counted and never named.

A tenant's widget reachability is reported as **two** facts —
`hasWidgetKey` and `allowedOriginCount` — because they fail separately
(ADR-019 §9, §10) and are different repairs. One "installed" boolean would
hide which.

Logs carry the shape of the answer and never the answer: `platform.users.read`
with a row count, never the addresses (ADR-016 §9, ADR-027 §13).

### 9. Listings are capped, and a cap says so

25 rows by default, 100 maximum, newest first. `?limit=` is clamped rather
than validated: a limit is a hint, honouring `?limit=100000` would let an
authenticated admin turn a URL bar into a full table scan, and answering 400
for `?limit=abc` would turn a typo into an error page.

The response carries `total` alongside the rows, so a truncated list can say
what it is hiding rather than looking complete. No cursor: at the scale where
paging matters, the right design is the one the inbox already has, and
inventing a second paging contract for a page that fits on one screen would
be speculative.

Sorted by `_id` descending rather than `createdAt`. ObjectIds embed their
creation timestamp and are already the indexed primary key, so the sort is
free where `createdAt` would need its own index — and the two orders agree to
the second.

### 10. An unowned tenant renders, flagged

`owner` is `null` when no active `owner` membership resolves. ADR-016 §3
accepts that state as real and unrecoverable, and it is precisely the record
an operator would be called in to look at — so the row renders with a "No
active owner" flag rather than being dropped or throwing.

### 11. `npm run grant:admin`, the only writer

An interactive script that promotes — or demotes — an **existing** account.

**It does not create accounts.** The operator signs up through the ordinary
front door first: real address, real password, real verification. A script
that both minted an account and made it omniscient would be a single command
turning database access into a working platform login; keeping the two steps
apart means an admin account is one a human being demonstrably controls the
inbox of.

**It refuses an unverified account.** An unverified account cannot sign in at
all (ADR-030), so a grant would do nothing while leaving an operator believing
they were finished.

**Revocation lives in the same script**, one keystroke away. A grant script
needs an ungrant script, and the second one is always the one nobody writes.

**It refuses to run under `NODE_ENV=production`**, like `create:admin` and for
a sharper reason: granting platform access is exactly the action an attacker
with a stray environment variable would want.

### 12. The console: read-only, dark, and honest about when it read

`/control` renders totals, two breakdowns, a tenant table and an account
table, with a manual Refresh and the time of the last read — a console is the
kind of thing left open on a second monitor, and figures with no read time are
figures nobody can trust during an incident.

The three endpoints are fetched **together and allowed to fail
independently** (`Promise.allSettled`). An operator opening this page is
usually looking at something already broken, and the least useful response to
a partial failure is a blank screen. A figure that could not be read shows an
em dash, never a zero: a fabricated zero here is the difference between
"nothing is wrong" and "we could not tell".

A 403 mid-session gets its own message — the grant was revoked while the
console was open, which is exactly what §4's per-request read produces, and
"please try again" would be false.

Dark surface, using the charcoal-green the tokens already reserve for dark
sections, so an operator can tell at a glance which of the two Serviqos they
are signed in to. Emerald keeps its four roles; the one place it touches data
is the `Admin` pill, because "this account can see the whole platform" is the
most consequential fact a row here can carry.

### 13. `PlatformAdminRoute`: two gates that fail differently

The session gate sends an unauthenticated visitor to `/control/login`. The
grant gate sends a signed-in ordinary user to `/dashboard` — **not** to an
error and not to a page saying "you are not an admin", because a refusal
naming the console is the one thing that would advertise it.

Neither gate acts on "not yet known": the guard waits for both the startup
refresh and the `/me` answer, because treating an unread grant as no grant
would bounce every admin to the dashboard for a frame on every load.

It takes children as a **function** of the confirmed user, so the console is
handed the identity the guard already fetched rather than asking `/me` twice
for one answer.

Like `ProtectedRoute`, it is a UX control and not a security boundary.

### 14. Two login pages, and the second one is unlisted

`/control/login` is a separate page, not a mode of `/login`. The two differ in
where they send someone, in what they say, and in whether anything links to
them; a single page with an `?admin=1` branch would put all three differences
inside conditionals the public page's tests would have to know about.

It is **not a second way to authenticate**. It posts to the same
`POST /auth/login` with the same credentials and receives the same session.
There is no separate admin password, no second token audience, and no bypass —
only a different destination, which §13 re-checks against the server.

It offers no sign-up, no password reset, and no link back to the site. Every
one of those is a door, and this page has one. Its copy says "Sign in to
continue" and never "staff accounts only", which would tell a stranger that a
staff role exists and that this is where to try it.

Both console pages set `<meta name="robots" content="noindex, nofollow">` on
mount and remove it on unmount — set per route rather than in `index.html`,
which is one document shared by every route in a single-page app and would
delist the marketing site. This is housekeeping, not a defence: a crawler that
ignores the tag is refused by §4 like everyone else.

**Unlisted is a product decision, not a security control.** It is recorded
here so it is not lost to a link added in passing, and two tests assert that
neither the public sign-in page nor the workspace mentions `/control`.

### 15. The workspace: the sample metrics are gone, and the inbox comes first

Two changes to `/dashboard`, made in the same slice because they are the same
problem.

The three placeholder metrics that closed the page are **removed**. They were
correctly labelled "SAMPLE DATA", which CONTRIBUTING.md requires, and they
were still the first thing a new user's eye landed on after signing up — three
empty figures under a badge, below the one section that does something. The
cheaper way to satisfy that rule is to ship no demo data, and the aggregate
endpoint that would make those figures real is its own slice.

The four real sections — inbox, team, widget installation, organizations —
move behind a **view switcher**, with the inbox first and selected by default.
Stacked vertically, the conversation list shared a scroll position with
installation snippets and a roster; an agent's actual work was below the fold
of an administrative page.

Each panel is **mounted only while selected** rather than hidden with CSS,
which matters most for the inbox: it holds an open socket, and a
hidden-but-mounted copy would keep streaming a tenant's messages into a
component nobody is looking at. Each is still keyed by organization id, so a
tenant switch discards state rather than reconciling it (ADR-025 §11).

The switcher is a real `tablist` with arrow-key navigation and roving
`tabindex`. A `tablist` that ignores arrow keys announces itself as navigable
and then behaves like four unrelated buttons, which is worse than not claiming
the role.

### 16. What this slice does not do

- **No writes of any kind.** No disabling an account, no suspending a tenant,
  no resending a verification code on someone's behalf, no impersonation.
- **No audit log.** Reads are logged through the ordinary request logger.
  Before any write endpoint exists here, a real audit trail must — an
  operations surface that can change things without recording who changed them
  is worse than no surface.
- **No access to conversation content.** By construction, in the payload.
- **No second platform role.** `"admin"` is the only non-`"none"` value.
  `viewer` / `support` / `billing` distinctions are exactly the speculative
  hierarchy that would need a permission catalogue, and there is one operator.
- **No self-service grant, ever.** §2.
- **No cursor paging, no search, no filtering.** §9.
- **No billing, no system logs, no global settings** — the rest of Phase 18.

## Consequences

- Routine operational questions no longer require production database
  credentials.
- The codebase now contains one deliberately unscoped repository. That is a
  standing risk and is why it is one file with a header that says so; a review
  of tenant isolation now has exactly one place to look beyond the scoped
  repositories.
- `platformRole` is a new field on `User` that nothing in the application
  writes. A future endpoint that needed to write it would be re-opening §2,
  which is the intended friction.
- The operations console and the workspace are now two experience zones, which
  is the first real argument for the code splitting ARCHITECTURE.md §3
  anticipates. It is still not enough — both are one page each, and a lazy
  boundary around a single component buys a spinner and no bytes.
- `/control` is guessable. That is accepted and stated, so nobody later
  mistakes the address for a control.
