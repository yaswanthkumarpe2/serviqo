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
  - ✅ Sign-up traffic has its own rate-limit budgets — `/register`, `/verify-email` and `/resend-verification` no longer share the login class, which was refusing honest sign-ups while leaving a password guesser their full ten attempts ([ADR-031](./docs/decisions/031-credential-rate-limit-classes.md))
  - ✅ Widget installation: staff-facing widget key, allowed-origin management, and key rotation ([ADR-020](./docs/decisions/020-widget-installation-configuration-surface.md))

- 🟡 **Phase 3: User / Team / Role management** (RBAC, team management, role management, ownership transfer, the membership lifecycle and agent invitations complete; profile management deferred)
  - ✅ RBAC (Owner, Admin, Supervisor, Agent) — organization users only ([ADR-010](./docs/decisions/010-principal-types-organization-users-and-customers.md), [ADR-017](./docs/decisions/017-organization-context-and-rbac.md))
  - ✅ AGENT invitations — an admin adds an agent from the console, the account is
    created unverified with a generated password, and the emailed code must be
    redeemed before that password works
    ([ADR-034](./docs/decisions/034-customer-accounts-and-agent-invitations.md) §7)
  - ✅ Changing your own password — `POST /api/v1/auth/change-password`, which
    revokes every OTHER session and keeps the caller's
    ([ADR-034](./docs/decisions/034-customer-accounts-and-agent-invitations.md) §8)
  - ✅ Admins hold exactly one surface — an admin is a third `kind` and is neither
    a customer nor an agent, and the console carries the roster and conversations
    they would otherwise have needed the agent workspace for
    ([ADR-035](./docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §4, §5)
  - 🔲 Tenant-scoped invitations by a tenant's own admin (the console's are
    platform-scoped)
  - 🔲 Password reset, and customer/agent profile management
  - ✅ Team management — the organization member roster, adding a member, changing a
    member's role, and removing one, behind `member.read`/`member.manage`
    ([ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md))
  - ✅ `GET`/`POST`/`PATCH`/`DELETE /api/v1/organizations/:organizationId/members…` —
    the four member routes, tenant-scoped by membership id ([ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §1)
  - ✅ Removing a member releases their conversation assignments and broadcasts
    `conversation:updated`, closing [ADR-026](./docs/decisions/026-conversation-assignment-and-status.md) §15's
    stale-assignment limitation ([ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §10)
  - ✅ Team Management section in the dashboard — roster, role control, add-member
    form, confirmed removal, and permission-aware controls
    ([ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §16)
  - ✅ Ownership transfer — `POST /api/v1/organizations/:organizationId/ownership`
    behind the new owner-only `organization.transfer_ownership` permission, the
    first permission that separates `owner` from `admin`. The previous owner
    becomes `admin`; two guarded writes against index B's partial unique
    constraint make "exactly one owner" a database property rather than a
    comparison that races
    ([ADR-028](./docs/decisions/028-organization-ownership-transfer.md) §1, §2, §7, §8),
    closing [ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §7a's
    deferral. Runs without a transaction, so the ownerless failure window is
    stated rather than implied
    ([ADR-028](./docs/decisions/028-organization-ownership-transfer.md) §10)
  - ✅ Transfer-ownership control in the dashboard's Team section — owner-only,
    eligible-members picker, named confirmation, and a context refresh that
    takes the previous owner's owner-only controls away
    ([ADR-028](./docs/decisions/028-organization-ownership-transfer.md) §16)
  - ✅ Suspend / reactivate a membership — `PATCH /api/v1/organizations/:organizationId/members/:membershipId/status`
    behind `member.manage`, writing the `MembershipStatus` values that had no
    writer since ADR-010. Takes effect on the suspended member's very next
    request with the token they already hold, because `requireOrganization`
    re-reads the membership every time and nothing caches a status — this
    slice adds no gate, it gives the existing one something to refuse
    ([ADR-029](./docs/decisions/029-membership-suspension-and-reactivation.md) §1, §6, §8)
  - ✅ Suspension releases the member's conversations and closes their live
    agent sockets, through the domain-event seam's third instance and its
    first non-broadcast subscriber — which also closes the same live-socket
    revocation gap for [ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §10's
    removal path ([ADR-029](./docs/decisions/029-membership-suspension-and-reactivation.md) §9, §10)
  - ✅ Suspend / Reactivate controls in the dashboard's Team section —
    confirmed in the revoking direction only, and never offered for the owner
    ([ADR-029](./docs/decisions/029-membership-suspension-and-reactivation.md) §14)
  - 🔲 Invitation system for joining organizations — needs real email delivery
    ([ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §3)
  - 🔲 Profile management for users

- 🟡 **Phase 4: Customer chat experience** (signed-in customers can chat; the anonymous widget path is unchanged)
  - ✅ Customer ACCOUNTS — public registration creates a customer, not staff, and
    they land on a dashboard whose only job is talking to support
    ([ADR-034](./docs/decisions/034-customer-accounts-and-agent-invitations.md) §1, §6)
  - ✅ `/api/v1/me` — the customer's own conversations and messages, on a
    surface that can address no tenant at all ([ADR-034](./docs/decisions/034-customer-accounts-and-agent-invitations.md) §5)
  - 🟡 Live updates — the customer chat POLLS every three seconds and pauses
    when the tab is hidden. The socket authenticates customers with a widget
    token, which a signed-in customer does not hold; teaching the handshake a
    second credential is its own slice ([ADR-034](./docs/decisions/034-customer-accounts-and-agent-invitations.md) §6)
  - 🔲 Customer profile — a customer cannot change their own name, and their
    contact record does not follow later account edits
  - ✅ Basic real-time chat interface for customers
  - ✅ Message sending and receiving capabilities
  - ✅ Chat history loading
  - 🔲 File attachment support in chat

- 🟡 **Phase 5: Agent workspace** (inbox, assignment and lifecycle complete; context panel and notes deferred)
  - ✅ Agent Inbox in the dashboard — conversation list, message history,
    composer, live incoming messages and live agent replies, unread
    indication, and loading/empty/error/forbidden states ([ADR-025](./docs/decisions/025-agent-inbox-and-live-agent-replies.md))
  - ✅ The workspace is a **product shell** — a top bar with five destinations
    (Dashboard, My Chats, Contacts, Team, Settings) over one view at a time,
    opening on an overview of what is waiting rather than on a settings form.
    Every figure is derived from real conversations, and a count that is not a
    total says so ([ADR-033](./docs/decisions/033-workspace-shell.md))
  - ✅ Contacts — the people who have written in, derived from conversations
    because a `Customer` exists only because a visitor wrote in
    ([ADR-033](./docs/decisions/033-workspace-shell.md) §6)
  - 🔲 Per-organization metrics — the figures are counted client-side over one
    page of conversations, which is why they are labelled when partial. An
    aggregate endpoint would make them exact
    ([ADR-033](./docs/decisions/033-workspace-shell.md) §8)
  - ✅ `GET`/`POST /api/v1/organizations/:organizationId/conversations…` — the
    staff-facing surface, behind `conversation.read` / `conversation.reply`
  - ✅ Assignment and ownership — `assignedTo` on `Conversation`, claim and
    release behind `conversation.assign`, `?assignee=me|unassigned` queues,
    and live `conversation:updated` so one agent's claim reaches the others
    without a refresh ([ADR-026](./docs/decisions/026-conversation-assignment-and-status.md))
  - 🟡 Reassignment — an agent releases their own conversation; taking one
    from a colleague is refused for every role and needs its own permission
    and a notification design (ADR-026 §4, §15). Narrowed by
    [ADR-027](./docs/decisions/027-team-management-and-membership-lifecycle.md) §10:
    a colleague who has been removed from the organization no longer strands
    their queue — removal releases their assignments and broadcasts the change.
  - 🔲 Multi-conversation handling UI
  - 🔲 Customer profile and context panel
  - 🔲 Internal notes for agents

- 🟡 **Phase 6: Persistent conversations / messages** (persistence, API, delivery and archiving complete; persisted unread state deferred)
  - ✅ `Conversation` and `Message` models, one open conversation per customer enforced by a partial unique index ([ADR-022](./docs/decisions/022-persistent-conversations-and-messages.md))
  - ✅ `requireWidgetToken`: the customer-facing authentication and tenant boundary
  - ✅ `POST /api/v1/widget/conversations`, `POST`/`GET /api/v1/widget/conversations/:id/messages` — resolve-or-create, send, and cursor-paginated history
  - 🟡 Unread message counters — the inbox shows a session-local indicator
    (ADR-025 §12); nothing is persisted, because "read" for a conversation
    several agents share is read-receipt design
  - ✅ Archiving and closing conversations — `PATCH …/conversations/:id/status`
    behind `conversation.reply`, and `status` now has behaviour: a closed
    conversation refuses messages from BOTH the customer and the agent, and
    reopening is refused when the customer has since opened a newer one
    ([ADR-026](./docs/decisions/026-conversation-assignment-and-status.md) §6, §7)
  - ✅ Delivery — a message reaches the other party live in both directions,
    over the Socket.IO transport (ADR-023) and the domain event seam
    ([ADR-025](./docs/decisions/025-agent-inbox-and-live-agent-replies.md) §2)

- 🚧 **Phase 7: Socket.IO real-time communication**
  - ✅ Server-side Socket.IO configuration (attached to the existing HTTP server)
  - ✅ Widget-JWT handshake authentication; organization- and customer-scoped rooms
  - ✅ Conversation join, customer message send, real-time delivery, disconnect/reconnect
  - ✅ Socket rate limiting and safe (redacted) logging
  - ✅ Agent handshake authentication and one inbox room per organization —
    the staff access token verified with the same primitives
    `requireOrganization` uses, no second auth system ([ADR-025](./docs/decisions/025-agent-inbox-and-live-agent-replies.md) §8, §9)
  - ✅ Client-side socket connection management in the widget UI — message
    list, composer, history over REST, reconnect with re-join and cursor
    catch-up, and id-based duplicate suppression (ADR-024)
  - ✅ Broadcasting messages produced outside a socket handler — the message
    service publishes a `message.created` domain event and the socket server
    subscribes to it, so REST sends and agent replies both broadcast without
    the producer knowing Socket.IO exists ([ADR-025](./docs/decisions/025-agent-inbox-and-live-agent-replies.md) §2, closing ADR-023 §12)
  - 🔲 Typing indicators and read receipts

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

- 🟡 **Phase 18: Admin experience** (a read-only platform console exists; billing, audit trails and global settings untouched)
  - ✅ Platform admins as a second standing axis — `platformRole` on `User`, `requirePlatformAdmin` reading the grant from the database on every request, and `npm run grant:admin` as the only writer ([ADR-032](./docs/decisions/032-platform-admin-and-operations-console.md))
  - ✅ A private, unlisted operations console at `/control` — platform totals, account health, conversation volume, and tables of every tenant and account. Counts and administrative summaries only; no conversation content reaches it
  - 🟡 Comprehensive dashboard for organization metrics — platform-wide figures exist; **per-organization** metrics still have no aggregate endpoint, which is why the workspace's sample metrics were removed rather than made real ([ADR-032](./docs/decisions/032-platform-admin-and-operations-console.md) §15)
  - 🔲 Write actions on the platform surface (disable an account, suspend a tenant) — blocked behind a real audit trail, which does not exist
  - 🔲 Billing and subscription management
  - 🔲 System logs and audit trails access
  - 🔲 Configuration of global settings

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

- 🟡 **Phase 22: Security hardening** (session durability and the cookie notice done; the rest untouched)
  - ✅ Session endpoints keyed per SESSION rather than per IP, and a client that
    no longer discards a session over a transient refusal — together these were
    why reloading could sign somebody out
    ([ADR-035](./docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §1–3)
  - ✅ A cookie notice that states what is stored and claims nothing it cannot do
    ([ADR-035](./docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §6)
  - ✅ `SmtpEmailProvider` — send through your own SMTP server instead of a
    vendor's API. Read §7 first: this removes the VENDOR, not the
    deliverability problem, which is decided by IP reputation and
    SPF/DKIM/DMARC rather than by the sending software
    ([ADR-035](./docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §7)
  - 🔲 The rest of Phase 22:
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
