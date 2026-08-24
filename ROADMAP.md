# Serviqo Development Roadmap

Note that phases may be adjusted when technically justified. Each phase follows: Plan → Implement → Typecheck → Test → Run → Verify → Document → Commit.

## Phases

- ✅ **Phase 0: Repository + Architecture + Documentation**
  - Monorepo setup (web, server, shared packages)
  - Core architecture defined (Tech stack, Multi-tenant structure)
  - Foundational documentation (README, ROADMAP, SECURITY)
  - Initial configuration of linters and build tools

- ✅ **Phase 1: Landing page migration into React**
  - Migrated HTML/CSS prototype to componentized React (`apps/web`, Vite + TypeScript + Tailwind v4)
  - Design tokens ported to `apps/web/src/styles/tokens.css` and mapped onto Tailwind's theme
  - Verified responsive behavior at desktop/tablet/mobile against the approved reference
  - Routing deferred — Phase 1 ships a single marketing route with no router dependency yet

- 🟡 **Phase 2: Authentication + Organization onboarding** (substantially complete)
  - ✅ Database models: `User`, `Organization`, `Membership`, `Session`, `AccountToken`
  - ✅ Registration, email verification, and login
  - ✅ JWT access tokens with refresh-token rotation and reuse detection ([ADR-004](./docs/decisions/004-refresh-token-rotation-and-reuse-detection.md), [ADR-011](./docs/decisions/011-login-and-session-issuance.md), [ADR-012](./docs/decisions/012-refresh-token-rotation-endpoint.md))
  - ✅ Logout and logout-all ([ADR-013](./docs/decisions/013-logout-and-session-revocation.md), [ADR-014](./docs/decisions/014-logout-all-devices.md))
  - ✅ Access-token verification and `GET /api/v1/auth/me` ([ADR-015](./docs/decisions/015-access-token-verification-and-current-user.md))
  - ✅ Organization creation with its owner membership ([ADR-016](./docs/decisions/016-organization-onboarding-and-the-first-membership.md))
  - 🔲 Organization context on `/me`, and rate limiting (the [ADR-007 §13](./docs/decisions/007-registration-flow-and-account-enumeration.md) deployment gate)
  - ✅ Widget installation: staff-facing widget key, allowed-origin management, and key rotation ([ADR-020](./docs/decisions/020-widget-installation-configuration-surface.md))

- 🔲 **Phase 3: User / Team / Role management**
  - Implement RBAC (Owner, Admin, Supervisor, Agent) — organization users only (ADR-010)
  - Team creation and management
  - Invitation system for joining organizations
  - Profile management for users

- 🔲 **Phase 4: Customer chat experience**
  - Basic real-time chat interface for customers
  - Message sending and receiving capabilities
  - File attachment support in chat
  - Chat history loading

- 🔲 **Phase 5: Agent workspace**
  - Dashboard for agents to view assigned conversations
  - Multi-conversation handling UI
  - Customer profile and context panel
  - Internal notes for agents

- 🟡 **Phase 6: Persistent conversations / messages** (persistence/API complete; real-time deferred)
  - ✅ `Conversation` and `Message` models, one open conversation per customer enforced by a partial unique index ([ADR-022](./docs/decisions/022-persistent-conversations-and-messages.md))
  - ✅ `requireWidgetToken`: the customer-facing authentication and tenant boundary
  - ✅ `POST /api/v1/widget/conversations`, `POST`/`GET /api/v1/widget/conversations/:id/messages` — resolve-or-create, send, and cursor-paginated history
  - 🔲 Unread message counters — no consumer exists yet (no inbox, no read state)
  - 🔲 Archiving and closing conversations — `status` supports it; no route sets it yet
  - 🔲 Delivery of any kind — Phase 7 (Socket.IO) is what makes a sent message visible to anyone but its sender

- 🔲 **Phase 7: Socket.IO real-time communication**
  - Server-side Socket.IO configuration
  - Client-side socket connection management
  - Typing indicators and read receipts
  - Socket event handling and error recovery

- 🔲 **Phase 8: Redis presence / scaling / reliability**
  - Agent online/offline presence tracking
  - Socket.IO Redis adapter for multi-node scaling
  - Caching frequently accessed data
  - Message queues for heavy background jobs

- 🔲 **Phase 9: Ticketing / Departments / SLA**
  - Asynchronous ticketing system for offline support
  - Department routing for specialized queries
  - SLA (Service Level Agreement) tracking and alerts
  - Ticket escalation rules

- 🔲 **Phase 10: Automation engine**
  - Rule builder interface for admins
  - Trigger-condition-action logic execution
  - Automated message replies and tagging
  - Auto-assignment of conversations

- 🔲 **Phase 11: Knowledge base**
  - Article creation and management
  - Categorization and tagging
  - Customer-facing help center
  - Internal knowledge base for agents

- 🔲 **Phase 12: AI infrastructure / Provider abstraction**
  - Provider-agnostic AI service layer (OpenAI, Anthropic, etc.)
  - Secure management of API keys
  - Rate limiting and cost tracking for AI usage
  - Fallback mechanisms between providers

- 🔲 **Phase 13: RAG + Embeddings + Retrieval**
  - Vector database integration
  - Embedding generation for knowledge base articles
  - Semantic search capabilities
  - Document chunking and preprocessing pipeline

- 🔲 **Phase 14: Catalogue intelligence**
  - Ingestion of product/service catalogues
  - Entity extraction and matching
  - Structuring unstructured product data for AI context
  - Real-time stock or pricing lookups

- 🔲 **Phase 15: Autonomous AI Support Agent**
  - Fully automated customer interaction mode
  - Context-aware responses using RAG
  - Tool calling capabilities for specific tasks
  - Guardrails to prevent hallucination or sensitive actions

- 🔲 **Phase 16: Human-agent AI copilot**
  - Suggested responses for human agents
  - Automatic summarization of long threads
  - Tone adjustment and translation features
  - Contextual lookup from knowledge base

- 🔲 **Phase 17: AI → Human handoff**
  - Sentiment analysis to detect frustration
  - Seamless transfer of context to human agent
  - Handoff triggers based on complex queries
  - Status management during transition

- 🔲 **Phase 18: Admin experience**
  - Comprehensive dashboard for organization metrics
  - Billing and subscription management
  - System logs and audit trails access
  - Configuration of global settings

- 🔲 **Phase 19: Analytics**
  - Agent performance metrics (resolution time, CSAT)
  - AI deflection rate tracking
  - Conversation volume trends
  - Custom report generation

- 🔲 **Phase 20: Embeddable chat widget**
  - Lightweight, embeddable script for external websites
  - Customization options (colors, position, branding)
  - Cross-origin communication security
  - Analytics tracking within the widget

- 🔲 **Phase 21: Integrations / API / Webhooks**
  - Public API for external developers
  - Webhook delivery for real-time events
  - Pre-built integrations (Slack, CRM, email)
  - OAuth2 provider capabilities

- 🔲 **Phase 22: Security hardening**
  - Comprehensive penetration testing simulation
  - Advanced rate limiting and WAF configuration
  - Dependency vulnerability remediation
  - Security headers and CSP optimization

- 🔲 **Phase 23: Testing / Observability / Performance**
  - End-to-end testing suite (Playwright/Cypress)
  - Centralized logging and error tracking (Sentry/Datadog)
  - APM (Application Performance Monitoring)
  - Load testing and database query optimization

- 🔲 **Phase 24: Production deployment**
  - CI/CD pipeline finalization
  - Infrastructure as Code (Terraform) setup
  - Domain mapping and SSL certificates
  - Go-live and monitoring

## Design Assets (preserved)
- Landing page prototype (reference/landing/serviqo-landing.html)
- Design tokens (reference/landing/serviqo-tokens.css)
- Design direction v2 (reference/landing/serviqo-design-direction-v2.md)
