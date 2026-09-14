import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { createOrganizationController } from "./organization.controller";
import { replaceAllowedOriginsSchema } from "./organization.validation";
import { transferOwnershipSchema } from "./ownership.validation";
import { createOwnershipTransferService } from "./ownershipTransfer.service";
import { createWidgetSettingsService } from "./widgetSettings.service";

import type { RateLimiters } from "../../lib/rateLimit";

/**
 * A factory rather than a module-level Router, matching `auth.routes.ts` —
 * though this one takes no dependencies today. Kept as a factory anyway so
 * the mount site reads identically for both modules and so the first
 * injected dependency does not change the file's shape.
 *
 * The middleware and the schema are visible in the route definition on
 * purpose: "is this route protected?" and "does it validate its input?" are
 * both answered by reading this file.
 */
export interface OrganizationRouterDependencies {
  rateLimiters: RateLimiters;
}

export function createOrganizationRouter({ rateLimiters }: OrganizationRouterDependencies): Router {
  const router = Router();

  const controller = createOrganizationController({
    ownershipTransferService: createOwnershipTransferService(),
    widgetSettingsService: createWidgetSettingsService(),
  });

  /*
    There is no `POST /` any more (ADR-039 §1). Organisations are created by
    the super admin, together with their owner, at `POST /api/v1/admin/organizations`.
  */

  /*
    The first organization-scoped route, and the first consumer of both
    authorization middlewares (ADR-017 §8).

    The order is the contract: who is calling, then which tenant and may they
    act in it, then does their role hold this permission. Each depends on the
    one before and throws loudly if mounted without it — a silent
    unauthenticated pass would be the worst possible failure here.

    The tenant is a path segment, not a header or a body field. A URL cannot
    be addressed without it, so a route that needs tenant context cannot be
    reached without naming one (ADR-017 §1).
  */
  router.get(
    "/:organizationId",
    requireAccessToken,
    // Read class, keyed by the verified user. Placed before the tenant
    // resolution so a caller cannot spend database lookups probing
    // organization ids they have no membership in (ADR-018 §3).
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("organization.read"),
    controller.read,
  );

  /*
    Widget installation (ADR-020). All three sit behind `organization.manage`
    rather than `organization.read`: a role that may not change the widget
    configuration has no legitimate reason to read the live key either, since
    reading it is the first step toward installing or sharing it — exactly
    the action the permission gates.

    Nested under this router rather than given a new prefix: this is
    organization configuration, a sibling of `GET /:organizationId`, not a
    member of the public `/api/v1/widget/*` namespace ADR-019 §8 reserved for
    unauthenticated customer traffic.
  */
  router.get(
    "/:organizationId/widget-config",
    requireAccessToken,
    // Read class, keyed by the verified user, placed before tenant
    // resolution for the same reason `GET /:organizationId` does (ADR-018 §3).
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("organization.manage"),
    controller.getWidgetConfig,
  );

  router.put(
    "/:organizationId/widget-config/origins",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("organization.manage"),
    validateBody(replaceAllowedOriginsSchema),
    controller.updateAllowedOrigins,
  );

  router.post(
    "/:organizationId/widget-config/rotate-key",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("organization.manage"),
    controller.rotateWidgetKey,
  );

  /*
    Ownership transfer (ADR-028 §1) — the one route behind
    `organization.transfer_ownership`, the first permission in this codebase
    that `admin` does not hold.

    On THIS router rather than `createMemberRouter`, and the placement is
    argued in ADR-028 §1: the roster is a different resource and got its own
    router (ADR-025 §1), but ownership is a property of the TENANT. The
    question is "who owns this organization", the permission is an
    `organization.*` one, and the path names the resource being changed with no
    member segment in it — the same shape as
    `PUT /:organizationId/widget-config/origins` above, where the path names
    the thing being set and the body carries the value.

    The full chain, in ADR-017 §8's fixed order: who is calling → bound them →
    which tenant and may they act in it → does their role hold this permission
    → is the input well-formed. An admin, supervisor, or agent is refused by
    `requirePermission` with the existing generic 403; someone with no
    membership here never gets that far, because `requireOrganization` answers
    404 first (ADR-028 §3).

    `rateLimiters.ownershipTransfer` rather than `authenticatedWrite`
    (ADR-028 §11): five per hour, keyed by the verified user, so the most
    destructive operation in the product does not share a budget with ordinary
    configuration writes and a run of attempts is visible as itself. Placed
    BEFORE `requireOrganization` for the reason every other class is
    (ADR-018 §3) — a caller must not be able to spend database lookups probing
    tenants they hold no membership in.

    `validateBody` last, so `{ membershipId }` is proved well-formed and every
    other key — `organizationId`, `currentOwnerId`, `role` — is STRIPPED before
    the handler runs (ADR-028 §4).
  */
  router.post(
    "/:organizationId/ownership",
    requireAccessToken,
    rateLimiters.ownershipTransfer,
    requireOrganization,
    requirePermission("organization.transfer_ownership"),
    validateBody(transferOwnershipSchema),
    controller.transferOwnership,
  );

  return router;
}
