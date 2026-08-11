# ADR-010: Principal Types — Organization Users and Customers

**Status:** Accepted
**Date:** 2026-08-11
**Phase:** 2 (documentation-only; precedes the login slice)
**Related:** [ADR-002](./002-phase-2-authentication-architecture.md) (authentication architecture), [ADR-003](./003-domain-first-server-modules.md) (module layout), [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) (sessions), [ADR-005](./005-account-action-token-lifecycle.md) (account action tokens), [ADR-007](./007-registration-flow-and-account-enumeration.md) (registration), [ADR-009](./009-email-verification-consumption.md) (verification)
**Amends:** ADR-004 §8, ADR-005 §2

## Context

Serviqo's founding documents describe five RBAC roles: Owner, Admin,
Supervisor, Agent, and Customer. The persistence layer never built the
fifth. `membership.model.ts`, written in Slice 4, declares:

```ts
export type MembershipRole = "owner" | "admin" | "supervisor" | "agent";
```

Four roles, enforced by a schema `enum`. Nothing recorded why the fifth was
dropped, so the divergence has sat unexplained across seven slices — the
documentation asserting one model and the database enforcing another.

Slice 12 issues Serviqo's first credential. Once an access token exists, the
question "what kinds of principal does this system authenticate?" stops
being editorial and starts being encoded in a token that clients hold. It
has to be settled first, because every later decision — the `Customer`
model, the widget credential, Socket.IO room membership, conversation
authorship — either inherits the answer or contradicts it.

This ADR is documentation only. It changes no code and describes no slice.

## Decisions

### 1. Serviqo has exactly two principal types

| | Organization user | Customer |
|---|---|---|
| Represented by | `User` (+ `Membership`) | future `Customer` model |
| Authenticates | Yes | **Never** |
| Credential | password → `Session` + access token | future visitor identity mechanism |
| Owns `Session` | Yes | No |
| Owns `AccountToken` | Yes | No |
| Owns `Membership` | Yes | No |
| Tenant scope | global identity, per-org access via `Membership` | belongs to exactly one organization |
| Enters through | the dashboard | the website chat widget |

An organization user is someone who *works* for a tenant: Owner, Admin,
Supervisor, or Agent. A customer is a website visitor the tenant *serves*.
They arrive by clicking a widget, start chatting immediately, and a
conversation is created and routed for them automatically. They register
nothing and log into nothing.

### 2. Customer is not an RBAC role

Three independent reasons, any one of which is sufficient.

**A role is a position inside a tenant.** RBAC answers "what may this
principal do inside organization X". Owner, Admin, Supervisor, and Agent
are positions someone holds within an organization, granted by a
`Membership` document. A customer holds no position inside the
organization; they are the counterparty it exists to serve. Putting them
on the same axis conflates "who works here, at what level" with "who is
being helped".

**`"customer"` in the enum would imply a `Membership`, which implies a
`User`, which implies a password.** `Membership.userId` is `required` and
references `User`, whose `passwordHash` is also `required`. A membership
row for a customer is unconstructible without inventing a fake user with a
fake credential — precisely the phantom-record pattern that produces
authorization bugs later, because every query that means "the people who
work here" would then have to remember to exclude one role.

**The permission model is org-scoped; a customer's access is not.** Every
permission named in `PROJECT_CONTEXT.md` §5 (`conversation.read`,
`ticket.update`, `ai.configure`) grants access to a *class* of the
organization's resources. A customer needs access to exactly one
conversation — their own — and to nothing else in the tenant, ever. That is
resource-level authorization, a different mechanism with a different
predicate. Expressing it as a role would mean every permission check
carrying a special case for the one role that means "not actually a member",
and the first check that forgets the special case is a cross-tenant leak.

Custom roles remain a future possibility (`PROJECT_CONTEXT.md` §5). They
will be additional *staff* positions. Nothing here forecloses them.

### 3. `User` represents organization staff only

The model already enforces this; this ADR only names it.

- **`passwordHash` is `required`.** A customer never sets a password, so a
  customer cannot be a `User` document without violating the schema.
- **`email` is `required` and globally `unique`.** A visitor may have no
  email at all. Worse, one person who contacts two different Serviqo
  tenants must be two independent records — a global unique index forbids
  exactly that, and relaxing it to accommodate customers would weaken the
  constraint that keeps staff identity singular.
- **`User` deliberately carries no `organizationId`** (ADR-002 §3, ADR-004
  §8), because a person may work for several organizations. A customer is
  tenant-owned by definition, and `SECURITY.md` §2 requires every
  tenant-owned resource to carry `organizationId`. The two models want
  opposite things from the same field.
- **`Session` authenticates the global `User` identity so a user can switch
  organizations without re-authenticating** (ADR-004 §8). For a customer,
  who exists inside exactly one tenant, that capability is meaningless.

**`User` is not renamed.** It is frozen, tested code across five modules,
and a rename would churn every one of them to buy clarity that this
paragraph buys for free. Wherever `User` appears, it means an organization
user. `Customer` is its sibling, not its subtype.

### 4. `Customer` becomes a separate model

Already anticipated: ADR-002 §7–19 lists `Customer` among the schemas that
do not exist yet, alongside `Conversation` and `Ticket` rather than as a
variant of `User`; ADR-003 lists `modules/customers/` as a future domain
module beside `modules/users/`.

Its shape is not designed here, but four properties follow directly from
§1–§3 and are binding on whoever writes it:

- **Tenant-scoped.** `organizationId` is required. Uniqueness is
  per-organization and compound — never global. The same human contacting
  two tenants is deliberately two `Customer` documents; that is what tenant
  isolation means for this entity.
- **No password, no `Session`, no `AccountToken`.**
- **`email` is optional.** This is the sharpest structural difference from
  `User`. An anonymous visitor may have no identifying attribute beyond a
  widget-issued identifier and an `organizationId`.
- **Anonymous-first, upgradeable.** A visitor may later supply their
  details, including through the AI's `collectCustomerDetails` tool
  (`PROJECT_CONTEXT.md` §14). Whether that upgrades the existing document or
  links two is a design question for that model, but the model must be
  written knowing it will be asked.

### 5. Login — and every credential flow — applies only to organization users

`POST /api/v1/auth/register`, `/resend-verification`, and `/verify-email`
(shipped) and `/login`, `/refresh`, `/logout`, `/forgot-password`, and
`/reset-password` (future) are **staff flows without exception**. The
`/api/v1/auth` prefix is permanently organization-user authentication.

Three consequences that must be honoured by the slices that build them:

**Access tokens must declare their principal type.** The token issued at
login carries an audience (or equivalent principal-type claim) identifying
it as a dashboard credential, and verification rejects any token whose
audience does not match. Today there is one principal type and this looks
like ceremony. The moment a visitor credential exists, it is the single
control preventing token confusion — a visitor credential verifying on a
staff route. It costs one claim now and cannot be retrofitted onto tokens
already issued.

**A separate route namespace is reserved for customer-facing traffic**
(`/api/v1/widget/*` or `/api/v1/public/*`, chosen when that slice arrives).
Customer traffic never appears under `/api/v1/auth`. Reserving it now costs
nothing; discovering the collision at Phase 20 costs a migration.

**ADR-007 §1's enumeration tradeoff is scoped to staff.** Registration
answers a specific `409 EMAIL_ALREADY_EXISTS` because "the set of addresses
at a customer organization is not a secret worth this cost". That reasoning
covers employee addresses. It is **not** a licence to disclose whether a
given website visitor has ever contacted a tenant, which is a different and
more sensitive fact. No customer-facing endpoint may adopt it by analogy.

### 6. Customer identity is a separate mechanism — not `Session`, not `AccountToken`

**Not `Session`.** ADR-004 designs a Session as one login on one device,
with a rotating `sessionId.secret` refresh token and bounded-history reuse
detection, whose `userId` references `User`. A customer has no `User` to
reference, and the machinery solves a problem an anonymous, ephemeral
visitor does not have.

**Not `AccountToken`.** ADR-005 §2 fixes its purposes at exactly
`email_verification` and `password_reset` and explicitly rejects widening
them. A visitor credential is added to that out-of-scope list by this ADR.
It is also the wrong lifecycle: an account action token is issued once, used
at most once, and dies; a visitor credential must survive an entire
conversation and probably a return visit.

The visitor mechanism is deliberately **not designed here**. What is fixed
is that it is a third thing, and that a future slice may not shortcut its
way to a customer credential by extending either existing model.

### 7. `Conversation` relates `Customer` and `User` separately

Binding on the future conversation model:

- **Two distinct, explicitly named references** — the customer party and the
  assigned staff member — pointing at two different collections. Never one
  polymorphic `participantId`, and never a shared `userId` that means
  different things depending on a sibling field. A single ambiguous
  reference is how a cross-type authorization check ends up comparing the
  wrong identifier to the wrong collection.
- **`organizationId` is derived server-side from the widget credential,
  never read from the request body.** This is `PROJECT_CONTEXT.md` §22's
  "never trust frontend-supplied identifiers" applied where it is most
  tempting to violate, because the caller is an anonymous browser that
  appears to need to say which tenant it is contacting. It does not: its
  credential says so.
- The existing sender union — `CUSTOMER`, `HUMAN_AGENT`, `AI_AGENT`,
  `SYSTEM`, `AUTOMATION` (`PROJECT_CONTEXT.md` §8) — already discriminates
  correctly and needs no change. `senderType` determines which collection
  `senderId` points into.

### 8. Widget authentication must never reuse staff sessions

Beyond §6's modelling argument, the blast radii are not comparable.

A staff refresh token grants the Serviqo dashboard across **every**
organization its owner belongs to (ADR-004 §8), for the full session
lifetime, with rotation designed to keep it alive. A widget credential
lives inside a third-party website, in a page Serviqo does not control,
served from an origin Serviqo does not own, and is handed to anyone who
opens that page. Issuing the former in the latter's position would put
full-tenant staff authority into an untrusted document.

The cookie boundary follows: the staff refresh cookie is `HttpOnly`,
`SameSite`-restricted, and `Path`-scoped to the auth prefix, which — as a
direct consequence — means it can never be sent to a widget endpoint.
Cross-origin credential handling for the widget is that slice's problem to
solve from scratch, not a matter of loosening the staff cookie until it
also works there. Any proposal to widen `SameSite`, broaden the cookie
`Path`, or share the signing key between the two is a violation of this
ADR.

### 9. Future implications

**Socket.IO (Phase 7).** Connection authentication becomes two verifiers,
one per principal type. Room membership is **asymmetric and this is the
isolation-critical part**: staff join the organization room and their
conversation rooms; a visitor joins **only** their own conversation room and
must never join the organization room, which carries tenant-wide events. A
visitor in the org room would receive every conversation in the tenant —
the exact failure `SECURITY.md` §2 exists to prevent.

**Rate limiting (deployment gate, ADR-007 §13).** Two limiter classes, not
one. Staff endpoints face a small, known population and are additionally
protected by per-account lockout. Customer endpoints are high-volume,
anonymous, and unauthenticated by design, so conversation creation needs
per-key and per-origin limits that account lockout cannot provide.

**CORS and CSP.** Staff endpoints are same-origin. The widget is
cross-origin by definition and requires an allowed-origin list bound to the
tenant. Neither `cors` nor `helmet` is installed today; the widget slice is
where that stops being acceptable.

**Analytics (Phase 19).** Metrics partition by principal type — agent
performance counts staff actions, deflection and volume count customer
interactions. A schema that cannot tell them apart cannot produce either
number correctly.

**AI (Phases 12–17).** Tenant isolation of RAG and catalogue retrieval is
scoped by `organizationId`, which for a customer-initiated conversation is
resolved from the widget credential (§7) rather than from anything the
visitor sent. The AI serves customers but is configured by staff:
`ai.configure` is a staff permission, and no customer-facing input may
reach a configuration path.

**Audit logging (`SECURITY.md` §9).** Staff actions are audit events.
Customer actions are conversation events. Two trails with different
retention, different readers, and different tamper-evidence requirements.

### 10. Explicitly out of scope

- **The `Customer` model's fields and indexes** — §4 fixes four properties;
  the rest belongs to the slice that writes it.
- **The visitor identity mechanism** — §6 fixes what it is not.
- **API keys and webhooks (Phase 21)** — a *third* principal type,
  machine-to-machine. Named here only so it is not later conflated with
  either of the two, which is the likeliest place this ADR gets
  accidentally violated.
- **Whether a customer-facing portal ever exists.** If Serviqo later offers
  visitors a way to revisit their own ticket history, that is a new
  decision requiring a new ADR and a new identity mechanism. It is not
  reachable by relaxing anything written here.

## Consequences

- `MembershipRole`'s four values are correct and final for staff. No code
  changes; the divergence between schema and documentation is resolved in
  the documentation's favour being wrong.
- Four documents that listed Customer as an RBAC role are corrected:
  `PROJECT_CONTEXT.md` §5, `ARCHITECTURE.md` §3 and §8, `SECURITY.md` §4,
  and `ROADMAP.md` Phase 3.
- `ARCHITECTURE.md` §3's `/customer/*` experience zone is reframed as an
  unauthenticated visitor surface. It cannot be a logged-in portal.
- ADR-004 §8 and ADR-005 §2 gain pointers here, so a reader of either finds
  the boundary at the point they would otherwise be tempted to cross it.
- The login slice inherits one concrete requirement — the principal-type
  claim (§5) — and one reservation, the customer route namespace.
- The conversation and widget slices inherit binding constraints (§7, §8)
  before either is designed, which is the point of writing this now rather
  than discovering the conflict during Phase 7.
- Serviqo carries two identity systems permanently. That is a real ongoing
  cost — two credential formats, two verifiers, two rate-limit strategies,
  two audit trails — accepted because the alternative is one system that
  models neither principal honestly and leaks across the boundary between
  them.
