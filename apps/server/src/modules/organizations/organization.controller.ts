import { created } from "../../lib/response";

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

  return { create };
}
