import { Router } from "express";

import { createAgentInboxRouter } from "../modules/agentInbox/agentInbox.routes";
import { createAuthRouter } from "../modules/auth/auth.routes";
import { createMemberRouter } from "../modules/members/member.routes";
import { createCustomerPortalRouter } from "../modules/customerPortal/customerPortal.routes";
import { createOrganizationRouter } from "../modules/organizations/organization.routes";
import { createPlatformAdminRouter } from "../modules/platformAdmin/platformAdmin.routes";
import { createWidgetRouter } from "../modules/widget/widget.routes";

import type { EmailProvider } from "../lib/email/emailProvider";
import type { RateLimiters } from "../lib/rateLimit";

export interface ApiRouterDependencies {
  emailProvider: EmailProvider;
  rateLimiters: RateLimiters;
}

/**
 * Mounts every versioned API module under a single prefix, so `app.ts` stays
 * concerned with application-level middleware and one router mount rather
 * than accumulating a path per domain.
 *
 * `/health` deliberately stays outside this router, unversioned: a liveness
 * probe is infrastructure, not part of the API contract clients program
 * against. It is also outside the global rate limiter below — an
 * orchestrator's health check must not be able to exhaust a budget, and it
 * reads no data.
 */
export function createApiRouter({ emailProvider, rateLimiters }: ApiRouterDependencies): Router {
  const router = Router();

  /*
    The blunt per-IP volume bound, applied before any route matches
    (ADR-018 §3).

    It exists for what the specific classes cannot see: a request refused by
    `requireAccessToken` never reaches the user-keyed limiters, so hammering
    an authenticated route with no token would otherwise be unlimited. Set
    high enough that a specific class always fires first for honest traffic.
  */
  router.use("/api/v1", rateLimiters.global);

  router.use("/api/v1/auth", createAuthRouter({ emailProvider, rateLimiters }));
  /*
    Its own prefix, not a sub-path of /auth. The auth prefix is permanently
    organization-user authentication (ADR-010 §5); an organization is a
    tenant resource, and mounting its routes under the credential namespace
    would blur a boundary that later has to hold against customer traffic.
  */
  router.use("/api/v1/organizations", createOrganizationRouter({ rateLimiters }));
  /*
    The agent inbox (ADR-025 §3), nested under the organization prefix so the
    tenant is a path segment `requireOrganization` can read — the boundary
    ADR-017 §1 made structural: a URL cannot be addressed without naming a
    tenant.

    Its own router rather than routes added to `createOrganizationRouter`:
    that module owns the tenant record and its widget installation settings,
    and conversations are not organization configuration (ADR-025 §1).

    Mounted AFTER the organizations router. Express matches in mount order and
    these paths are strictly longer, so neither shadows the other — but the
    order also keeps the more specific surface reading as an extension of the
    general one rather than as an interception of it.
  */
  router.use("/api/v1/organizations/:organizationId/conversations", createAgentInboxRouter({ rateLimiters }));
  /*
    The team-management surface (ADR-027 §1), nested under the organization
    prefix for the same reason the inbox is: the tenant becomes a path segment
    `requireOrganization` can read, so a member route cannot be addressed
    without naming one (ADR-017 §1).

    Its own router rather than routes on `createOrganizationRouter`, following
    ADR-025 §1's precedent — that module owns the tenant record and its widget
    installation settings, and the roster is a different resource behind a
    different permission pair.

    Mounted after the organizations router and beside the conversations one.
    Express matches in mount order and all three path sets are disjoint, so
    none shadows another.
  */
  router.use("/api/v1/organizations/:organizationId/members", createMemberRouter({ rateLimiters }));
  /*
    The signed-in customer's surface (ADR-034 §5).

    The only prefix here that names neither a tenant nor a resource: a
    customer's organization, conversations and messages are all derived from
    their token, so there is nothing for them to address. That is what makes a
    cross-tenant request unexpressible from this surface rather than merely
    refused.
  */
  router.use("/api/v1/me", createCustomerPortalRouter({ rateLimiters }));
  /*
    The platform operations surface (ADR-032 §3).

    Its own top-level prefix, deliberately NOT nested under an organization.
    Every other authenticated route in this API names a tenant in its path,
    because ADR-017 §1 made "a URL cannot be addressed without naming a
    tenant" structural. These routes are the exception that proves it: they
    read ACROSS tenants, and a path segment for one would be a lie.

    Naming them `/admin` rather than something unguessable is on purpose. The
    portal that consumes this is unlisted — no link points at it — but that is
    a product decision about discoverability, never a security control, and a
    secret URL that protects nothing is worse than a plain one because it
    invites the belief that it does. What protects these routes is
    `requirePlatformAdmin` on every one of them.
  */
  router.use("/api/v1/admin", createPlatformAdminRouter({ rateLimiters, emailProvider }));
  /*
    The customer-facing namespace ADR-010 §5 reserved: "Customer traffic never
    appears under `/api/v1/auth`." Its own prefix, so the boundary between the
    two principal types is visible in the URL a request arrives on, and so
    neither namespace can acquire the other's middleware by being nested
    inside it.

    The staff refresh cookie is `Path`-scoped to `/api/v1/auth`
    (`REFRESH_COOKIE_PATH`), which means a browser will never attach it to a
    request under this prefix — a structural guarantee ADR-010 §8 asked for
    and this mount point preserves.
  */
  router.use("/api/v1/widget", createWidgetRouter({ rateLimiters }));

  return router;
}
