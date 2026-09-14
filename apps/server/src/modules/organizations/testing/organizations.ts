import { verifyAccessToken } from "../../auth/accessToken";
import { createOrganizationOnboardingService } from "../organizationOnboarding.service";

/**
 * Creates an organisation owned by the holder of `accessToken`, for tests.
 *
 * Staff cannot create organisations over HTTP any more — the super admin does,
 * and invites the owner (ADR-039 §1). Most suites only need "a signed-in person
 * who owns an organisation", and inviting through the console every time would
 * bury what each suite is actually about. This produces exactly that state:
 * a real organisation with a unique slug, and a real `owner` membership.
 *
 * Returns the same shape `POST /organizations` used to, so call sites read the
 * same.
 */
export async function createOrganizationAs(
  accessToken: string,
  name: string,
): Promise<{ id: string; name: string; slug: string; status: string }> {
  const principal = await verifyAccessToken(accessToken);
  if (principal === null) throw new Error("createOrganizationAs: the access token did not verify");

  const result = await createOrganizationOnboardingService().createOrganization({ name }, { userId: principal.userId });
  return { id: result.organization.id, name: result.organization.name, slug: result.organization.slug, status: result.organization.status };
}
