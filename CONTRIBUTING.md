# Contributing to Serviqo

## Development Workflow

Every major phase follows this cycle:

```
PLAN → IMPLEMENT → TYPECHECK → TEST → RUN → VERIFY → DOCUMENT → COMMIT
```

Do not claim something works simply because code exists. Verify it.

## Git Conventions

### Branching

Use feature branches off `main`:

```
feat/auth-login
feat/chat-realtime
fix/socket-duplicate-messages
docs/architecture-update
```

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
chore: initialize Serviqo monorepo
docs: add architecture documentation
feat(auth): implement organization authentication
feat(chat): add realtime conversation transport
feat(ai): add support agent orchestration
fix(socket): prevent duplicate message delivery
refactor(inbox): extract conversation row component
test(rbac): add tenant isolation tests
```

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`

### Do NOT create

- `final2`, `latest`, `new`, `fixed`, `final-final` versions of files
- Git history provides versioning

## Code Quality

### TypeScript

- Use strict TypeScript throughout
- Shared types belong in `packages/types/`
- Do not use `any` without justification
- Export explicit interfaces for public APIs

### Architecture

- **Small modules** — each file has one clear responsibility
- **Layered backend** — Routes → Controllers → Services → Repositories → Models
- **No god files** — break up files over ~300 lines
- **No business logic in JSX** — extract to hooks or services
- **No database queries scattered everywhere** — use the repository pattern
- **No hardcoded secrets** — use environment variables
- **No duplicated types** — share through `packages/types/`

### Tenant Isolation

Every tenant-owned resource must be scoped by `organizationId`:

- Models must include `organizationId` field
- Repository methods must filter by `organizationId`
- Controllers must extract org context from authenticated request
- Socket rooms must be scoped by organization
- AI/RAG retrieval must filter by organization
- File storage must be scoped by organization

This is non-negotiable. Never rely only on frontend filtering.

### Security

- Never store plaintext passwords
- Never expose secrets to the frontend
- Never trust identifiers supplied by the frontend without server-side authorization
- Validate all request bodies server-side
- Use safe error responses (no stack traces in production)

### Testing

- Unit tests for business logic
- Integration tests for API endpoints
- Tenant-isolation tests (verify Company A cannot access Company B data)
- Socket.IO tests for real-time events
- RBAC tests for authorization

## Design System

The visual direction is approved. Do not redesign it.

### Rules

1. **One green** — Emerald (`#14684A`) appears only in: primary action, active rail, presence, unread
2. **Filled is human, outlined is machine** — AI content is visually distinct
3. **Borders, not shadows** — Shadows reserved for floating layers only

### Color Reference

| Token | Hex | Use |
|-------|-----|-----|
| `canvas` | `#F7F8F5` | Page/app background |
| `surface` | `#FFFFFF` | Cards, panels, inputs |
| `text` | `#17211D` | Primary text |
| `emerald-600` | `#14684A` | Primary actions |

### Typography

| Role | Family |
|------|--------|
| Product UI | Inter |
| Marketing headlines | Source Serif 4 |
| IDs / timers / mono | IBM Plex Mono |

### Component Rules

- Never hardcode hex values — use CSS variables / design tokens
- AI-originated content = outlined surface, 1px border, mono label. Never filled emerald.
- Human agent messages = filled treatment. Customer messages = neutral filled.
- System events = centered mono text with hairlines, no bubble.
- Priority "Low" = neutral, never green.

See `reference/landing/serviqo-design-direction-v2.md` for the complete specification.

## File Organization

### Frontend (`apps/web/src/`)

```
components/    — Reusable UI components
features/      — Feature-specific components and logic
hooks/         — Custom React hooks
layouts/       — Page layout components
pages/         — Route-level page components
routes/        — Route configuration
services/      — API client services
stores/        — Client state management
styles/        — Global styles and Tailwind config
types/         — Frontend-specific types
utils/         — Utility functions
```

### Backend (`apps/server/src/`)

```
config/        — App configuration
controllers/   — Request handlers
middleware/    — Express middleware
models/        — Mongoose schemas
repositories/  — Data access layer (tenant-scoped)
routes/        — Express route definitions
services/      — Business logic
sockets/       — Socket.IO event handlers
jobs/          — Background job processors
events/        — Event system
validators/    — Request validation schemas
utils/         — Utility functions
types/         — Backend-specific types
```

Domain modules (`auth/`, `organizations/`, `conversations/`, etc.) follow the same internal structure.

## Documentation

- Update `docs/` when making architectural changes
- Record significant decisions in `docs/decisions/` as ADRs
- Keep `ROADMAP.md` current as phases complete
- Verify `PROJECT_CONTEXT.md` remains accurate

## No Fake Functionality

Never fabricate:

- Customers or testimonials
- Usage numbers
- Security certifications
- Uptime guarantees
- Working integrations
- AI accuracy claims

Demo/sample data must clearly be labeled as demo/sample data.

Do not label features "Available" until they genuinely work end-to-end.
