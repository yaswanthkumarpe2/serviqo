import { InvalidAccessTokenError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { membershipRepository } from "../memberships/membership.repository";
import { organizationRepository } from "../organizations/organization.repository";
import { isStaffKind } from "../users/user.model";
import { userRepository } from "../users/user.repository";

import type { MembershipRole } from "../memberships/membership.model";
import type { OrganizationStatus } from "../organizations/organization.model";
import type { PlatformRole, UserDocument, UserKind, UserStatus } from "../users/user.model";
import type { AccessTokenPrincipal } from "./accessToken";
import type { AuthLogger } from "./authLogging";

/**
 * The authenticated caller's own identity (ADR-015).
 *
 * Organization users only, permanently. Customers own no `User` and
 * authenticate against nothing, so there is no principal here they could be
 * (ADR-010 §5) — the audience claim `requireAccessToken` verified is what
 * makes that structural rather than a matter of trusting the caller.
 */

/**
 * What the caller learns about themselves.
 *
 * Deliberately not the Mongoose document. `toJSON` strips `passwordHash`, but
 * `failedLoginAttempts` and `lockedUntil` would still ride along — lockout
 * state belongs to authentication, not to a client — and a DTO built field by
 * field cannot silently gain whatever the schema gains next.
 *
 * Wider than login's `AuthenticatedUser` and deliberately a separate type. The
 * two answer different questions: login reports the minimum a caller needs to
 * know a sign-in worked, while this is the dashboard's view of an account it
 * has already proved it owns. Aliasing them would mean a field added for one
 * appears in the other.
 *
 * No `organizationId` and no `role` ON THIS TYPE, still. Memberships are a
 * sibling of the user in the response rather than fields on it, because a
 * membership is a fact about a relationship and not an attribute of the
 * person — the same reason `User` carries no `organizationId` (ADR-010 §3).
 */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  /**
   * Always `"active"` — §7's gate refuses every other value before this is
   * built. Included regardless: it is the caller's own state returned to the
   * authenticated owner, so it discloses nothing, and a client that reads it
   * survives a future state being allowed through (ADR-015 §10).
   */
  status: UserStatus;
  /**
   * Never null for the same reason, and a timestamp rather than a boolean —
   * unlike `status` it is genuinely per-user data.
   */
  emailVerifiedAt: Date;
  /**
   * Whether this account operates Serviqo itself (ADR-032 §6).
   *
   * `"none"` for very nearly everyone. It is reported here so the client knows
   * which surface to render for the person who just signed in, and it is safe
   * to report because this endpoint tells the authenticated OWNER of an
   * account a fact about that same account — the caller cannot learn anything
   * here they did not already have.
   *
   * It is an affordance and never a boundary. A client that set this field to
   * `"admin"` in its own memory would render the portal shell and receive a
   * 403 from every request that shell makes, because `requirePlatformAdmin`
   * re-reads the grant from the database and does not ask the client
   * (SECURITY.md §4).
   */
  platformRole: PlatformRole;
  /**
   * Which staff surface this account belongs on (ADR-034 §1, ADR-037).
   *
   * Decides which shell the client renders — the agent workspace or the
   * operations console — and, like `platformRole` beside it, is an affordance
   * rather than a boundary. A client that changed it would render the other
   * shell and be refused by every request that shell makes, from the database
   * on the request (SECURITY.md §4).
   */
  kind: UserKind;
  createdAt: Date;
}

/**
 * One organization the caller belongs to, and their standing in it
 * (ADR-017 §9).
 *
 * Minimal on purpose: `id`, `name`, `slug`, `status`. No timestamps, no
 * internal fields, nothing about other members. A switcher needs a label, an
 * address, and an id.
 */
export interface CurrentUserMembership {
  membershipId: string;
  role: MembershipRole;
  organization: {
    id: string;
    name: string;
    slug: string;
    /**
     * Always `"active"` today — only active organizations are listed. Kept
     * for ADR-015 §10's reason: a client that reads it survives a future
     * state being allowed through, where one that assumed "listed implies
     * active" would have to be found and changed.
     */
    status: OrganizationStatus;
  };
}

/**
 * The whole `/me` payload: who the caller is, and where they work.
 *
 * A LIST, never a selection. There is no `currentOrganizationId` here,
 * because the server has no notion of "current" — the client chooses and the
 * server re-proves that choice on every request (ADR-017 §1, §10).
 */
export interface CurrentUserResult {
  user: CurrentUser;
  /** Empty for a user who has registered and not yet onboarded. Never fabricated. */
  memberships: CurrentUserMembership[];
}

export interface CurrentUserService {
  getCurrentUser(principal: AccessTokenPrincipal, log?: AuthLogger): Promise<CurrentUserResult>;
}

/** The same message every other refusal on this route carries (ADR-015 §6). */
const GENERIC_FAILURE_MESSAGE = "Authentication required";

/**
 * Built from the loaded document rather than from the token, so `name` and
 * `email` are current as of this request rather than as of login. That is also
 * why neither is a claim: a name in a JWT is stale personal data in a place
 * personal data does not belong (ADR-011 §2).
 */
function toCurrentUser(user: UserDocument): CurrentUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    status: user.status,
    // Non-null by the gate above; asserted rather than defaulted so a change
    // that made it reachable as null fails loudly here instead of shipping
    // `null` to a dashboard that renders it.
    emailVerifiedAt: user.emailVerifiedAt!,
    platformRole: user.platformRole,
    kind: user.kind as UserKind,
    createdAt: user.createdAt,
  };
}

/**
 * The caller's memberships, with the organization each one points at
 * (ADR-017 §9).
 *
 * Uses `findByUser` — the listing lookup, never the authorization one. This
 * request names no organization, so there is nothing to authorize; it asks
 * "which do I belong to", and `userId` is the complete scope (ADR-017 §4).
 *
 * Applies the same gates `requireOrganization` applies, so the list contains
 * only organizations the caller can actually enter: an entry for a suspended
 * tenant, or for a membership still `invited`, would be a switcher option
 * that 404s the moment it is chosen.
 *
 * The organizations are fetched one by one rather than with a single `$in`.
 * At the scale a person's membership list reaches — a handful, and dozens at
 * the extreme — the round trips are cheap, and `organizationRepository` has
 * no bulk method to add speculatively (its own comment: "nothing in the
 * codebase needs them yet"). A user with hundreds of memberships would make
 * this worth revisiting; none exists.
 */
async function loadMemberships(userId: string): Promise<CurrentUserMembership[]> {
  const memberships = await membershipRepository.findByUser(userId);

  const entries: CurrentUserMembership[] = [];

  for (const membership of memberships) {
    if (membership.status !== "active") continue;

    const organization = await organizationRepository.findById(membership.organizationId.toString());
    // Null is reachable: ADR-016 §3 accepts an inert membership pointing at
    // an organization whose write failed. It is skipped rather than reported.
    if (organization === null || organization.status !== "active") continue;

    entries.push({
      membershipId: membership._id.toString(),
      role: membership.role,
      organization: {
        id: organization._id.toString(),
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
      },
    });
  }

  /*
    Deterministic order (ADR-017 §9). Mongo promises none, and a switcher
    that reshuffles between loads is one people mis-click. By name for the
    reader, then by id to break ties — two organizations may share a display
    name (ADR-016 consequences).
  */
  return entries.sort(
    (a, b) =>
      a.organization.name.localeCompare(b.organization.name) || a.organization.id.localeCompare(b.organization.id),
  );
}

export function createCurrentUserService(): CurrentUserService {
  return {
    async getCurrentUser(principal: AccessTokenPrincipal, log: AuthLogger = logger): Promise<CurrentUserResult> {
      const { userId, sessionId } = principal;

      const user = await userRepository.findById(userId);

      /*
        A valid signature identifies a user; it does not entitle them
        (ADR-015 §7). The same three-part gate `refresh.service.ts` applies —
        exists, active, verified — deliberately identical, so the two cannot
        drift into disagreeing about who may hold a session.

        This is what makes disabling an account take effect on the next
        request rather than at token expiry. The account is re-checked every
        time; the SESSION deliberately is not (§8).

        Unknown and disabled collapse into one refusal here rather than
        branching into two responses: distinguishing them would turn a bearer
        token into a probe for account state.
      */
      if (user === null || user.status !== "active" || user.emailVerifiedAt === null || !isStaffKind(user.kind)) {
        log.info(
          {
            event: "auth.me.failed",
            reason: user === null ? "unknown_user" : "user_not_entitled",
            userId,
            sessionId,
          },
          "Current-user request refused for an account that may no longer be served",
        );
        throw new InvalidAccessTokenError(GENERIC_FAILURE_MESSAGE);
      }

      const memberships = await loadMemberships(userId);

      /*
        The COUNT is logged; the organizations are not. How many tenants a
        person belongs to is operationally useful when a switcher misbehaves,
        while their names and ids in every /me line would put tenant data in
        the log on every dashboard load (ADR-016 §9's reasoning).
      */
      log.info(
        { event: "auth.me.succeeded", userId, sessionId, membershipCount: memberships.length },
        "Current user resolved",
      );

      return { user: toCurrentUser(user), memberships };
    },
  };
}
