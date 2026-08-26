import { AuthApiError, NETWORK_ERROR, unwrapEnvelope } from "@/features/auth/authApi";

/**
 * Client for the team-management endpoints (ADR-027 §1).
 *
 * The envelope reader and its error type come from the auth feature — the
 * same reuse `organizationsApi.ts`, `widgetConfigApi.ts`, and `inboxApi.ts`
 * already established, so there is one definition of what a Serviqo response
 * looks like rather than a fifth copy per feature folder.
 */

const ORGANIZATIONS_BASE = "/api/v1/organizations";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The roles a client may ask for (ADR-027 §6).
 *
 * `owner` is absent, and its absence is the point: granting ownership is
 * ownership transfer, which no route in this slice performs. The server's
 * schema refuses the value regardless — this type only stops the client from
 * building a request it knows will be refused.
 */
export type AssignableRole = "admin" | "supervisor" | "agent";

/** Every role a membership may hold, including the one no request may set. */
export type MemberRole = AssignableRole | "owner";

export type MemberStatus = "active" | "invited" | "suspended";

/**
 * One member of the organization, as the server projects them (ADR-027 §14).
 *
 * `id` is the MEMBERSHIP id — the handle the role-change and removal calls
 * take — and `user.id` is the global `User` id, which is what the inbox
 * matches a conversation's `assignedTo.id` against.
 *
 * `user` is `null` for a membership whose account no longer resolves. The row
 * is still real and still removable, so it renders rather than being dropped.
 */
export interface OrganizationMember {
  id: string;
  role: MemberRole;
  status: MemberStatus;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

/** What removing a member reports back (ADR-027 §10). */
export interface RemoveMemberResult {
  member: OrganizationMember;
  /**
   * How many conversations were released because the removed member held
   * them. Stated back to the manager, because it is the visible consequence
   * of an irreversible action.
   */
  releasedConversations: number;
}

function membersPath(organizationId: string, suffix = ""): string {
  return `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/members${suffix}`;
}

/**
 * Performs one member call and unwraps it.
 *
 * A transport failure becomes an `AuthApiError` with status 0 rather than a
 * raw `TypeError`, so every caller branches on one error type — what lets the
 * UI tell "the server refused" from "the server was not reachable".
 */
async function callMembers<T>(authorizedFetch: AuthorizedFetch, path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await authorizedFetch(path, init);
  } catch (error) {
    // The refresh behind the retry failed, and it already described itself.
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<T>(response);
}

/**
 * Reads the organization's roster (ADR-027 §14).
 *
 * Behind `member.read`. A caller whose role lacks it receives a 403, which the
 * UI renders as its own state rather than as a transport failure — it is the
 * one refusal that will never succeed on a retry.
 *
 * Defends against a well-formed envelope with no list, the same way
 * `inboxApi.ts` does: `unwrapEnvelope` proves the envelope's SHAPE and nothing
 * about what is inside it, and rendering code that mapped over `undefined`
 * would throw during render and take the dashboard down with it.
 */
export async function fetchMembers(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
): Promise<OrganizationMember[]> {
  const page = await callMembers<{ members?: unknown }>(authorizedFetch, membersPath(organizationId));

  return Array.isArray(page?.members) ? (page.members as OrganizationMember[]) : [];
}

/**
 * Adds an existing verified Serviqo account to the organization
 * (ADR-027 §3, §4).
 *
 * The body carries `email` and `role` and nothing else. There is deliberately
 * no `userId`, no `organizationId`, and no `status` to send: the tenant is the
 * path, the acting user is the token's subject, and `status` is a literal the
 * service writes. A value sent here would be stripped by the request schema
 * before any handler saw it, so sending one would be this client pretending to
 * an authority it does not have.
 *
 * Behind `member.manage`. Answers 409 for someone who is already a member and
 * 422 for an address with no verified Serviqo account — both of which the UI
 * states in its own words.
 */
export function addMember(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  email: string,
  role: AssignableRole,
): Promise<OrganizationMember> {
  return callMembers<OrganizationMember>(authorizedFetch, membersPath(organizationId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
}

/**
 * Changes one member's role (ADR-027 §1, §7).
 *
 * The target is a PATH segment, so this call cannot express "change this
 * person in that organization" — the tenant in the URL is the only one the
 * server will reach.
 *
 * Answers 409 for the owner membership and for the caller's own.
 */
export function changeMemberRole(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  membershipId: string,
  role: AssignableRole,
): Promise<OrganizationMember> {
  return callMembers<OrganizationMember>(
    authorizedFetch,
    membersPath(organizationId, `/${encodeURIComponent(membershipId)}/role`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}

/**
 * The statuses a client may ask for (ADR-029 §3).
 *
 * `invited` is absent, and its absence is the point: an invitation is accepted
 * by the invitee, so no manager request may set it. The server's schema refuses
 * the value regardless — this type only stops the client from building a
 * request it knows will be refused, exactly as `AssignableRole` does for
 * `owner`.
 */
export type SettableStatus = "active" | "suspended";

/** What a status change reports back (ADR-029 §13). */
export interface ChangeMemberStatusResult {
  member: OrganizationMember;
  /**
   * How many conversations were released because the suspended member held
   * them. Always `0` for a reactivation, which restores access and no
   * assignments (ADR-029 §10).
   */
  releasedConversations: number;
}

/**
 * Suspends or reactivates one member (ADR-029 §1, §6).
 *
 * The target is a PATH segment and the value is the body — the same shape
 * `changeMemberRole` above uses, so this call cannot express "suspend this
 * person in that organization". The tenant in the URL is the only one the
 * server will reach.
 *
 * ONE function for both directions, matching the server's one route: both need
 * `member.manage`, so `status` selects a transition rather than a permission.
 *
 * Answers 409 for the owner membership, for the caller's own, and for any
 * transition that is not `active → suspended` or `suspended → active` —
 * including both no-ops, which the server refuses rather than absorbing.
 */
export function changeMemberStatus(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  membershipId: string,
  status: SettableStatus,
): Promise<ChangeMemberStatusResult> {
  return callMembers<ChangeMemberStatusResult>(
    authorizedFetch,
    membersPath(organizationId, `/${encodeURIComponent(membershipId)}/status`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
}

/**
 * Removes a member from the organization (ADR-027 §7, §10).
 *
 * No body — the target is the path and there is nothing else to say.
 * Irreversible from this surface, which is why the UI confirms first.
 */
export function removeMember(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  membershipId: string,
): Promise<RemoveMemberResult> {
  return callMembers<RemoveMemberResult>(
    authorizedFetch,
    membersPath(organizationId, `/${encodeURIComponent(membershipId)}`),
    { method: "DELETE" },
  );
}
