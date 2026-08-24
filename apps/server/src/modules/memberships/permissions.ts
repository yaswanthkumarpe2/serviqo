import type { MembershipRole } from "./membership.model";

/**
 * The permission catalogue and the role mapping (ADR-017 §7).
 *
 * ADR-002 §7–19 fixed the shape: "permission-based, centralized via `can()` /
 * `requirePermission()` — no scattered `if (role === 'admin')` checks". A
 * route names the permission it needs and never a role, which is what lets
 * this table change — or gain the custom roles `PROJECT_CONTEXT.md` §5
 * anticipates — without auditing every handler.
 *
 * Lives in the memberships module rather than `config/constants.ts`: that
 * file's ownership rule is that a value belongs there "when more than one
 * layer needs it", and this is the authorization domain's own vocabulary,
 * keyed by a type this module declares.
 */

/**
 * Permissions this codebase actually enforces.
 *
 * Deliberately short. `ticket.update` and `ai.configure` are named in
 * `PROJECT_CONTEXT.md` §5 and are absent here: no ticket or AI resource
 * exists, and a permission guarding nothing is the same unexercised security
 * surface `accessToken.ts` declined to create when it refused to write a
 * verifier before its first caller.
 *
 * A permission joins this union in the slice that enforces it —
 * `conversation.read` and `conversation.reply` did so in ADR-025, the slice
 * that gave agents a route to reach conversations through.
 */
export type Permission =
  /** Read the organization's own record — every member of a tenant can see the tenant. */
  | "organization.read"
  /**
   * Change the organization: rename, settings, suspend. Its first enforcer is
   * the widget installation surface (ADR-020) — reading the widget key,
   * replacing allowed origins, and rotating the key. Rename and suspend have
   * no endpoint yet.
   */
  | "organization.manage"
  /** See who else works here. No endpoint yet — team management is its own slice. */
  | "member.read"
  /** Invite, remove, or change a member's role. No endpoint yet. */
  | "member.manage"
  /**
   * Read the tenant's conversations and their message history (ADR-025 §4).
   * Enforced by the agent inbox's three read routes and by the socket
   * handshake's agent branch — an agent socket that cannot read conversations
   * has nothing to be delivered.
   */
  | "conversation.read"
  /**
   * Send a message as the organization — the only permission that makes
   * `senderType: "agent"` reachable (ADR-025 §6).
   *
   * Separate from `conversation.read` even though every role currently holds
   * both, so a read-only role is a table edit rather than a code change.
   */
  | "conversation.reply";

/**
 * Which role holds which permission.
 *
 * `satisfies` rather than a bare annotation, so adding a value to
 * `MembershipRole` fails to compile here until this table decides what it can
 * do. A new role that silently inherited an empty permission set would be a
 * role that appears to work and authorizes nothing.
 *
 * `customer` is absent and must stay absent: ADR-010 §2 gives three
 * independent sufficient reasons, and a customer holds no `Membership` to
 * carry a role in the first place.
 */
export const ROLE_PERMISSIONS = {
  /** Full control of the tenant, including the things that destroy it. */
  owner: [
    "organization.read",
    "organization.manage",
    "member.read",
    "member.manage",
    "conversation.read",
    "conversation.reply",
  ],
  /** Everything the owner can do except what ownership itself confers. */
  admin: [
    "organization.read",
    "organization.manage",
    "member.read",
    "member.manage",
    "conversation.read",
    "conversation.reply",
  ],
  /**
   * Oversees people and queues without configuring the tenant. Reads the
   * roster because supervising requires knowing who is on it; cannot change
   * it.
   *
   * Holds both conversation permissions: "oversees … queues" is a description
   * of someone who reads conversations, and a supervisor who could not answer
   * one would be unable to cover for the agents they supervise (ADR-025 §4).
   */
  supervisor: ["organization.read", "member.read", "conversation.read", "conversation.reply"],
  /**
   * Handles conversations — which, as of ADR-025, is a thing this role can
   * actually do rather than a description of one. Still sees nothing about
   * the tenant's configuration or its roster.
   */
  agent: ["organization.read", "conversation.read", "conversation.reply"],
} as const satisfies Record<MembershipRole, readonly Permission[]>;

/**
 * Whether a role holds a permission.
 *
 * The single place a role is compared to anything. Exported for the rare
 * caller that needs a boolean rather than a refusal — a controller shaping a
 * response to what the reader may see, for instance — so that even those
 * comparisons go through this table rather than re-deriving it.
 */
export function can(role: MembershipRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission);
}

/**
 * Every permission a role holds.
 *
 * Returned to no client today, and deliberately not part of any response:
 * a permission list in a payload invites a client to authorize itself from
 * it, and the server re-proves every request regardless (ADR-017 §10).
 * Exists for tests and for future server-side introspection.
 */
export function permissionsFor(role: MembershipRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
