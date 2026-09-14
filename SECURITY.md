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
- Authentication now applies to **three kinds of account**, and which one you are is `User.kind` plus `platformRole` ([ADR-034](docs/decisions/034-customer-accounts-and-agent-invitations.md) §1): a **customer** who talks to support, an **agent** who answers, and a platform **admin**. ADR-010 §5's "customers never authenticate" is amended by ADR-034 §2 and nothing else about it changed — a customer with an account still holds **no membership**, can address **no organization**, and sees only their own conversations. The widget remains the anonymous path.
- **Agents cannot self-register.** Public registration writes `kind: "customer"` and has no parameter that could write anything else; the only writer of `"agent"` is the admin-only invitation endpoint. So the set of people who can read a tenant's conversations is exactly the set an admin put there ([ADR-034](docs/decisions/034-customer-accounts-and-agent-invitations.md) §7).
- **A platform admin is a third `kind` and is neither a customer nor an agent** ([ADR-035](docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §4). One account holds one staff surface, so "who answers conversations here" has one answer. The admin console shows a tenant's roster and conversations only where the admin holds an `owner` **membership** in that tenant — authorized by `requireOrganization`/`requirePermission` like any other owner. The platform API itself still carries no conversation content (§5).
- An invited agent is created **unverified**, with a generated password delivered once and stored nowhere but as an Argon2id hash. The emailed code must be redeemed before that password works — an admin typing an address is not evidence anybody reads it.
- Serviqo now runs **two credential systems**, permanently and deliberately ([ADR-019](docs/decisions/019-customer-principal-and-widget-visitor-identity.md) §8). A staff access token and a widget visitor token are separated by two independent controls: **different signing secrets** (`JWT_ACCESS_SECRET` / `JWT_WIDGET_SECRET`) and **different audiences** (`serviqo-dashboard` / `serviqo-widget`). Either alone would be sufficient; both are enforced. The process **refuses to boot** if the two secrets are set to the same value, because that would silently reduce the separation to the audience claim alone.
- A widget token carries no email, name, role, or permission — it lives in a page Serviqo does not control, readable by any script on that page.
- Implementing short-lived access tokens (JWT).
- Secure refresh-token rotation to maintain sessions without permanent credentials.
- Password hashing using Argon2id (memory-hard, OWASP-recommended default).
- Strict rate limiting on all authentication-related endpoints to prevent brute-force attacks — **implemented** in thirteen classes, grown from the five in [ADR-018](docs/decisions/018-rate-limiting-and-security-headers.md) §3 as each new surface argued for its own bound: `widgetSession` for the public customer endpoint ([ADR-019](docs/decisions/019-customer-principal-and-widget-visitor-identity.md) §11), `widgetConversationRead`/`widgetConversationWrite` for customer conversation traffic ([ADR-022](docs/decisions/022-persistent-conversations-and-messages.md) §12), `memberInvite` ([ADR-027](docs/decisions/027-team-management-and-membership-lifecycle.md) §12), `ownershipTransfer` ([ADR-028](docs/decisions/028-organization-ownership-transfer.md) §11), and `registration`/`emailVerification`/`verificationResend` ([ADR-031](docs/decisions/031-credential-rate-limit-classes.md)). Customer traffic is limited separately from staff traffic because it is high-volume, anonymous, and unauthenticated by design, so neither population can exhaust the other's budget.
  - **The sign-up endpoints no longer share the login budget** (ADR-031). They did until then, and the shared counter refused honest users: one sign-up costs a register call, a verify call and often a resend, so a person doing nothing wrong spent three to five of the ten attempts that budget was sized to allow a password guesser. `/register` is now 5/hour, `/verify-email` 20/15min, and `/resend-verification` 3/15min — the last deliberately the tightest class in the product, because it is the only endpoint whose accepted calls put mail in an inbox the caller names.
  - **Deployment gate — PARTIALLY RELEASED.** ADR-007 §13's blanket prohibition is lifted for **single-node** deployments and restated for everything else. Read the table in §3a below before deploying.
- **Session endpoints are rate-limited per SESSION, not per IP** ([ADR-035](docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §2). The key is the non-secret session id the refresh cookie carries — never the secret, which as a limiter key would sit in memory in plaintext. The IP remains the fallback for a caller presenting no cookie, and the `global` per-IP class is unchanged, so the bound against an attacker is not weakened; what changed is that one browser can no longer exhaust the budget of everyone behind its address.
- **A refusal that is not a 401 no longer ends a session.** The client used to clear its session on any failed refresh, so a rate-limited or briefly failing request discarded a cookie the server would have honoured ([ADR-035](docs/decisions/035-session-durability-admin-separation-and-owned-mail.md) §3).
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
| **Multi-node revocation of live sockets** | ⛔ **Blocked** | Suspending or removing a member closes their open agent sockets in THIS process only. With N nodes, connections held elsewhere survive until their next request or reconnect, both of which are gated (ADR-029 §9, §16). Closed by the Redis adapter's cross-node disconnect, which is Phase 8's. |

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

### Standalone `mongod`: one multi-document operation has a stated window

A third single-node gate, of a different kind — it is about **durability
guarantees** rather than about request routing.

MongoDB transactions require a replica set. Development runs a standalone
`mongod` and the suites use `MongoMemoryServer` (ADR-016 §3), so no code path
in Serviqo opens a transaction and none should be added until the deployment
provides one.

| Operation | Status | Why |
|---|---|---|
| Every write except one | ✅ Released | Single-document, therefore atomic in MongoDB, or compensable without exposing a broken invariant (ADR-016 §4). |
| **Ownership transfer** (`POST /organizations/:id/ownership`) | 🟡 **Released with a stated window** | Two documents must change together. Index B forbids a second owner, so every legal ordering passes through a moment with zero owners (ADR-028 §8a). |

What that window is, and is not:

- It lasts **one database round-trip**, between the demote and the promote.
- Both writes are **guarded on the role they expect to find**, so concurrent
  transfers cannot both win and cannot produce two owners — index B makes
  two owners impossible regardless.
- A failed promotion **compensates**, restoring the previous owner.
- If the process dies inside the window, the organization is left with no
  owner. Every membership survives and the previous owner retains `admin`, so
  the tenant stays fully administrable; the single lost capability is
  transferring ownership again. This is **not** ADR-016 §3's unrecoverable
  orphan.
- Recovery is operator-side. **No self-service adoption path exists or should
  be added** — "let an authenticated user claim an ownerless organization" is
  an account-takeover primitive (ADR-016 §3).
- `organization.ownership_transfer_compensation_failed` is the log line to
  alert on; it is the only signal that the window was entered and not closed.

**Before relying on ownership transfer under load or in production**, run
MongoDB as a replica set and wrap the two writes in a transaction. That is a
deployment change plus a small service change, and ADR-028 §10 records exactly
which two writes it applies to.

## 4. Authorization / RBAC
- A centralized permission system governs all actions.
- Defined organization-user roles: Owner, Admin, Supervisor, Agent. Customers hold no role and are authorized per-resource, not by RBAC (ADR-010).
- Authorization is checked on every API route AND every real-time socket event.
- UI elements are hidden based on roles, but security relies entirely on server-side validation, never on the client UI.
- **A second, independent axis: `platformRole`** ([ADR-032](docs/decisions/032-platform-admin-and-operations-console.md)). `MembershipRole` says what someone may do inside one tenant; `platformRole` (`none` | `admin`) says whether they operate Serviqo itself. The two never substitute for one another — an organization **owner** is the most powerful principal inside their own tenant and holds no platform standing whatsoever — which is why it lives on `User` rather than becoming a fifth `MembershipRole`.
  - Enforced by `requirePlatformAdmin`, which reads the grant from the database on **every** request rather than from a token claim, so revoking the most powerful role in the system takes effect on the holder's next request rather than at token expiry.
  - **Nothing in the product can write it.** Registration cannot set it, no endpoint updates it, and no amount of organization ownership confers it. The only writer is `npm run grant:admin --workspace=apps/server`, which requires database credentials and refuses to run under `NODE_ENV=production`.
  - The platform API (`/api/v1/admin`) is **read-only and returns counts and administrative summaries only** — no message bodies and no customer identities. It is also the **only unscoped read in the codebase**, confined to one repository (`platformAdmin.repository.ts`) whose header says so, so a tenant-isolation review has exactly one place to look beyond the scoped repositories.

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

Also implemented: thirteen-class rate limiting (§3, §3a), security response headers via `helmet` (§6), and RBAC enforcement through `requireOrganization` / `requirePermission` with per-request role resolution from the database (§4).

Also implemented (ADR-032): the `platformRole` axis and the `requirePlatformAdmin` boundary described in §4, behind a read-only operations API. The console that consumes it is unlisted — nothing in the product links to `/control` — but that is a product decision about discoverability and **not** a security control, and is recorded as such so nobody later mistakes the address for protection. There is **no audit log** for the platform surface; reads go through the ordinary request logger, and a real audit trail is a prerequisite for any write endpoint ever being added there.

Also implemented (ADR-019): the `Customer` principal as a tenant-owned model with no credential of any kind, a public per-tenant `widgetKey` (256 bits of entropy, unique under a partial index so pre-existing organizations still write), a per-tenant allowed-origin policy that is closed by default, and stateless widget visitor tokens under their own secret and audience. The public `POST /api/v1/widget/session` endpoint is covered by its own rate-limiter class and answers every refusal — unknown key, suspended tenant, disallowed origin — with one opaque `403`, so it cannot be used to enumerate tenants.

Not yet implemented, and load-bearing for the sections above:
- **A shared rate-limit store and proxy configuration** (§3a) — the two remaining deployment blockers.
- **CORS response headers** (§6) — `cors` is not installed. The per-tenant allowed-origin **policy** is implemented and enforced; the `Access-Control-Allow-Origin` header is not sent, because a preflight cannot name the tenant (ADR-019 §13). No browser client exists to read it yet.
- **A staff surface for `widgetKey` and `allowedOrigins`** — nothing reads a tenant's widget key back to them and nothing lets them configure their origins, so the fields are inert until the widget-installation slice (ADR-019 §14). This is the sharpest limitation of the customer-identity slice.
- **Widget token revocation** — widget tokens are stateless and valid until they expire (24h). Nothing can shorten that. The authority at stake is one customer's own identity in one tenant, and this becomes reconsiderable when a token grants read access to message history (ADR-019 §14).
- **Audit logging** (§9), **file upload validation** (§5), and **AI security** (§8) — no implementation.
