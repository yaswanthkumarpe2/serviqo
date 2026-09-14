# ADR-039: Organisation Administration

**Status:** Accepted
**Date:** 2026-09-15
**Supersedes:** [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §1 (any verified user may create an organisation); [ADR-034](./034-customer-accounts-and-agent-invitations.md) §4 and §7 (agents invited into one default organisation); [ADR-035](./035-session-durability-admin-separation-and-owned-mail.md) §5 (the console reaches only an organisation the admin owns)
**Related:** [ADR-017](./017-organization-context-and-rbac.md) (roles and `requireOrganization`); [ADR-027](./027-team-management-and-membership-lifecycle.md) (the roster); [ADR-032](./032-platform-admin-and-operations-console.md) (the console); [ADR-037](./037-customers-never-authenticate.md); [ADR-038](./038-one-chat-link-per-organisation.md)

## Context

Serviqo's hierarchy is: super admin → organisations → organisation admins →
agents → anonymous customers, with one chat link per organisation.

Three parts of the code did not match it:

- **Anyone could create an organisation.** Any verified staff account could
  call `POST /organizations` and become an owner.
- **Invitations had no organisation to choose.** The console's "add an agent"
  always used the oldest organisation, which is wrong as soon as there are two.
- **The super admin reached only one organisation.** The console could open an
  organisation's chats only if the admin happened to own it.

## Decisions

### 1. Only the super admin creates organisations

`POST /api/v1/organizations` is removed.
`POST /api/v1/admin/organizations { name, owner: { name, email } }` replaces it.

- The organisation gets its slug the way it always did, and with it a chat link
  (ADR-038).
- The owner is invited in the same request.
- The owner's address is checked **before** anything is written. If the
  invitation still fails (for example, the email cannot be sent), the new
  organisation is removed, so no organisation is ever left without an owner.

### 2. Suspending and reactivating

`PATCH /api/v1/admin/organizations/:id/status { status }`.

Suspension is the state every gate already checks, so nothing else had to
change. A suspended organisation:

- has a chat link that says "not available";
- refuses widget sessions;
- refuses its staff.

Reactivating reopens all three.

### 3. One invitation service

`staffInvitation.service.ts` is the only way anyone joins an organisation.

- **New address:** a staff account is created, unverified, with a generated
  password. One email carries the password and a six-digit code, and the
  password does nothing until the code is redeemed. If the email cannot be sent,
  the account is removed again, because the password existed only in that email.
- **Existing staff account:** a membership is added, and a notice email is sent
  with no credential in it.
- **Refused:** a platform admin, a legacy customer account, or a disabled
  account cannot be invited.
- **Owner:** `owner` can be invited only into an organisation that has no owner.
  Otherwise the owner role is changed by ownership transfer (ADR-028).
- **Emails name the role:** "the owner", "an admin", "a support agent".

The service is used from two places:

- `POST /api/v1/admin/organizations/:id/members { name, email, role }`: the
  super admin, any organisation, any role.
- `POST /api/v1/organizations/:id/members { email, role, name? }`: an
  organisation's owners and admins (`member.manage`). With a `name`, an unknown
  address becomes a new invited account. Without one, the request means what it
  always did: add an existing verified account.

### 4. Organisation admins build their own team

The Team page's add form gains a name field. Filling it in invites someone new;
leaving it empty adds an existing account. Agents still cannot manage members.

### 5. The super admin acts inside any organisation

When the caller has no membership, `requireOrganization` checks whether the user
(read from the database on this request) is an active, verified platform admin.
If so, and the organisation exists and is active, the request proceeds with:

```
organizationContext = { organizationId, role: "admin", membershipId: null, viaPlatformAdmin: true }
```

- **What that allows:** the super admin can read, reply, assign and manage the
  team, but cannot transfer ownership, which only an owner holds.
- **Audit:** every such request is logged as
  `auth.organization.platform_admin_access`, with the user, the organisation, the
  method and the path.
- **Socket:** the socket handshake makes the same fallback, so the console's
  inbox is live.
- **Suspension and revocation:** a suspended organisation refuses the super admin
  like everyone else. Revoking the platform grant takes effect on the next
  request.

`GET /organizations/:id` reports `viaPlatformAdmin`, so the client can tell the
difference.

### 6. The console

Three views: **Overview**, **Organisations** and **Accounts**.

- **Organisations** holds the create form, which shows the new chat link as soon
  as it succeeds.
- Each row shows the chat link with copy and open buttons, the owner (flagged
  when there is none), staff and chat counts, an Open button, and a
  suspend/reactivate control.
- **Open** shows that organisation's Chats and Team, and an Invite form that can
  name an owner.

The workspace's empty state no longer suggests creating an organisation. It says
to ask an admin for an invitation.

SVG icons were added for organisation, super admin (shield), agent (headset),
widget, and the navigation and row actions.

## Consequences

- The hierarchy is enforced by the server:
  - only the super admin creates organisations;
  - only an organisation's owners and admins add its staff;
  - only the super admin crosses organisations, and every crossing is logged.
- Tests that needed "a person who owns an organisation" now use
  `createOrganizationAs` (`modules/organizations/testing/organizations.ts`), which
  creates exactly that state without an HTTP route.
- The onboarding service's `createOrganization(input, actor)` remains, and is
  used only by that test helper. Organisation creation in production goes through
  `createWithAvailableSlug` and the invitation service.
