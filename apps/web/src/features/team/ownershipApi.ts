import { AuthApiError, NETWORK_ERROR, unwrapEnvelope } from "@/features/auth/authApi";

import type { MemberRole, OrganizationMember } from "./membersApi";

/**
 * Client for the ownership-transfer endpoint (ADR-028 §1).
 *
 * A separate module from `membersApi.ts`, mirroring the server's own split:
 * ownership is a property of the TENANT behind an `organization.*` permission,
 * not a member of the roster behind `member.manage` (ADR-028 §1). One file per
 * resource keeps "which permission does this call need?" answerable by reading
 * the import.
 *
 * The envelope reader and its error type come from the auth feature — the same
 * reuse `organizationsApi.ts`, `widgetConfigApi.ts`, `inboxApi.ts`, and
 * `membersApi.ts` established, so there is one definition of what a Serviqo
 * response looks like rather than a sixth copy per feature folder.
 */

const ORGANIZATIONS_BASE = "/api/v1/organizations";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * What a completed transfer reports back (ADR-028 §15).
 *
 * Two membership ids and two roles. No name, no email, no user id, and no
 * permission list — the server declines to widen the payload because the client
 * already rendered the roster it selected from, and because a permission list
 * invites a client to authorize itself from it (ADR-017 §10).
 *
 * The caller states the person's name from the roster row it already has, and
 * refetches everything else.
 */
export interface OwnershipTransferResult {
  previousOwner: { id: string; role: MemberRole };
  newOwner: { id: string; role: MemberRole };
}

/**
 * Which members may receive ownership (ADR-028 §6, §16).
 *
 * Filtered from the roster the Team section already fetched, so offering the
 * choice costs no extra request and discloses nothing beyond what
 * `member.read` already returned. Mirrors the server's own gates, so the picker
 * cannot offer someone whose only possible outcome is a 409:
 *
 * - not the current owner — that is the caller, and transferring to yourself is
 *   refused;
 * - `active` — an `invited` membership has not been accepted and a `suspended`
 *   one has been revoked;
 * - a resolved account — a membership whose `User` is gone cannot be an owner.
 *
 * The server re-proves every one of these. This only keeps the page honest
 * about what it offers.
 */
export function eligibleForOwnership(members: OrganizationMember[]): OrganizationMember[] {
  return members.filter(
    (member) => member.role !== "owner" && member.status === "active" && member.user !== null,
  );
}

/**
 * Hands the organization to another member.
 *
 * The body carries `membershipId` and nothing else. There is deliberately no
 * `organizationId` — the tenant is the path — and no `currentOwnerId`: the
 * acting owner is the access token's subject and the membership the server read
 * on this request. A value sent for either would be stripped by the request
 * schema before any handler saw it, so sending one would be this client
 * pretending to an authority it does not have (ADR-028 §4).
 *
 * Behind `organization.transfer_ownership`, which only `owner` holds. Answers
 * 403 for every other role, 404 for a membership this tenant cannot reach, and
 * 409 for a target that is the caller, is not active, or whose account is not
 * active — each of which the UI states in its own words.
 */
export async function transferOwnership(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  membershipId: string,
): Promise<OwnershipTransferResult> {
  const path = `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/ownership`;

  let response: Response;

  try {
    response = await authorizedFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membershipId }),
    });
  } catch (error) {
    // The refresh behind the retry failed, and it already described itself.
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<OwnershipTransferResult>(response);
}
