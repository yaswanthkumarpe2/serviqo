# ADR-037: Customers Never Authenticate

**Status:** Accepted
**Date:** 2026-09-14
**Phase:** 2 (Authentication), 3 (Roles)
**Supersedes:** [ADR-034](./034-customer-accounts-and-agent-invitations.md) §1–6 and §9 (customer accounts, the customer dashboard, and the customer's front door)
**Amends:** [ADR-031](./031-credential-rate-limit-classes.md) §3 (the `registration` class is removed with its route); [ADR-036](./036-password-reset-by-emailed-code.md) §6 (reset serves staff only)
**Related:** [ADR-010](./010-principal-types-organization-users-and-customers.md) (organization users and customers are different principals); [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) (the anonymous widget visitor); [ADR-032](./032-platform-admin-and-operations-console.md) (the super admin); [ADR-035](./035-session-durability-admin-separation-and-owned-mail.md) §4 (admins are their own kind)

## Context

ADR-034 gave customers accounts: sign up at `/signup`, verify a six-digit code,
choose a password, and land on a `/dashboard` with one chat. That reversed
ADR-010 §5, which had said customers never authenticate and reach Serviqo only
through the widget.

The product decision now is the original one, stated more strongly: **customer
authentication is friction a support product must not impose.** A person with a
problem should open an organisation's chat and start typing. No account, no
email code, no password. They are identified to the organisation by an anonymous
visitor identity, and name, email and phone are optional details they may give.

Most of what that needs already exists. ADR-019's widget session creates an
anonymous `Customer` scoped to one organisation, and ADR-022's conversations and
messages are keyed by that organisation. This slice removes the parallel
signed-in path, so that the widget is the only door a customer has.

## Decisions

### 1. No public route creates an account

`POST /auth/register` is removed, together with `registration.service.ts`. That
was the only unauthenticated way to create a `User`. From here on, **every
account is staff, and every staff account exists because somebody invited it**:
today through the console's agent invitation (ADR-034 §7), and per organisation
in ADR-039.

The `registration` rate-limit class goes with the route. A limiter guarding
nothing is a number someone will one day tune for no reason.

What stays: `verify-email` and `resend-verification`, because invited staff
still prove their address; `login`, `refresh`, `logout`; change-password; and
password reset.

### 2. No signed-in customer surface

Removed:

- the `/api/v1/me` router (`customerPortal`);
- `requireCustomerAccount`, and `req.customerContext` with it;
- `Customer.userId` and its partial unique index.

`Customer` is back to exactly ADR-019's model. The field and index were written
for signed-in customers only; with none, "one customer per account" has nothing
to constrain, and ADR-019 §3's "the tenant-boundary index, and deliberately the
only one" holds again.

An existing database may still hold the old `{ organizationId, userId }` index.
It is partial on `userId` being an ObjectId, which no document now has, so it
matches nothing and is harmless. Dropping it is an operator's choice, not a
deploy step.

### 3. `UserKind` is staff only, and legacy customer accounts are inert

`UserKind` becomes `"agent" | "admin"`, defaulting to `"agent"`: an invitation
is always for staff.

Documents ADR-034 wrote still say `"customer"`, so the database type is one
value wider (`StoredUserKind`), and the schema enum still admits it so those
documents load. `isStaffKind` is the gate, applied everywhere a session is
created or honoured:

| Where | What happens to a legacy customer account |
| --- | --- |
| `login` | Refused with the generic `INVALID_CREDENTIALS`, after the password, exactly as a disabled account is. |
| `refresh` | The session is revoked, so a customer who was signed in is out on the next reload rather than in seven days. |
| `/auth/me` | Refused, so an access token issued before the change stops working. |
| password reset | Sends nothing. A reset would hand a password to an account that can no longer sign in. |

Keeping the wider type is deliberate. A type that claimed these documents
cannot exist would let the gate be deleted as dead code.

### 4. One staff sign-in page

`/login` is the staff sign-in page. There is no sign-up link. Its lede tells a
customer who arrives there that they don't need an account and should use their
organisation's chat link. Its foot sends a newly invited person to enter their
code first.

- `/agent/login` renders the same page, because invitation emails already sent
  link to it.
- `/control/login` is unchanged: the unlisted console door.
- `/signup` falls through to the landing page, like any unknown path.
- `/dashboard` redirects to `/home`, which resolves to the staff surface the
  account belongs on.

### 5. A session with no staff surface is signed out, not bounced

`homePathFor` used to fall back to the customer dashboard. With no such surface
it returns `null` for an unrecognised kind. `AgentRoute` and
`PlatformAdminRoute` each used to answer "not yours" with "go to the one that
is", which loops once an account belongs on neither. This affects a legacy
customer session, and also an admin-kind account whose platform grant was
revoked (that one would loop between `/control` and itself). `NoStaffSurface`
ends the loop: it signs the browser out and shows the sign-in page, silently,
like the redirects it replaces.

### 6. Tests create staff the way invitations leave them

Twenty-odd suites created people through `POST /auth/register`. They now use
`createStaffAccount` (`modules/auth/testing/staffAccounts.ts`), which leaves an
account in exactly the state registration did: unverified, one code
outstanding, and that code handed to the provider so the fake captures it.

It lives under `testing/` and nothing in production imports it. An account made
without an invitation is precisely what the product no longer allows.

## Consequences

- A customer's only way into Serviqo is an organisation's widget. ADR-038 gives
  every organisation a hosted link for it, so that door does not depend on the
  organisation embedding a script on its own site.
- No account-existence oracle is left on an unauthenticated route that creates
  anything. Registration's deliberate 409 (ADR-007 §1) is gone with the route.
- Organisation creation is untouched here. Who may create an organisation, and
  how its first admin is invited, is ADR-039's.
- The six test accounts ADR-034 created in the development database can no
  longer sign in. They remain visible in the console's user list as `customer`.
