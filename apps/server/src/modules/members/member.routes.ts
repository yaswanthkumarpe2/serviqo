import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { requireOrganization } from "../../middleware/requireOrganization";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody } from "../../middleware/validate";
import { createMemberController } from "./member.controller";
import { createMemberService } from "./member.service";
import { addMemberSchema, updateMemberRoleSchema, updateMemberStatusSchema } from "./member.validation";

import type { RateLimiters } from "../../lib/rateLimit";

/**
 * The team-management surface (ADR-027 §1) — the routes that finally enforce
 * `member.read` and `member.manage`.
 *
 * Every route mounts the full chain, in the order ADR-017 §8 fixed:
 *
 *   who is calling → bound them → which tenant and may they act in it →
 *   does their role hold this permission → is the input well-formed
 *
 * Each depends on the one before and throws loudly if mounted without it. The
 * middleware and the schema are visible in each route definition on purpose:
 * "is this route protected?", "which permission does it need?", and "does it
 * validate its input?" are all answered by reading this file.
 *
 * Its own router rather than routes added to `createOrganizationRouter`,
 * following ADR-025 §1's precedent: that module owns the tenant record and its
 * widget installation settings, and a roster is not organization
 * configuration. It is a different resource with a different permission pair.
 */
export interface MemberRouterDependencies {
  rateLimiters: RateLimiters;
}

export function createMemberRouter({ rateLimiters }: MemberRouterDependencies): Router {
  /*
    `mergeParams` so `:organizationId` — a segment of the MOUNT path, not of
    any route below — reaches `requireOrganization`, which reads it from
    `req.params` and consults no other source (ADR-017 §1). The same reason
    `createAgentInboxRouter` sets it.
  */
  const router = Router({ mergeParams: true });

  const controller = createMemberController({ memberService: createMemberService() });

  /*
    The roster. `member.read`, which `owner`, `admin`, and `supervisor` hold
    and `agent` does not — so an agent receives 403 here, safely, because
    `requireOrganization` already proved they work here (ADR-017 §6).

    The read class, keyed by the verified user, mounted BEFORE
    `requireOrganization` — ADR-018 §3's placement, so a caller cannot spend
    database lookups probing organization ids they hold no membership in.
  */
  router.get(
    "/",
    requireAccessToken,
    rateLimiters.authenticatedRead,
    requireOrganization,
    requirePermission("member.read"),
    controller.listMembers,
  );

  /*
    Adding a member — the one route in this slice behind its OWN rate limit
    class (ADR-027 §12).

    `memberInvite` rather than `authenticatedWrite`, because ADR-027 §5 accepts
    that this endpoint distinguishes "a verified Serviqo account exists for
    this email" from "it does not", and that disclosure needs a bound that is
    not shared with ordinary team admin. Twenty per hour, keyed by the verified
    user.

    Placed before `requireOrganization` for the same reason the read is: a
    caller must not be able to spend lookups probing tenants they hold no
    membership in.
  */
  router.post(
    "/",
    requireAccessToken,
    rateLimiters.memberInvite,
    requireOrganization,
    requirePermission("member.manage"),
    validateBody(addMemberSchema),
    controller.addMember,
  );

  /*
    `PATCH …/:membershipId/role` rather than `PATCH …/:membershipId` carrying
    `{ role }` — ADR-026 §2's shape, where the path IS the field being changed.

    Both writes need `member.manage` today, so a combined `PATCH` would be
    defensible. Keeping them separate means the next thing a membership can
    change — suspension, ownership transfer — arrives as its own route with its
    own permission rather than as a discriminator in a body doing authorization
    work, which is the "scattered `if (role === 'admin')` checks" shape
    ADR-002 §7–19 forbade.

    `authenticatedWrite`: a staff configuration write of exactly the shape that
    class was sized for. Not widened from inside a feature slice, consistent
    with ADR-025 §13 and ADR-026 §12 declining the same move.
  */
  router.patch(
    "/:membershipId/role",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("member.manage"),
    validateBody(updateMemberRoleSchema),
    controller.changeRole,
  );

  /*
    Suspension and reactivation (ADR-029 §1) — the route that finally gives
    `MembershipStatus` a writer, after two of its three values sat unwritable
    since ADR-010.

    ONE route rather than `/suspend` and `/reactivate`, and the test the
    comment above implies is the one that decides it: does the body value do
    AUTHORIZATION work? Here it does not — both directions need
    `member.manage` and nothing else, so `status` selects a TRANSITION rather
    than a permission. Two endpoints with one guard, one service, and one set
    of refusals is the duplication ADR-026 §7 refused when it declined a
    separate `/reopen`. Ownership transfer went the other way (ADR-028 §1)
    precisely because it needed a DIFFERENT permission.

    `authenticatedWrite`, the existing class (ADR-029 §11). No new class:
    `memberInvite` exists because adding a member discloses whether an account
    exists, and `ownershipTransfer` exists because it is the rarest and most
    destructive operation in the product. This is ordinary team administration
    of the same shape and frequency as the role change above, and it discloses
    nothing a caller holding `member.read` cannot already fetch.
  */
  router.patch(
    "/:membershipId/status",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("member.manage"),
    validateBody(updateMemberStatusSchema),
    controller.changeStatus,
  );

  /*
    Revocation. No `validateBody` — there is no body, and a schema for one
    would be a schema with nothing to strip.

    The target is the path segment and the tenant is the mount path, so this
    route cannot be aimed outside the organization the caller was proved into
    (ADR-027 §9).
  */
  router.delete(
    "/:membershipId",
    requireAccessToken,
    rateLimiters.authenticatedWrite,
    requireOrganization,
    requirePermission("member.manage"),
    controller.removeMember,
  );

  return router;
}
