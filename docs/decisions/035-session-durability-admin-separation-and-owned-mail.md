# ADR-035: Session Durability, Admin Separation, and Sending Your Own Mail

**Status:** Accepted
**Date:** 2026-09-14
**Phase:** 2 (Authentication), 3 (Roles), 18 (Admin experience)
**Amends:** [ADR-018](./018-rate-limiting-and-security-headers.md) §4, which keyed the session class by IP; [ADR-032](./032-platform-admin-and-operations-console.md) §8, which made the console read-only and content-free; [ADR-034](./034-customer-accounts-and-agent-invitations.md) §1, which had two kinds of account
**Related:** [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) (rotation and reuse detection); [ADR-011](./011-login-and-session-issuance.md) §12 (the refresh cookie's attributes); [ADR-012](./012-refresh-token-rotation-endpoint.md) §4, §6, §8 (the startup restore and its coalescing); [ADR-017](./017-organization-context-and-rbac.md) §5 (role read from the database per request); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md); [ADR-030](./030-email-verification-codes.md) — cited unlinked, that file is absent from the repository; [ADR-031](./031-credential-rate-limit-classes.md) (the credential classes); [ADR-033](./033-workspace-shell.md) (the agent workspace); [ADR-034](./034-customer-accounts-and-agent-invitations.md) (customer accounts, agent invitations); SECURITY.md §3, §4

## Context

Four reports, from using the product rather than from reading it:

1. **"When I refresh it sends me back to login."** A session that should have
   survived a reload did not.
2. **"The admin was logging in to the agent portal."** One account reached two
   staff surfaces.
3. **"The admin portal should show team and chat."** The console could only
   count things, which left an admin with no way to see the conversations they
   were responsible for — because ADR-034 §10 had just taken the workspace away
   from them.
4. **"I don't want to use third-party hosts like Resend."**

The first is a defect with two causes and is the most serious. The fourth
cannot be solved the way it was asked, and §7 says why.

## Decisions

### 1. The session bug had two halves, and both were real

**Half one, the server.** The `session` class — `/auth/refresh`, `/auth/logout`,
`/auth/logout-all` — was keyed by IP at sixty requests per fifteen minutes.
That was ADR-018 §4's reasoning applied honestly: these routes run before any
principal exists, so there was no verified caller to key on.

But a refresh is what every page load costs. Several tabs, a few reloads, Vite
re-mounting in development, and a person can spend sixty in fifteen minutes
without doing anything unusual — and because the key was an IP, they spent it
on behalf of every browser and every colleague behind the same address.

**Half two, the client.** `AuthProvider.refreshAccessToken` cleared the session
on *any* rejection:

```ts
.catch((error: unknown) => {
  applySession(null);   // 429, 500, dropped connection — all of it
  throw error;
})
```

So a refusal that meant "wait a moment" was read as "you are signed out", and a
perfectly valid `HttpOnly` cookie was abandoned by the tab holding it.

Either half alone is survivable. Together they are a product that signs you out
for reloading it.

### 2. The session class keys on the session, not the IP

The refresh cookie is `sessionId.secret`, and `parseRefreshToken` already
separates them because the first half is explicitly the **non-secret routing
component**. That is a far better limiter key than an address: one browser can
then only exhaust its own budget.

**Only the id is used, never the secret.** A secret used as a limiter key would
sit in the limiter's memory, in plaintext, for the length of the window.

**Nothing is verified first, and that is accepted.** An attacker can invent a
well-formed session id and get a fresh budget. This key's job is isolating
honest clients from each other; bounding an attacker is the `global` per-IP
class's job, and a refresh secret is 256 bits, so guessing is not the threat.

A caller with no cookie falls back to the IP — exactly the unauthenticated
caller who deserves the blunter key, and the reason §2 does not weaken the bound
that matters.

### 3. Only a 401 ends a session

The client now clears on `401` and on nothing else. A 429, a 500, or a dropped
connection leaves the session in place and rethrows, so `authorizedRequest`
still declines to replay with a stale token and the startup restore still lifts
its splash — what changed is only whether a session that might still be good is
thrown away on the way past.

A 401 is different in kind: it is the server saying the cookie is gone, expired
or revoked, and there is nothing left to preserve.

### 4. An admin is a third kind, and is neither of the other two

`UserKind` gains `"admin"`. An account that operates the deployment is not one
of the tenant's customers and not one of its agents.

This is a **surface**, not a grant. `platformRole` decides what the server will
let somebody read; `kind` decides which of the three shells to render. One
account holds both today, and keeping them separate is what lets the login
response route somebody without carrying their grant in it.

The consequence asked for: an admin reaching `/agent` is redirected, because
`isAgent` is false for them. Every "wrong place" redirect now asks
`homePathFor` where the right place is rather than naming one, so a third kind
could not be sent somewhere stale — `AgentRoute` sending a platform admin to the
customer chat would have bounced them straight back.

They still **own** the organization, which is a membership role on a different
axis entirely. What they lose by not being an agent, §5 gives back.

### 5. The console carries the team and the chats

ADR-032 §8 said the console looks and does not touch, and ADR-032 §7 said the
platform API carries counts and never conversation content. **The second is
unchanged.** `/api/v1/admin` still returns no message body.

What the console gained is a **second source**: the tenant endpoints, for an
organization this admin owns. The Chats and Team views mount the very same
`AgentInbox` and `TeamManagement` the workspace uses, pointed at the
organization `/me` reports a membership in.

That distinction is the whole justification, and it is worth stating precisely:
**an admin does not see a tenant's conversations because they are a platform
admin — they see them because they hold an `owner` membership in that
organization**, and `requireOrganization` and `requirePermission` authorize those
reads exactly as they would for any other owner. A platform admin with no
membership anywhere still sees nothing but counts, and the console says so.

Reusing the components rather than building console-flavoured copies keeps one
implementation of the inbox and one of the roster. They are wrapped in a light
panel because they were drawn for the workspace's canvas; re-theming two large
components would be a great deal of CSS spent making them look like something
they are not.

The page's lede is now **per view**. Its old line — "counts only, no
conversation content reaches this page" — stopped being true the moment the
Chats view existed, and a standing claim about what a page does not contain has
to be withdrawn when it starts containing it.

### 6. The cookie notice says what is true

A banner on every page until a choice is recorded, offering Accept and Decline.

**It disables nothing, and the copy says so.** Serviqo sets exactly one cookie —
the `HttpOnly` refresh cookie (ADR-011 §12) — and there is no analytics,
advertising or third-party tracking to decline. The two dishonest versions were
both available and both rejected: a Decline that silently does nothing while
implying otherwise, and a Decline that disables the sign-in cookie and breaks
the product for whoever pressed it. So the choice is recorded, the notice goes
away, and the text is plain that declining changes nothing *today*.

It is worth having anyway, because `hasAcceptedCookies` is the gate the first
third-party script would be mounted behind, and it already defaults to false.

The choice lives in `localStorage`, not in a cookie — storing consent in a
cookie means setting one before consent. Every access is wrapped, because
`localStorage` throws rather than returning null in a browser configured to
block site data, and that visitor is precisely the one most likely to have done
it.

`role="region"`, not `role="dialog"`: it blocks nothing and traps no focus, and
claiming the stronger role would promise a screen reader behaviour it does not
have.

### 7. Sending your own mail, and what that does not fix

`SmtpEmailProvider` sends through any SMTP server — a self-hosted Postfix, a
corporate relay, a different vendor, a local catcher. `resolveEmailProvider`
prefers it whenever `SMTP_HOST` is set, so a deployment switches by setting
environment variables and removing the Resend key is optional rather than a
prerequisite.

That removes the **vendor**. It does not improve **delivery**, and the request
that prompted it was about mail landing in spam, so the distinction has to be
written down rather than discovered:

> Whether Gmail accepts a message is decided by the sending IP's reputation, by
> SPF/DKIM/DMARC alignment on the sending domain, and by whether the sending
> network is one Gmail has reason to trust. None of those is a property of the
> software that opened the socket. A self-hosted server on a residential
> connection is the worst case for all three — such IPs are on blocklists by
> default, most consumer ISPs block outbound port 25 outright, and mail from
> them is rejected or spam-foldered regardless of how correct the code is.
> Moving from a vendor's warmed pool to one will make delivery **worse**.

So this provider exists to make the choice *available and deliberate*, not
because it is the fix. The actual fix for deliverability is a domain the sender
controls, correct SPF/DKIM/DMARC on it, and a sending IP with a reputation —
which is what a vendor is selling, and why ADR-007 §10's seam was built to
accommodate one.

**A DNS server is deliberately not built.** It was asked for alongside this and
it addresses none of the problem: authoritative DNS needs a registrar
delegation, glue records, and ideally two nameservers on stable networks, and
none of that is code. The records that matter here — SPF, DKIM, DMARC — are
four TXT entries at whatever DNS host the domain already uses, and writing a
server to host them ourselves would add an outage mode without removing a
dependency.

### 8. What this slice does not do

- **No retry on a rate-limited refresh.** The client no longer discards the
  session, but it does not schedule a retry either. §2 makes exhausting the
  budget unlikely enough that a retry loop would be speculative machinery.
- **No console writes beyond adding an agent.** ADR-032 §16's rule still
  stands: the platform surface needs a real audit trail before it grows more.
- **No DKIM signing in the SMTP provider.** Signing belongs to the MTA, not to
  the client that hands it a message.
- **No consent-gated anything.** There is nothing to gate.

## Consequences

- Reloading no longer signs anybody out, for either of the two reasons it used
  to. The limiter change is the one that matters — the client change is what
  keeps a future transient failure from costing a session.
- An admin has exactly one surface. The cost is that they cannot answer a
  conversation from the workspace any more; the console's Chats view is where
  they do it instead.
- The console now renders tenant content, which ADR-032 deliberately kept out
  of it. The line held is narrower than before and is stated precisely in §5:
  the platform API carries no content, and everything the console shows beyond
  counts is authorized by a membership.
- A deployment can send its own mail. Whether it *should* is answered in §7,
  and the answer for a residential network is no.
