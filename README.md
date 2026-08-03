# Serviqo

**Customer support, connected.**

Serviqo is a multi-tenant, AI-powered real-time customer support platform. It brings live chat, AI assistance, tickets and your support team into one organized workspace.

> **Status:** Early development — Phase 1 (landing page migration to React) complete. No backend, auth, or database exists yet. See [ROADMAP.md](./ROADMAP.md) for the development plan.

---

## What is Serviqo?

Serviqo connects customers with support teams through a professional workspace that combines:

- **Real-time live chat** — customers talk to AI and human agents in the same conversation
- **Autonomous AI support** — handles approved, low-risk queries directly (FAQs, KB lookups, basic troubleshooting)
- **Agent AI copilot** — helps human agents with summaries, suggested replies, intent detection, knowledge recommendations
- **Unified inbox** — all conversations from every channel in one queue, sorted by department, priority, and SLA
- **Ticket management** — auto-created from conversations, tracked with SLAs
- **Automation engine** — deterministic routing, greetings, and workflows (no LLM tokens)
- **Knowledge base** — articles that power both customer self-service and AI-suggested replies
- **Catalogue intelligence** — AI answers using real product/service data, never fabricated
- **Multi-tenant** — one installation serves many organizations with strict data isolation

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React · TypeScript · Vite · Tailwind CSS |
| Backend | Node.js · Express · TypeScript |
| Database | MongoDB · Mongoose |
| Real-time | Socket.IO |
| Cache / Queues | Redis |
| Monorepo | npm workspaces |

## Repository Structure

```
serviqo/
├── apps/
│   ├── web/          # React frontend (Vite)
│   └── server/       # Express backend
├── packages/
│   ├── ui/           # Shared design system
│   ├── types/        # Shared TypeScript types
│   ├── config/       # Shared configuration
│   └── validation/   # Shared validation schemas
├── infrastructure/   # Docker, Redis, database, deployment
├── docs/             # Architecture, API, decision records
├── reference/        # Preserved design reference files
├── scripts/          # Build and utility scripts
└── tests/            # Integration and E2E tests
```

## Getting Started

> **Note:** Only the marketing frontend (`apps/web`) is runnable so far. There is no backend yet — `dev:server` is a placeholder.

### Prerequisites

- Node.js ≥ 18
- MongoDB
- Redis
- Git

### Setup

```bash
git clone <repository-url>
cd serviqo
cp .env.example .env
# Fill in .env with your local configuration
npm install
```

### Development

```bash
# Start the frontend dev server (apps/web, Vite on :5173)
npm run dev:web

# Typecheck / lint every workspace
npm run typecheck
npm run lint

# Start the backend dev server (not implemented yet)
npm run dev:server
```

## Documentation

| Document | Description |
|----------|-------------|
| [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) | Complete project context — the institutional memory |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical architecture and system design |
| [ROADMAP.md](./ROADMAP.md) | Development phases and current progress |
| [SECURITY.md](./SECURITY.md) | Security architecture and principles |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development workflow and guidelines |

## Design System

The visual direction for Serviqo has been approved and is preserved in `reference/landing/`. Key design principles:

- **One green** — Emerald (`#14684A`) is the only chromatic color, used in exactly four roles
- **Filled is human, outlined is machine** — AI content is always visually distinct
- **Borders, not shadows** — Structure from hairlines and background steps

See [reference/landing/serviqo-design-direction-v2.md](./reference/landing/serviqo-design-direction-v2.md) for the full specification.

## Current State

| Aspect | Status |
|--------|--------|
| Repository structure | ✅ Established |
| Design reference files | ✅ Preserved |
| Documentation | ✅ Complete |
| React application | ✅ Landing page (Phase 1) |
| Express backend | 🔲 Not started |
| Authentication | 🔲 Not started |
| Database models | 🔲 Not started |
| Real-time messaging | 🔲 Not started |
| AI system | 🔲 Not started |

## License

Proprietary — All rights reserved.
