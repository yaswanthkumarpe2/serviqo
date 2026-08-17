import { created, success } from "../../lib/response";
import { OrganizationNotAccessibleError } from "../../lib/errors";
import { organizationRepository } from "./organization.repository";

import type { CreateOrganizationInput } from "./organization.validation";
import type { OrganizationOnboardingService } from "./organizationOnboarding.service";
import type { RequestHandler } from "express";

export interface OrganizationControllerDependencies {
  onboardingService: OrganizationOnboardingService;
}

/**
 * Translates request → service → response, and nothing else — the same
 * contract `auth.controller.ts` follows.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error into
 * a response.
 */
export function createOrganizationController({ onboardingService }: OrganizationControllerDependencies) {
  /**
   * Creates an organization owned by the caller (ADR-016 §1).
   *
   * The actor comes from `req.principal`, which `requireAccessToken` has
   * already established, and never from the body. `principal` is asserted
   * rather than guarded for the reason `auth.controller.ts`'s `me` asserts
   * it: the route mounts the middleware that sets it, and a guard here would
   * imply this handler is reachable without one.
   *
   * `req.body` is safe to assert — `validateBody` replaced it with the
   * schema's output before this could run, which also means an `ownerUserId`
   * or `slug` a client tried to send was stripped rather than rejected, and
   * cannot reach the service at all.
   *
   * 201 rather than 200: this creates a resource, and `created()` is the
   * envelope helper that exists for exactly that.
   */
  const create: RequestHandler = async (req, res) => {
    const result = await onboardingService.createOrganization(
      req.body as CreateOrganizationInput,
      { userId: req.principal!.userId },
      req.log,
    );

    created(res, result);
  };

  /**
   * Reads the active organization and the caller's role in it (ADR-017 §8).
   *
   * The first consumer of `requireOrganization` and `requirePermission`. It
   * exists so this slice does not ship two security-critical middlewares that
   * nothing exercises — the failure mode `accessToken.ts` named when it
   * declined to write a verifier before its first caller.
   *
   * Everything this handler needs has already been proved: the organization
   * exists, is active, and the caller holds an active membership in it with a
   * role that grants `organization.read`. Nothing is re-derived here, and the
   * id used for the lookup comes from the context rather than from
   * `req.params` — the middleware validated one and the handler must not read
   * the other, or the two could diverge.
   */
  const read: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;

    const organization = await organizationRepository.findById(context.organizationId);

    /*
      Reachable only if the organization was deleted between the middleware's
      lookup and this one — microseconds, and nothing deletes organizations
      today. Answered with the same refusal rather than a 500, because a
      client that lost a race should see the same thing as one that never had
      access.
    */
    if (organization === null) {
      throw new OrganizationNotAccessibleError("Organization not found");
    }

    success(res, {
      organization: {
        id: organization._id.toString(),
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
        createdAt: organization.createdAt,
      },
      // From the database via the middleware, never from the client.
      role: context.role,
    });
  };

  return { create, read };
}
