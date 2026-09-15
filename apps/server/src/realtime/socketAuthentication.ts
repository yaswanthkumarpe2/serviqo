import { customerRepository } from "../modules/customers/customer.repository";
import { membershipRepository } from "../modules/memberships/membership.repository";
import { can } from "../modules/memberships/permissions";
import { organizationRepository } from "../modules/organizations/organization.repository";
import { userRepository } from "../modules/users/user.repository";
import { verifyAccessToken } from "../modules/auth/accessToken";
import { verifyWidgetToken } from "../modules/widget/widgetToken";

import type { MembershipRole } from "../modules/memberships/membership.model";
import type { WidgetPrincipal } from "../modules/widget/widgetToken";

/**
 * Socket handshake authentication (ADR-023 §3, extended by ADR-025 §9).
 *
 * TWO principal types now reach this handshake, and neither of them is a new
 * authentication system:
 *
 * - **Customers** present a widget token, verified by the exact same
 *   primitives `requireWidgetToken.ts` uses for REST.
 * - **Agents** present a staff access token plus the organization they are
 *   acting in, verified by the exact same primitives `requireAccessToken.ts`
 *   and `requireOrganization.ts` use — `verifyAccessToken`,
 *   `membershipRepository.findByUserAndOrganization`,
 *   `organizationRepository.findById`, and `can()`, in that order, which is
 *   `requireOrganization`'s own sequence of proofs.
 *
 * The orchestration below is intentionally NOT shared with those middlewares
 * (different control-flow model, different tested surface — see ADR-023 §3);
 * every primitive that actually touches the database or a credential IS
 * shared, so nothing here duplicates verification or persistence logic.
 */

/** A 24-character hex ObjectId — the shape every id-bearing boundary here guards on. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * Why a handshake was refused. Reaches the log and never the client
 * (ADR-023 §3, ADR-025 §9).
 *
 * `not_a_member` and `organization_not_found` are separate values HERE and
 * indistinguishable to the caller, which is ADR-017 §6's rule: the difference
 * would turn any authenticated staff account into an oracle for which tenant
 * ids are real.
 */
export type SocketAuthReason =
  | "missing_token"
  | "invalid_token"
  | "organization_not_found"
  | "organization_not_active"
  | "customer_not_found"
  | "customer_blocked"
  | "malformed_organization_id"
  | "not_a_member"
  | "membership_not_active"
  | "insufficient_permission";

/** The verified agent a socket is acting as (ADR-025 §9). Built only from server-side lookups. */
export interface AgentSocketPrincipal {
  userId: string;
  organizationId: string;
  /** Read from the `Membership` document on this handshake — never a token claim (ADR-011 §2). */
  role: MembershipRole;
}

export type SocketAuthOutcome =
  | { ok: true; kind: "widget"; principal: WidgetPrincipal }
  | { ok: true; kind: "agent"; principal: AgentSocketPrincipal }
  | { ok: false; kind: "invalid_token"; reason: SocketAuthReason }
  | { ok: false; kind: "session_refused"; reason: SocketAuthReason; organizationId?: string };

/**
 * The handshake `auth` payload, as it arrives — entirely untrusted.
 *
 * `organizationId` is the DISCRIMINATOR, not an authorization: a handshake
 * carrying one takes the agent branch, and the server then proves membership
 * in that exact tenant before accepting the connection. A forged value
 * resolves to a membership lookup that returns `null` (ADR-025 §9).
 */
export interface SocketHandshakeAuth {
  token?: unknown;
  organizationId?: unknown;
}

/**
 * Resolves a handshake payload to the principal it names, or the reason it
 * does not, in one call so a later edit cannot skip a check.
 *
 * The branch is chosen by the payload's SHAPE, never by trying one verifier
 * and falling back to the other (ADR-025 §9). The two token formats are
 * signed with different keys and carry different audiences (ADR-019 §8), so a
 * fallback chain would be exactly the structure in which a future third
 * format silently verifies as the wrong principal type.
 */
export async function authenticateSocketHandshake(auth: SocketHandshakeAuth | undefined): Promise<SocketAuthOutcome> {
  const token = auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, kind: "invalid_token", reason: "missing_token" };
  }

  const organizationId = auth?.organizationId;
  if (organizationId !== undefined) {
    return authenticateAgent(token, organizationId);
  }

  return authenticateWidget(token);
}

/**
 * The customer branch — ADR-023 §3, unchanged in behaviour.
 */
async function authenticateWidget(token: string): Promise<SocketAuthOutcome> {
  const principal = await verifyWidgetToken(token);
  if (principal === null) {
    return { ok: false, kind: "invalid_token", reason: "invalid_token" };
  }

  const { customerId, organizationId } = principal;

  /*
    A widget token cannot be revoked before it expires (ADR-019 §14), so a
    tenant suspended AFTER a token was issued is only caught here — the
    identical re-check `requireWidgetToken` performs for REST on every
    request, applied once at handshake time for a socket connection.
  */
  const organization = await organizationRepository.findById(organizationId);
  if (organization === null) {
    return { ok: false, kind: "session_refused", reason: "organization_not_found", organizationId };
  }
  if (organization.status !== "active") {
    return { ok: false, kind: "session_refused", reason: "organization_not_active", organizationId };
  }

  const customer = await customerRepository.findByIdAndOrganization(customerId, organizationId);
  if (customer === null || customer.mergedIntoCustomerId !== null) {
    return { ok: false, kind: "session_refused", reason: "customer_not_found", organizationId };
  }
  // A blocked visitor cannot open a live connection either (ADR-043 §3).
  if (customer.blockedAt !== null) {
    return { ok: false, kind: "session_refused", reason: "customer_blocked", organizationId };
  }

  return { ok: true, kind: "widget", principal: { customerId, organizationId } };
}

/**
 * The agent branch (ADR-025 §9) — `requireOrganization`'s proofs, in
 * `requireOrganization`'s order, over a handshake instead of a request.
 *
 * The one addition beyond that middleware is the final permission check.
 * `requirePermission` is a separate middleware for REST because a route names
 * the permission it needs; a socket has no route, so the connection itself
 * names one — `conversation.read`, since an agent socket exists to be
 * delivered conversation messages and one that cannot read conversations has
 * nothing to receive.
 */
async function authenticateAgent(token: string, organizationId: unknown): Promise<SocketAuthOutcome> {
  /*
    Guarded before any query, exactly as `requireOrganization` guards the path
    segment: a malformed value reaching `findOne` raises a `CastError`, and a
    `CastError` here would refuse the handshake for a reason the log would
    describe as an internal fault.
  */
  if (typeof organizationId !== "string" || !OBJECT_ID_PATTERN.test(organizationId)) {
    return { ok: false, kind: "session_refused", reason: "malformed_organization_id" };
  }

  const principal = await verifyAccessToken(token);
  if (principal === null) {
    // Signature, issuer, audience, expiry, and claim shape all collapse to
    // one outcome inside the verifier (ADR-015 §2). A widget token presented
    // here fails at the SIGNATURE, not at a claim, because the two formats
    // are signed with different keys (ADR-019 §8).
    return { ok: false, kind: "invalid_token", reason: "invalid_token" };
  }

  const { userId } = principal;

  /*
    Both identities in one indexed query (ADR-017 §3). Deliberately NOT
    `findByUser` followed by an in-memory search: that comparison is written
    by hand and its failure modes are all quiet.
  */
  const membership = await membershipRepository.findByUserAndOrganization(userId, organizationId);
  if (membership === null) {
    /*
      The super admin's live inbox for any organisation (ADR-039 §5): the same
      fallback `requireOrganization` makes, so a console that can read an
      organisation's conversations also receives them as they arrive.
    */
    const user = await userRepository.findById(userId);
    if (user !== null && user.platformRole === "admin" && user.status === "active" && user.emailVerifiedAt !== null) {
      const organization = await organizationRepository.findById(organizationId);
      if (organization === null) {
        return { ok: false, kind: "session_refused", reason: "organization_not_found", organizationId };
      }
      if (organization.status !== "active") {
        return { ok: false, kind: "session_refused", reason: "organization_not_active", organizationId };
      }
      return { ok: true, kind: "agent", principal: { userId, organizationId, role: "admin" } };
    }

    return { ok: false, kind: "session_refused", reason: "not_a_member", organizationId };
  }
  if (membership.status !== "active") {
    return { ok: false, kind: "session_refused", reason: "membership_not_active", organizationId };
  }

  /*
    Gates 3 and 4 of ADR-017 §2, which that decision calls binding: "a
    membership is a claim about a tenant, not proof the tenant exists." It
    also records exactly how an orphaned membership becomes reachable — a
    crash between onboarding's two writes — so this is not hypothetical.
  */
  const organization = await organizationRepository.findById(organizationId);
  if (organization === null) {
    return { ok: false, kind: "session_refused", reason: "organization_not_found", organizationId };
  }
  if (organization.status !== "active") {
    return { ok: false, kind: "session_refused", reason: "organization_not_active", organizationId };
  }

  if (!can(membership.role, "conversation.read")) {
    return { ok: false, kind: "session_refused", reason: "insufficient_permission", organizationId };
  }

  return {
    ok: true,
    kind: "agent",
    // Every field from a document this function just loaded. The client
    // supplied the organization id as a discriminator and it has now been
    // proved; the role was never client-supplied at all (ADR-017 §5).
    principal: { userId, organizationId, role: membership.role },
  };
}
