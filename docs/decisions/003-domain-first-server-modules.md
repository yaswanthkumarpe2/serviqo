# ADR-003: Domain-First Server Module Organization

**Status:** Accepted
**Date:** 2026-08-03
**Phase:** 2 (before the first persistence model)

## Context

`CONTRIBUTING.md` (written in Phase 0, before any backend code existed)
described a layer-first backend structure — top-level `controllers/`,
`services/`, `repositories/`, `models/` folders, each containing one file
per domain. The Phase 0 scaffold also created empty placeholder
directories for both patterns simultaneously (e.g. `controllers/` and
`auth/` as siblings), leaving the actual convention undecided. Before the
`User` persistence slice — the first real domain model — this had to be
resolved.

## Decision

Serviqo uses **domain-first** organization. Each business domain owns its
own implementation under `apps/server/src/modules/<domain>/`:

```
apps/server/src/
├── app.ts
├── main.ts
├── config/       — app configuration
├── database/     — MongoDB connection
├── lib/          — cross-cutting utilities (env, logger, errors, response, ids)
├── middleware/   — Express middleware
├── routes/       — route mounting
└── modules/
    ├── users/
    ├── auth/
    ├── organizations/
    ├── memberships/
    ├── sessions/
    └── ...        (customers, conversations, tickets, automation, etc. — later phases)
```

A domain module contains only the files its current implementation
genuinely needs (`user.model.ts`, `user.repository.ts`, ...) — not a
mandatory `model`/`repository`/`service`/`controller`/`validation`/`types`
template created upfront. A persistence-only slice gets a model and a
repository; a controller/service/route is added only when a route actually
exists.

Global layer folders (`controllers/`, `services/`, `repositories/`,
`models/`) are **not** used. Cross-cutting infrastructure (`config/`,
`database/`, `lib/`, `middleware/`, `routes/`) stays outside `modules/`
and is shared by every domain.

## Consequences

- The empty Phase 0 placeholder directories that don't fit this model —
  `controllers/`, `services/`, `repositories/`, `models/`, and the
  top-level domain folders sketched at the wrong nesting level (`auth/`,
  `organizations/`, `conversations/`, `tickets/`, etc., plus `events/`,
  `jobs/`, `sockets/`, `uploads/`, `utils/`, `validators/`) — were removed.
  None contained implementation; nothing was lost. They're recreated
  under `modules/<domain>/` exactly when a slice needs them.
- `CONTRIBUTING.md`'s backend file-organization section was rewritten to
  match.
- As more domains are added, `modules/` is where they go — this ADR is
  the reference for that convention going forward.
