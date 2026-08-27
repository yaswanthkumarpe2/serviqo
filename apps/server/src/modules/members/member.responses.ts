import type { MembershipDocument, MembershipRole } from "../memberships/membership.model";
import type { UserDocument } from "../users/user.model";

/**
 * Response projections for the team-management surface (ADR-027 §14).
 *
 * Built field by field, like every projection in this codebase, so the payload
 * cannot silently gain whatever a schema gains next. That is not theoretical
 * here: `User` carries `passwordHash`, `failedLoginAttempts`, and
 * `lockedUntil`, and a projection that spread the document would ship
 * authentication state to a colleague's screen.
 */

/**
 * The order the roster renders in (ADR-027 §14).
 *
 * Role RANK rather than alphabetical, because a team page is read
 * top-down and "who runs this" is the first question. Keyed by
 * `MembershipRole` with `satisfies`, so a role added to the catalogue fails to
 * compile here until it has a place in the ordering — a new role that silently
 * sorted last would be a role nobody noticed shipping.
 */
const ROLE_RANK = {
  owner: 0,
  admin: 1,
  supervisor: 2,
  agent: 3,
} as const satisfies Record<MembershipRole, number>;

/**
 * One member of the organization, as a caller holding `member.read` sees them.
 *
 * `id` is the MEMBERSHIP id — the handle the role-change and removal routes
 * take (ADR-027 §1) — and `user.id` is the global `User` id, which the inbox
 * already needs so a reader can match a conversation's `assignedTo.id` against
 * a roster row.
 *
 * `user.email` is included, and that is the disclosure decision. `member.read`
 * is "See who else works here"; a team page that cannot show how to reach a
 * colleague is not a team page. It reaches `owner`, `admin`, and `supervisor`
 * — the roles that hold the permission — and reaches an `agent`, a customer,
 * or a socket never: ADR-027 §15 declines a roster broadcast for exactly this
 * reason, since a broadcast has no single reader to run
 * `can(role, "member.read")` against.
 *
 * Absent, each for its own reason:
 *
 * - `passwordHash` — `select: false` at the schema level, and unreachable here
 *   regardless because this object is assembled rather than spread.
 * - `failedLoginAttempts`, `lockedUntil`, `emailVerifiedAt` — authentication
 *   state, which belongs to authentication and not to a colleague's view of a
 *   colleague. `currentUser.service.ts` says the same of the same fields when
 *   the reader is the account's own owner; it is only more true here.
 * - `invitedByUserId` — recorded on every add (ADR-027 §3) and deliberately
 *   not rendered. "Added by" is a product decision with no request behind it,
 *   and a field in a payload is a field a client starts depending on.
 * - `organizationId` — the caller named the tenant in the URL and the server
 *   proved it, so echoing it back tells them nothing they did not supply. The
 *   same omission every projection in this codebase makes.
 */
export interface MemberResponse {
  id: string;
  role: MembershipRole;
  /**
   * `active`, `invited`, or `suspended`.
   *
   * Rendered rather than filtered out, so a manager can see WHY a colleague
   * cannot get in. `requireOrganization` refuses every non-`active` membership
   * (ADR-017 §2), which means a suspended row on this page is a person with no
   * access — a fact the page exists to show, not one to hide.
   */
  status: string;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
  } | null;
}

/**
 * Projects one membership and the `User` it points at.
 *
 * `user` is `null` when the document does not resolve. That is reachable
 * rather than defensive — `membership.model.ts` states plainly that Mongoose
 * `ref` is not a foreign-key constraint — and a roster row for a person whose
 * account is gone should render as an unresolved membership the manager can
 * remove, not as a 500 that takes the whole page down.
 *
 * The `UserDocument` is passed in rather than fetched here: resolving it
 * per row would be the N+1 every list endpoint in this codebase is written to
 * avoid, and the caller batches it through `userRepository.findByIds`.
 */
export function toMemberResponse(membership: MembershipDocument, user: UserDocument | null): MemberResponse {
  return {
    id: membership._id.toString(),
    role: membership.role,
    status: membership.status,
    createdAt: membership.createdAt,
    user:
      user === null
        ? null
        : {
            id: user._id.toString(),
            name: user.name,
            email: user.email,
          },
  };
}

/**
 * Orders the roster deterministically (ADR-027 §14).
 *
 * By role rank, then by name, then by membership id. Mongo promises no order
 * and the repository's `createdAt` sort is only the guarantee that two calls
 * agree; this is the order a reader wants. The final id tiebreak exists
 * because two members may share a display name, exactly as
 * `currentUser.service.ts` breaks ties by organization id for organizations
 * that may share one.
 *
 * A row whose `user` did not resolve sorts last within its role, rather than
 * throwing on a null name.
 */
export function sortMembers(members: MemberResponse[]): MemberResponse[] {
  return [...members].sort(
    (a, b) =>
      ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
      (a.user?.name ?? "￿").localeCompare(b.user?.name ?? "￿") ||
      a.id.localeCompare(b.id),
  );
}
