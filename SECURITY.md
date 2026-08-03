# Serviqo Security Architecture

This document outlines the security architecture and principles for Serviqo.

## 1. Security Philosophy
Security is architecture, not final polish. It is built into every layer of the Serviqo platform from day one. We operate on principles of defense in depth, least privilege, and secure by default.

## 2. Tenant Isolation
As a multi-tenant SaaS, isolation is paramount.
- `organizationId` is required on every resource and database model.
- Repository-layer enforcement ensures queries always filter by the requesting user's organization.
- Socket.IO rooms are strictly scoped to organizations.
- AI/RAG retrieval is logically separated so one tenant's data cannot answer another tenant's queries.
- File storage paths and access controls are scoped by tenant.
- Company A must never access Company B data under any circumstances.

## 3. Authentication
- Implementing short-lived access tokens (JWT).
- Secure refresh-token rotation to maintain sessions without permanent credentials.
- Password hashing using Argon2id (memory-hard, OWASP-recommended default).
- Strict rate limiting on all authentication-related endpoints to prevent brute-force attacks.
- Robust session and device management, allowing users to view and revoke active sessions.
- Server-side session revocation capabilities.

## 4. Authorization / RBAC
- A centralized permission system governs all actions.
- Defined roles: Owner, Admin, Supervisor, Agent, Customer.
- Authorization is checked on every API route AND every real-time socket event.
- UI elements are hidden based on roles, but security relies entirely on server-side validation, never on the client UI.

## 5. Input Validation
- All request bodies, query parameters, and URL parameters are validated server-side (e.g., using Zod).
- File uploads undergo rigorous validation including MIME type, file extension, and file size limits.
- Files are stored using generated, unpredictable UUID names, completely disregarding user-supplied filenames to prevent path traversal and other exploits.

## 6. API Security
- Global and route-specific rate limiting.
- Implementation of secure HTTP headers (CORS, CSP, X-Frame-Options, Strict-Transport-Security, X-Content-Type-Options).
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
**Important Note:** These are architectural principles and planned security measures. The platform is currently in early development (Phase 0). No independent security audit or compliance certification (e.g., SOC2, ISO27001, HIPAA) is claimed or currently exists.
