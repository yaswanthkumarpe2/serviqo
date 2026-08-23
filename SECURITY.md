# Serviqo Security Architecture

This document outlines the security architecture and principles for Serviqo.

## 1. Security Philosophy
Security is architecture, not final polish. It is built into every layer of the Serviqo platform from day one. We operate on principles of defense in depth, least privilege, and secure by default.

## 2. Tenant Isolation
As a multi-tenant SaaS, isolation is paramount.
- `organizationId` is required on every resource and database model.
- Repository-layer enforcement ensures queries always filter by the requesting user's organization. **Implemented** for the first tenant-owned model: `customerRepository` takes `organizationId` as a mandatory argument on every read and write, and exposes no `findAll`, no unscoped `find`, and no `findByEmail` — so "fetch everything, then filter in memory" is not expressible against it rather than merely discouraged ([ADR-019](docs/decisions/019-customer-principal-and-widget-visitor-identity.md) §4). `Conversation` and `Ticket` inherit this pattern.
- Socket.IO rooms are strictly scoped to organizations.
- AI/RAG retrieval is logically separated so one tenant's data cannot answer another tenant's queries.
- File storage paths and access controls are scoped by tenant.
- Company A must never access Company B data under any circumstances.

## 3. Authentication
- Authentication applies to **organization users** only. Customers never authenticate into Serviqo — see [ADR-010](docs/decisions/010-principal-types-organization-users-and-customers.md).
- Serviqo now runs **two credential systems**, permanently and deliberately ([ADR-019](docs/decisions/019-customer-principal-and-widget-visitor-identity.md) §8). A staff access token and a widget visitor token are separated by two independent controls: **different signing secrets** (`JWT_ACCESS_SECRET` / `JWT_WIDGET_SECRET`) and **different audiences** (`serviqo-dashboard` / `serviqo-widget`). Either alone would be sufficient; both are enforced. The process **refuses to boot** if the two secrets are set to the same value, because that would silently reduce the separation to the audience claim alone.
- A widget token carries no email, name, role, or permission — it lives in a page Serviqo does not control, readable by any script on that page.
- Implementing short-lived access tokens (JWT).
- Secure refresh-token rotation to maintain sessions without permanent credentials.
- Password hashing using Argon2id (memory-hard, OWASP-recommended default).
- Strict rate limiting on all authentication-related endpoints to prevent brute-force attacks — **implemented** in six classes: the five in [ADR-018](docs/decisions/018-rate-limiting-and-security-headers.md) §3, plus `widgetSession` for the public customer endpoint ([ADR-019](docs/decisions/019-customer-principal-and-widget-visitor-identity.md) §11). Customer traffic is limited separately from staff traffic because it is high-volume, anonymous, and unauthenticated by design, so neither population can exhaust the other's budget.
  - **Deployment gate — PARTIALLY RELEASED.** ADR-007 §13's blanket prohibition is lifted for **single-node** deployments and restated for everything else. Read the table in §3a below before deploying.
- Robust session and device management, allowing users to view and revoke active sessions.
- Server-side session revocation capabilities.

## 3a. Deployment gate status

Rate limiting exists and is correct for a single process. Two prerequisites
remain, and both are about **where** the process runs rather than about the
policy.

| Deployment shape | Status | Why |
|---|---|---|
| Local development, one process | ✅ Released | Every request reaches the process holding the counters. |
| Single-node staging or production, no proxy | ✅ Released | Same. |
| **Any deployment behind a reverse proxy / load balancer** | ⛔ **Blocked** | `trust proxy` is off, so `req.ip` is the proxy's address and every client shares one bucket — a self-inflicted outage (ADR-018 §7). |
| **Multi-node (Phase 8 onward)** | ⛔ **Blocked** | Counters live in process memory, so N nodes grant N× the intended budget and a restart resets everything (ADR-018 §2). |

**Before deploying behind a proxy**, both of these must be done:

1. Set Express's `trust proxy` to the exact number of trusted hops, or to
   the proxy's address — **never `true`**, which trusts the whole chain and
   lets any client forge `X-Forwarded-For` to buy a fresh limit budget.
2. Verify `req.ip` reports the real client address, not the proxy's.

**Before going multi-node**, the limiter needs a shared store. The seam is
prepared: every limiter is built in `lib/rateLimit` and takes its store from
one place, so a Redis-backed store is a constructor argument rather than a
rewrite. Redis is deliberately not installed today (ADR-018 §1–2).

The limits themselves are documented with their justification in ADR-018 §3.
The credential class deliberately shares its numbers with the account
lockout policy in `config/constants.ts`; changing one without the other puts
them back into disagreement.

## 4. Authorization / RBAC
- A centralized permission system governs all actions.
- Defined organization-user roles: Owner, Admin, Supervisor, Agent. Customers hold no role and are authorized per-resource, not by RBAC (ADR-010).
- Authorization is checked on every API route AND every real-time socket event.
- UI elements are hidden based on roles, but security relies entirely on server-side validation, never on the client UI.

## 5. Input Validation
- All request bodies, query parameters, and URL parameters are validated server-side (e.g., using Zod).
- File uploads undergo rigorous validation including MIME type, file extension, and file size limits.
- Files are stored using generated, unpredictable UUID names, completely disregarding user-supplied filenames to prevent path traversal and other exploits.

## 6. API Security
- Global and route-specific rate limiting — **implemented** (§3, §3a).
- Secure HTTP headers — **implemented** via `helmet`, configured for a JSON API rather than for documents: `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, HSTS in production only, and `X-Powered-By` removed. See [ADR-018](docs/decisions/018-rate-limiting-and-security-headers.md) §9.
  - **CORS is still deliberately absent**, and ADR-019 §13 records why it could not land in the widget-identity slice as ADR-018 §9 expected. A cross-origin `POST` with a JSON content type triggers an `OPTIONS` preflight, and **a preflight carries no request body** — so it carries no `widgetKey`, so the server cannot resolve which tenant's origin list to answer with. Every fix is a decision about the widget's wire protocol, which belongs to the slice that builds the client.
  - What **did** ship is the enforcing half: a **per-tenant allowed-origin policy**, validated at configuration time and checked on every widget request before any customer is created (ADR-019 §10). Origins reject wildcards, non-http(s) schemes, and anything carrying a path, query, fragment, or userinfo. An empty list means **closed**, never "any origin". No `Access-Control-Allow-Origin` is sent in any value, `*` included.
  - The header policy above applies to **API responses**; the future embeddable widget serves an HTML document that must be framed by tenant sites, so it needs its own headers rather than inheriting `frame-ancestors 'none'`.
- Safe error responses: Stack traces and internal server details are never exposed to the client.
- Request IDs are generated for every request to enable secure, traceable logging without exposing sensitive data.

## 7. Data Security
- Passwords are only ever stored as salted hashes; they are never stored in plaintext or logged.
- Sensitive configuration and API keys are stored exclusively in environment variables or secure secret managers, never committed to code or sent to the frontend.
- Tokens (like password reset or email verification) are cryptographically secure, single-use, and expire quickly.

## 8. AI Security
- Provider API keys (OpenAI, Anthropic, etc.) are kept strictly server-side.
- The AI acts as an assistant or constrained agent; it cannot autonomously perform highly sensitive operations (e.g., issuing refunds, changing passwords, deleting accounts, processing payments).
- Implementation of prompt injection defenses and output sanitization.
- AI output is treated as untrusted and is never executed as an authorized system action without explicit, verified human-in-the-loop approval where necessary.

## 9. Audit Logging
- Critical actions are logged to provide a verifiable trail.
- Logged events include: Logins, role changes, agent invitations, conversation transfers, ticket status changes, automation rule modifications, AI configuration changes, and knowledge base updates.
- Audit logs are append-oriented and designed to be tamper-evident, preventing normal users or compromised accounts from modifying historical records.

## 10. Dependency Management
- Regular dependency audits are integrated into the CI/CD pipeline.
- We maintain a minimal dependency surface area to reduce potential supply chain vulnerabilities.

## 11. Current Status
**Important Note:** These are architectural principles and planned security measures, and most remain planned. No independent security audit or compliance certification (e.g., SOC2, ISO27001, HIPAA) is claimed or currently exists.

Implemented today: Argon2id password hashing, short-lived access tokens with refresh-token rotation and reuse detection, `HttpOnly`/`SameSite=Strict`/`Path`-scoped refresh cookies, server-side session revocation (single and all-device), bearer access-token verification with issuer/audience pinning, Zod request validation at the HTTP boundary, structured logging with request IDs, and safe error responses.

Also implemented: six-class rate limiting (§3, §3a), security response headers via `helmet` (§6), and RBAC enforcement through `requireOrganization` / `requirePermission` with per-request role resolution from the database (§4).

Also implemented (ADR-019): the `Customer` principal as a tenant-owned model with no credential of any kind, a public per-tenant `widgetKey` (256 bits of entropy, unique under a partial index so pre-existing organizations still write), a per-tenant allowed-origin policy that is closed by default, and stateless widget visitor tokens under their own secret and audience. The public `POST /api/v1/widget/session` endpoint is covered by its own rate-limiter class and answers every refusal — unknown key, suspended tenant, disallowed origin — with one opaque `403`, so it cannot be used to enumerate tenants.

Not yet implemented, and load-bearing for the sections above:
- **A shared rate-limit store and proxy configuration** (§3a) — the two remaining deployment blockers.
- **CORS response headers** (§6) — `cors` is not installed. The per-tenant allowed-origin **policy** is implemented and enforced; the `Access-Control-Allow-Origin` header is not sent, because a preflight cannot name the tenant (ADR-019 §13). No browser client exists to read it yet.
- **A staff surface for `widgetKey` and `allowedOrigins`** — nothing reads a tenant's widget key back to them and nothing lets them configure their origins, so the fields are inert until the widget-installation slice (ADR-019 §14). This is the sharpest limitation of the customer-identity slice.
- **Widget token revocation** — widget tokens are stateless and valid until they expire (24h). Nothing can shorten that. The authority at stake is one customer's own identity in one tenant, and this becomes reconsiderable when a token grants read access to message history (ADR-019 §14).
- **Audit logging** (§9), **file upload validation** (§5), and **AI security** (§8) — no implementation.
