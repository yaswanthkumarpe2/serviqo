import { InsufficientPermissionError } from "../lib/errors";
import { can } from "../modules/memberships/permissions";

import type { Permission } from "../modules/memberships/permissions";
import type { RequestHandler } from "express";

/**
 * Permission enforcement (ADR-017 §7).
 *
 * ADR-002 §7–19 fixed the shape: "permission-based, centralized via `can()` /
 * `requirePermission()` — no scattered `if (role === 'admin')` checks". A
 * route names the permission it needs:
 *
 *   router.get("/:organizationId", requireAccessToken, requireOrganization,
 *              requirePermission("organization.read"), handler)
 *
 * and never a role. That is what lets `ROLE_PERMISSIONS` change — or gain the
 * custom roles `PROJECT_CONTEXT.md` §5 anticipates — without auditing every
 * handler.
 */

/** One message for every refusal, so a role cannot be inferred from the text. */
const GENERIC_FAILURE_MESSAGE = "You do not have permission to perform this action";

/**
 * Refuses unless the caller's role in the active organization holds
 * `permission`.
 *
 * Must be mounted after `requireOrganization`, which is what establishes the
 * role — from the database, on this request (ADR-017 §5).
 *
 * Answers `403` specifically, unlike every other refusal in the auth surface
 * (ADR-017 §6). By the time this can run, membership has already been proved,
 * so the caller demonstrably knows the organization exists and works there.
 * Telling them their role is insufficient discloses nothing they did not
 * already know, and withholding it would only make the product confusing.
 *
 * The permission required is NOT named in the response. That is a fact about
 * Serviqo's authorization model rather than about this caller, and a client
 * that branches on it would be a client authorizing itself.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    /*
      `requireOrganization` must have run. Asserted rather than handled: a
      route that mounted this without it would be checking a permission
      against no tenant at all, and failing loudly is the only safe response.
    */
    const context = req.organizationContext;
    if (context === undefined) {
      next(new Error("requirePermission was mounted without requireOrganization"));
      return;
    }

    if (!can(context.role, permission)) {
      req.log.info(
        {
          event: "auth.permission.denied",
          userId: req.principal?.userId,
          organizationId: context.organizationId,
          role: context.role,
          // Safe in a log and not in a response: an operator needs to know
          // which check failed, a caller does not.
          permission,
        },
        "Request refused for want of a permission",
      );
      next(new InsufficientPermissionError(GENERIC_FAILURE_MESSAGE));
      return;
    }

    next();
  };
}
