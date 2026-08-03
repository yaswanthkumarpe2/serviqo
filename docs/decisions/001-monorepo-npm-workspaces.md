# ADR-001: Monorepo with npm Workspaces

**Status:** Accepted  
**Date:** 2026-08-03  
**Phase:** 0

## Context

Serviqo requires a frontend (React), backend (Express), shared UI library, shared types, and shared validation. These packages need to share code and be developed together.

## Decision

Use a **monorepo** structure with **npm workspaces** for package management.

```
serviqo/
├── apps/web/        # React frontend
├── apps/server/     # Express backend
├── packages/ui/     # Shared design system
├── packages/types/  # Shared TypeScript types
├── packages/config/ # Shared configuration
└── packages/validation/ # Shared validation
```

## Rationale

- **Shared types** — Frontend and backend use the same TypeScript interfaces for messages, tickets, users, etc., eliminating drift
- **Shared validation** — Request schemas defined once, used on both client and server
- **Design system** — UI components and tokens shared between marketing and product experiences
- **Atomic changes** — A single commit can update a type definition, the API endpoint, and the frontend consumer simultaneously
- **npm workspaces** chosen over Lerna/Nx/Turborepo to minimize tooling complexity at this stage; can migrate later if build performance requires it

## Consequences

- All packages must use compatible TypeScript and Node.js versions
- Root `package.json` manages workspace orchestration
- CI must build packages in dependency order
- Each app maintains its own `tsconfig.json` extending a shared base if needed
