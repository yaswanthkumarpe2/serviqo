# ADR-002: Phase 2 Authentication & Backend Architecture

**Status:** Accepted
**Date:** 2026-08-03
**Phase:** 2 (pre-implementation — this ADR precedes any `apps/server` code)

## Context

Phase 1 shipped only the marketing frontend. Phase 2 introduces `apps/server`,
MongoDB, and the first tenant-owned data: `User`, `Organization`,
`Membership`, `Session`. Before writing implementation code, the backend
architecture, authentication design, and multi-tenant model were proposed
and reviewed. This ADR records the decisions as approved, including
amendments made during review, and supersedes any conflicting detail from
the informal proposal that preceded it.

## Decisions

### 1. Password hashing — Argon2id

Bcrypt, as originally named in `SECURITY.md`, is superseded by **Argon2id**
(`argon2` npm package). It is the current OWASP-recommended default —
memory-hard, resistant to GPU/ASIC cracking. Fallback: `bcryptjs` (pure JS,
no native binding) if `argon2`'s native build proves troublesome in a given
environment. `SECURITY.md` and `ARCHITECTURE.md` updated accordingly.

### 2. JWT library — jose

**`jose`** over `jsonwebtoken`: actively maintained, ESM/TypeScript-first
API. Used to sign and verify the short-lived access token.

### 3. Organization ownership — Membership is the single source of truth

`Organization.ownerUserId` is **removed** from the schema design.
"Who owns organization X" is answered exclusively by
`Membership.findOne({ organizationId, role: 'owner' })`. A **partial unique
index** on `Membership` — `{ organizationId: 1, role: 1 }` with
`partialFilterExpression: { role: 'owner' }`, unique — enforces exactly one
owner per organization at the database level.

*Rationale*: a denormalized `ownerUserId` pointer duplicates authority that
`Membership` already holds. Transferring ownership would then require two
coordinated writes (the pointer field, plus flipping two `Membership.role`
values) instead of one — exactly the drift risk this decision avoids. No
read-performance benefit survives scrutiny given the `{organizationId,
role}` index already planned for "list this org's admins"-style queries;
looking up the owner is the same indexed query with a different `role`
value.

### 4. Email — provider-abstracted, not vendor-coupled

An `EmailProvider` interface — `sendVerification()`, `sendPasswordReset()`,
`sendInvitation()` — sits between the auth/organization services and any
actual email vendor. A `ConsoleEmailProvider` (logs via Pino instead of
sending) is the Phase 2 development implementation. Real providers (Resend,
AWS SES, Postmark, SendGrid) become alternate implementations selected by
config once one is chosen — auth code never imports a vendor SDK directly.

### 5. API response envelope — standardized from the first endpoint

```
Success: { success: true,  data: {...}, meta:  { requestId, timestamp, version } }
Failure: { success: false, error: { code, message, requestId, timestamp, version } }
```

Supersedes the lighter `{ data }` / `{ error }` shape floated during initial
proposal. `version` is the API path version (`"v1"`). One envelope, used by
every endpoint from the start — no per-module bespoke shapes.

### 6. Domain events — hooks now, no bus yet

No message broker (BullMQ, Kafka, RabbitMQ) in Phase 2. Services call a
single `emitDomainEvent(event)` function at the point a real event occurs
(after successful registration, organization creation, membership change,
etc.). For now that function only structured-logs the event via Pino and
returns — backed by Node's built-in `events` module, zero new dependencies.
This means call sites and a typed event union (`UserRegistered`,
`OrganizationCreated`, `OrganizationJoined`, plus the future-phase events —
`ConversationCreated`, `TicketCreated`, `AIHumanHandoff`, etc.) exist now, so
introducing a real subscriber — or eventually a real broker — never requires
touching service code again.

### 7–19. Confirmed without change from the original proposal

- **AI/RAG/Catalogue**: not implemented, no SDKs installed. Architecture
  stays compatible via the same provider-abstraction pattern now used for
  email (§4) and already named for LLMs in `PROJECT_CONTEXT.md` §11.
- **Redis**: not introduced. Rate limiting and login lockout run on
  Mongo/in-memory state; authentication has no Redis dependency.
- **Socket.IO**: no realtime code inside the auth module; realtime is a
  later phase's concern entirely.
- **Database**: only `User`, `Organization`, `Membership`, `Session` exist
  in Phase 2. No `Conversation`, `Ticket`, `Knowledge`, `Automation`,
  `Analytics`, `AI`, or `Customer` schemas yet.
- **Multi-tenancy**: `User → Membership → Organization`. `organizationId`
  never lives directly on `User`.
- **RBAC**: permission-based, centralized via `can()` / `requirePermission()`
  — no scattered `if (role === 'admin')` checks.
- **Validation**: Zod, shared through `packages/validation`.
- **Logging**: Pino, structured only — no `console.log` in application code.
- **Testing (mandatory)**: registration, login, logout, refresh, **password
  reset**, organization creation, membership authorization, cross-tenant
  access denial, validation failures.
- **No premature complexity**: no microservices, GraphQL, CQRS, event
  sourcing, OAuth providers, WebSockets, or AI/RAG/Catalogue/Ticketing/
  Analytics until the roadmap reaches those phases. Serviqo stays a single
  modular monolith.

## Consequences

- `Organization` has one fewer field than the original proposal;
  org-ownership lookups go through the indexed `Membership` collection
  instead of a scalar pointer.
- Auth and organization services take an `EmailProvider` (and, later, an
  event-emit function) as an explicit dependency rather than a static
  import — marginally more constructor wiring, in exchange for zero vendor
  lock-in and a clean seam for the future event bus.
- The response envelope is a hard contract from the first endpoint written;
  every future domain module inherits it unchanged rather than each
  introducing its own shape.

## Implementation order (for reference, not part of this ADR's approval)

Server boot → DB connection → env validation → `User` model → `Organization`
model → `Membership` model → `Session` model → registration → login →
current user → refresh → logout → organization onboarding → authorization →
frontend authentication. Each step compiles, typechecks, lints, runs, is
tested, and is committed before the next begins.
