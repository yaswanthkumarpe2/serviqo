import { Router } from "express";

import { requireAccessToken } from "../../middleware/requireAccessToken";
import { validateBody } from "../../middleware/validate";
import { createOrganizationController } from "./organization.controller";
import { createOrganizationSchema } from "./organization.validation";
import { createOrganizationOnboardingService } from "./organizationOnboarding.service";

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
export function createOrganizationRouter(): Router {
  const router = Router();

  const controller = createOrganizationController({
    onboardingService: createOrganizationOnboardingService(),
  });

  /*
    The second protected route in Serviqo, and the first that writes.

    No `requirePermission`: creating an organization is not an action inside
    an organization, so there is no tenant to be a member of and no role to
    require. It is the one authenticated write RBAC cannot govern, because it
    is what brings the first RBAC subject into existence (ADR-016 §1).
  */
  router.post("/", requireAccessToken, validateBody(createOrganizationSchema), controller.create);

  return router;
}
