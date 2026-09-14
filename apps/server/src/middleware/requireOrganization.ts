import { OrganizationNotAccessibleError } from "../lib/errors";
import { membershipRepository } from "../modules/memberships/membership.repository";
import { organizationRepository } from "../modules/organizations/organization.repository";
import { userRepository } from "../modules/users/user.repository";

import type { RequestHandler } from "express";

/**
 * Serviqo's authorization boundary (ADR-017).
 *
 * `requireAccessToken` answers "who is calling". This answers "which tenant,
 * and may they act in it" — the question every organization-scoped staff
 * route asks first.
 *
 * A route declares it by mounting the pair in order:
 *
 *   router.get("/:organizationId", requireAccessToken, requireOrganization, handler)
 *
 * so both questions are answered by reading the route file, the same way
 * `validateBody` answers "does this route validate its input?".
 */

/**
 * A 24-character hex ObjectId — the same guard `refreshToken.ts` and
 * `accessToken.ts` apply, for the same reason: `findOne` raises a `CastError`
 * on a malformed value, and a `CastError` reaching `errorHandler` becomes a
 * generic 500, reporting a client's mistyped URL as a server fault
 * (ADR-017 §1).
 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** One message for every refusal, so no branch is distinguishable by its text. */
const GENERIC_FAILURE_MESSAGE = "Organization not found";

/**
 * Why access was refused. Reaches the log and never a response body
 * (ADR-017 §6).
 */
type RefusalReason =
  | "malformed_organization_id"
  | "not_a_member"
  | "membership_not_active"
  | "unknown_organization"
  | "organization_not_active";

/**
 * Establishes the active organization for this request.
 *
 * Proves four things, in order, and refuses identically on each (ADR-017 §2):
 *
 * 1. A `Membership` exists for THIS user and THIS organization.
 * 2. That membership is `active` — `invited` has not been accepted and
 *    `suspended` has been revoked; neither grants anything.
 * 3. The `Organization` exists.
 * 4. That organization is `active`.
 *
 * Gates 3 and 4 are ADR-016 §3's binding requirement: "a membership is a
 * claim about a tenant, not proof the tenant exists." ADR-016 §3 also records
 * exactly how an orphaned membership becomes reachable — a crash between
 * onboarding's two writes — so this is not hypothetical.
 *
 * The role attached below is read from the database on every request. It is
 * not in the token (ADR-011 §2), not on the session (ADR-004 §8), and not
 * accepted from the client in any form — which is what makes a revoked role
 * take effect on the caller's next request rather than at token expiry.
 */
export const requireOrganization: RequestHandler = async (req, _res, next) => {
  /*
    `requireAccessToken` must have run. Asserted rather than handled: a route
    that mounted this without it would be an unauthenticated route reading a
    tenant, and failing loudly is the only safe response to that mistake.
  */
  const principal = req.principal;
  if (principal === undefined) {
    next(new Error("requireOrganization was mounted without requireAccessToken"));
    return;
  }

  const { userId } = principal;

  function refuse(reason: RefusalReason, organizationId?: string): void {
    /*
      The distinctions exist here, for operators, after the fact — and
      nowhere else. `not_a_member` in particular is the one a response must
      never carry: it would confirm the organization exists.
    */
    req.log.info(
      { event: "auth.organization.rejected", reason, userId, ...(organizationId === undefined ? {} : { organizationId }) },
      "Organization access refused",
    );
    next(new OrganizationNotAccessibleError(GENERIC_FAILURE_MESSAGE));
  }

  // Read from the path and nowhere else (ADR-017 §1). A body or query value
  // is not rejected here — it is never consulted, which is stronger.
  const organizationId = req.params.organizationId;

  if (typeof organizationId !== "string" || !OBJECT_ID_PATTERN.test(organizationId)) {
    return refuse("malformed_organization_id");
  }

  /*
    Both identities in one indexed query (ADR-017 §3). Deliberately NOT
    `findByUser` followed by an in-memory search: that comparison is written
    by hand and its failure modes are all quiet.
  */
  const membership = await membershipRepository.findByUserAndOrganization(userId, organizationId);

  if (membership === null) {
    /*
      The super admin reaches every organisation without belonging to any
      (ADR-039 §5). The grant is read from the database on this request, like
      every role here, and the organisation must still exist and be active.

      They act as an `admin`: read, reply, assign and manage the team, but not
      transfer ownership, which only an owner holds. Every such request is
      logged with who and where, because this is the one path into a tenant
      that no tenant granted.
    */
    const user = await userRepository.findById(userId);
    if (user !== null && user.platformRole === "admin" && user.status === "active" && user.emailVerifiedAt !== null) {
      const organization = await organizationRepository.findById(organizationId);
      if (organization === null) return refuse("unknown_organization", organizationId);
      if (organization.status !== "active") return refuse("organization_not_active", organizationId);

      req.log.info(
        { event: "auth.organization.platform_admin_access", userId, organizationId, method: req.method, path: req.originalUrl },
        "Super admin acting in an organisation",
      );
      req.organizationContext = {
        organizationId: organization._id.toString(),
        role: "admin",
        membershipId: null,
        viaPlatformAdmin: true,
      };
      return next();
    }

    return refuse("not_a_member", organizationId);
  }

  if (membership.status !== "active") {
    return refuse("membership_not_active", organizationId);
  }

  const organization = await organizationRepository.findById(organizationId);

  if (organization === null) {
    return refuse("unknown_organization", organizationId);
  }

  if (organization.status !== "active") {
    return refuse("organization_not_active", organizationId);
  }

  req.organizationContext = {
    organizationId: organization._id.toString(),
    // From the document just loaded. There is no path by which a client
    // supplies this (ADR-017 §5).
    role: membership.role,
    membershipId: membership._id.toString(),
    viaPlatformAdmin: false,
  };

  next();
};
