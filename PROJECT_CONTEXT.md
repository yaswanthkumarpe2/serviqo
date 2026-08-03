# Serviqo: Project Context

This is the primary institutional memory and reference document for Serviqo. It provides all necessary context for any developer or AI coding agent to understand, build, and maintain the platform. **Do not modify this document lightly**, and always refer back to it to understand the platform's constraints and vision.

---

## 1. What is Serviqo
Serviqo is a production-oriented, multi-tenant, AI-powered real-time customer support SaaS platform. It connects customers, automation rules, AI models, human agents, and backend ticketing/operations into a single cohesive system. 
- It is **NOT** a simple chatbot.
- It is **NOT** a standard CRUD project.
- It is **NOT** a ChatGPT wrapper. 

It is an enterprise-grade customer support platform designed for high concurrency, real-time sync, strict tenant isolation, and intelligent workload routing.

## 2. Product Vision
The eventual capabilities of the Serviqo platform include:
- **Core Channels:** Live chat, embeddable widget, future omnichannel support.
- **Workspace:** Unified inbox for human agents with rich conversation history.
- **AI Capabilities:** Autonomous AI agent for low-risk support, Agent AI copilot for drafting and suggestions, RAG retrieval, Catalogue Intelligence.
- **Workforce Management:** Departments, teams, agent assignment, customer queues, SLA monitoring.
- **Ticketing & Operations:** Full ticket management integrated with chat, file attachments, internal notes, conversation transfer, escalation.
- **Knowledge & Intelligence:** Knowledge base, customer profiles, intent and sentiment detection, canned responses.
- **Platform Features:** Automation engine (rules & triggers), global search, notifications, CSAT surveys, robust analytics, admin controls, RBAC, audit logs.
- **Architecture:** Multi-tenant organization support, API/webhooks.

## 3. Technology Stack
- **Frontend:** React + TypeScript + Vite + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** MongoDB + Mongoose
- **Realtime:** Socket.IO
- **Cache/Presence/Queues:** Redis
- **Architecture:** Monorepo

## 4. Multi-Tenant Architecture
Every resource in Serviqo is scoped by an Organization ID. Tenant isolation is strictly enforced at the server-side repository layer. **Company A must NEVER access Company B data under any circumstances.** No database queries should be executed without explicitly verifying the organization context.

## 5. User Roles
Serviqo relies on Centralized Role-Based Access Control (RBAC) with permission-based authorization (e.g., `conversation.read`, `ticket.update`, `ai.configure`). The primary roles are:
- **Owner:** Full organizational control, billing, and destruction.
- **Admin:** System configuration, team management, and global settings.
- **Supervisor:** Department/team management, queue oversight, SLA monitoring.
- **Agent:** Standard operator handling conversations and tickets.
- **Customer:** End-user receiving support (external to the organization).
The architecture supports the addition of custom roles in the future.

## 6. Authentication Architecture
- **Features:** Registration, login, logout, email verification, forgot/reset password, refresh sessions, organization onboarding, agent invitations.
- **Security:** Short-lived access tokens, refresh-token rotation, secure HTTP-only cookies, robust password hashing, strict rate limiting.

## 7. Real-Time Chat Architecture
- **Transport:** Socket.IO handles the transport layer with strict authentication.
- **State Management:** Redis manages ephemeral state (presence, typing indicators, active sessions). MongoDB serves as the persistent source of truth.
- **Rooms:** Employs organization-level rooms and specific conversation rooms.
- **Features:** Real-time message delivery, read receipts, agent availability toggles, typing indicators.
- **Resilience:** Built to handle unexpected disconnections, seamless reconnections, missed-message sync, idempotency, duplicate message protection, and guaranteed ordering.

## 8. Message Types
- **Senders:** `CUSTOMER`, `HUMAN_AGENT`, `AI_AGENT`, `SYSTEM`, `AUTOMATION`.
- **Content Types:** `TEXT`, `IMAGE`, `FILE`, `PDF`, `VOICE`, `SYSTEM_EVENT`, `KNOWLEDGE_REFERENCE`.
- **Metadata Requirements:** Every message must track its sender, organization, conversation ID, timestamp, delivery/read state, attachments, and reply relationships (threading).
- **UI Constraint:** AI-generated messages must be visually distinct from human-generated messages.

## 9. AI Architecture
Serviqo employs a Dual-Mode AI architecture:
- **(A) Autonomous Support:** AI talks directly to customers but *only* for approved, low-risk scenarios (e.g., FAQs, knowledge base queries, basic troubleshooting, classification, routing, information collection).
- **(B) Agent Assistance:** AI acts as a copilot for human agents, providing suggested replies, summaries, intent/sentiment analysis, ticket classification, and KB recommendations. The human reviews and drafts—the AI does not auto-send in this mode.

## 10. AI Orchestration
**Not every message goes to the LLM.** The pipeline operates deterministically:
1. Customer Message Received
2. Fast Classification
3. Automation Check (Rules Engine)
4. Intent Detection
5. Context Gathering
6. RAG / Catalogue / Tool Selection
7. LLM Generation (where necessary)
8. Guardrail Checks
9. Confidence & Policy Evaluation
10. Final Action (Response OR immediate Human Handoff)

## 11. LLM Provider Abstraction
Serviqo is inherently provider-agnostic. The server-side interface abstractions (`generate()`, `stream()`, `embed()`, `toolCall()`) allow swapping between Anthropic, OpenAI, Google Gemini, Groq, or local models. API Keys reside strictly on the server side.

## 12. RAG / Knowledge System
- **Pipeline:** Document Upload → Parsing → Text Chunking → Embedding generation → Vector Storage → Retrieval → Reranking → Context Injection → LLM Prompting → Grounded Answer generation.
- **Sources:** FAQs, help articles, PDFs, organizational policies, and standard operating procedures.
- **Security:** Vector indexes and retrieved context are strictly tenant-isolated.

## 13. Catalogue Intelligence
Organizations can supply their product or service catalogues to Serviqo. The AI utilizes structured queries and explicit search tools to find real, live catalogue items. **The LLM must NOT invent or hallucinate products, features, or prices.** The AI uses this intelligence for requirements gathering, product comparison, and targeted recommendations.

## 14. AI Tool Calling
Server-side tools are available for the AI to execute operations:
- `searchKnowledge`
- `searchCatalogue`
- `getOrderStatus`
- `createTicket`
- `routeConversation`
- `collectCustomerDetails`
*Constraint:* The AI cannot autonomously execute high-risk operations (issue refunds, change passwords, delete accounts, process payments) without explicit human approval.

## 15. Human Handoff
A critical feature of the AI orchestration is graceful failure. 
- **Triggers:** Customer explicitly asks for a human, AI has low confidence, insufficient knowledge retrieved, issue unresolved after X turns, negative sentiment detected, sensitive operation required, or explicit policy/rule match.
- **Process:** Before handoff, the AI generates a private summary for the agent, identifies the core intent, and suggests the appropriate department or priority. The customer should *never* have to repeat themselves.

## 16. AI Safety / Guardrails
- Strictly prefer organization-approved information.
- Actively avoid making unsupported claims.
- Explicitly state uncertainty when confidence is low.
- Initiate human handoff when appropriate.
- Respect strict tenant data boundaries.
- **NEVER** expose hidden system prompts, chain-of-thought, or API secrets.
- Implement robust defenses against prompt injection attacks.

## 17. Automation Engine
The Automation Engine is **SEPARATE** from the AI system. It operates on a deterministic `TRIGGER → CONDITIONS → ACTIONS` model.
- *Examples:* 
  - `conversation.created` + `outside_business_hours` → send offline message.
  - `customer.message` + `intent == payment` → route to billing department.
  - `ai.confidence.low` → handoff to human agent.
This system operates independently from the LLM provider.

## 18. Ticketing
Tickets are heavily integrated with ongoing conversations.
- **Fields:** Ticket number, Organization ID, Customer ID, Conversation ID, Subject, Description, Status, Priority, Department, Assignee, Tags, SLA, Timestamps.
- **Statuses:** `OPEN`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `WAITING_INTERNAL`, `RESOLVED`, `CLOSED`.

## 19. SLA Engine
Server-side calculations govern Service Level Agreements (SLAs). Features include tracking First-response SLA, Resolution SLA, taking business hours into account, enforcing priority policies, setting warning thresholds, detecting breaches, and triggering escalations.

## 20. Approved Design System
**DO NOT REDESIGN THE PLATFORM.** 
- **Palette:** Canvas (`#F7F8F5`), Surface (`#FFFFFF`), Text (`#17211D`), Brand Emerald (`#14684A`).
- **Core Rules:**
  1. *One Green:* The emerald color is strictly reserved for primary actions, active navigation rails, presence indicators, and unread badges.
  2. *Fill vs. Outline:* Filled shapes represent human actions/status; Outlined shapes represent machine/AI actions.
  3. *Borders over Shadows:* Rely on crisp borders (`border-gray-200` etc.) to define hierarchy, not heavy drop shadows.
- **Typography:** Inter (product UI), Source Serif 4 (marketing/headlines), IBM Plex Mono (IDs, code, timers).
- **Vibe:** Warm neutrals, professional enterprise, high information density.

## 21. Repository Structure
The project uses a monorepo architecture:
- `apps/web/`: React frontend
- `apps/server/`: Node/Express backend
- `packages/ui/`: Shared design system components
- `packages/types/`: Shared TypeScript definitions
- `packages/config/`: ESLint, TSConfig, Prettier, etc.
- `packages/validation/`: Zod schemas shared between client and server
- `infrastructure/`: Docker, Terraform, deployment scripts
- `docs/`: Project documentation
- `reference/`: Preserved design reference files
- `scripts/`: Monorepo utility scripts
- `tests/`: End-to-end and integration testing

## 22. Security Principles
- Absolute Tenant Isolation.
- Robust Authentication & RBAC.
- Strict Request Validation (Zod).
- Rate Limiting.
- Secure Headers (Helmet) & CORS configuration.
- Safe File Uploads (size limits, mime-type validation).
- Secret Management (Environment variables only).
- Extensive Audit Logs.
- Session Security.
- Input Sanitization.
- Safe Error Responses (no stack traces in production).
- **Never trust frontend-supplied identifiers.**

## 23. Current State
**Phase 0 is complete.** 
Currently, **ONLY** design reference files exist (landing page prototype, design tokens, design direction document). 
- There is NO production React app.
- There is NO backend.
- There is NO database.
- There is NO Socket.IO implementation.
- There is NO Redis caching.
- There is NO AI or RAG infrastructure.
*All features described in the Vision are strictly PLANNED, not implemented.*

## 24. Development Phases
0. **Phase 0:** Repository Initialization & Design Reference Setup (COMPLETED)
1. **Phase 1:** Monorepo scaffolding, base configuration, CI/CD setup
2. **Phase 2:** Database schema design and MongoDB connection
3. **Phase 3:** Core backend authentication, RBAC, tenant isolation middleware
4. **Phase 4:** Frontend authentication flows (login, register, org setup)
5. **Phase 5:** Design system implementation (`packages/ui`)
6. **Phase 6:** Core messaging API (REST endpoints for conversations, messages)
7. **Phase 7:** Socket.IO infrastructure (rooms, connection handling, auth)
8. **Phase 8:** Redis integration (presence, typing indicators, active sessions)
9. **Phase 9:** Frontend workspace shell and inbox UI
10. **Phase 10:** Real-time messaging implementation (end-to-end)
11. **Phase 11:** Embeddable chat widget creation
12. **Phase 12:** LLM provider abstraction layer & basic completion API
13. **Phase 13:** RAG infrastructure (Vector DB, chunking, embeddings)
14. **Phase 14:** Knowledge base management UI & ingestion pipeline
15. **Phase 15:** Catalogue ingestion and structured search implementation
16. **Phase 16:** AI Orchestration pipeline (Intent, tools, guardrails)
17. **Phase 17:** AI Agent autonomous mode (customer-facing)
18. **Phase 18:** AI Copilot mode (agent-facing suggestions)
19. **Phase 19:** Human handoff mechanisms and summary generation
20. **Phase 20:** Deterministic Automation Engine (Triggers & Actions)
21. **Phase 21:** Ticketing system backend and UI
22. **Phase 22:** SLA Engine implementation
23. **Phase 23:** Analytics, Reporting, and Audit Logs
24. **Phase 24:** Production hardening, security audits, performance tuning

## 25. Development Rules
- **Process:** Plan → Implement → Typecheck → Test → Run → Verify → Document → Commit.
- **Honesty:** No fake functionality. No claiming features are working without verifying them first.
- **Versioning:** Git must be used for versioning.
- **Commits:** Meaningful, descriptive commit messages are mandatory. 
- **Standards:** Code must be type-safe (TypeScript), linted, and properly formatted before committing.
