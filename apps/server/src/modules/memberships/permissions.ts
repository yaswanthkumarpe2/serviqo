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
 * that gave agents a route to reach conversations through, and
 * `conversation.assign` did so in ADR-026, the slice that gave conversations
 * an owner. `conversation.close` deliberately did NOT join in ADR-026 §3,
 * because its row would have been identical to `conversation.reply`'s for
 * every role.
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
  /**
   * Hand the organization to another member — `POST /organizations/:id/ownership`
   * (ADR-028 §2).
   *
   * THE FIRST PERMISSION THAT SEPARATES `owner` FROM `admin`, and the reason
   * `admin`'s row below can finally be described as "everything the owner can
   * do except what ownership itself confers" as a statement about the running
   * system rather than an intention.
   *
   * Deliberately not folded into `organization.manage`. That permission covers
   * configuring the tenant — rename, settings, widget installation — and every
   * one of those actions is something an administrator does *on behalf of* the
   * owner. This one is the owner's standing itself: an admin who held it could
   * take the tenant from the person who created it, which is a
   * privilege-escalation primitive dressed as an administrative convenience.
   *
   * The underscore is a departure from `organization.manage`'s spelling and is
   * kept because the action is a verb phrase with no honest single word:
   * `organization.transfer` does not say what is transferred, and
   * `organization.own` names a state rather than an action.
   */
  | "organization.transfer_ownership"
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
   *
   * As of ADR-026 §3 this permission also gates CHANGING A CONVERSATION'S
   * STATUS — closing and reopening — because closing is *acting in* a
   * conversation, which is exactly the standing that separates a participant
   * from a reader. A `conversation.close` permission was declined there: its
   * row would be identical to this one's for every role, and a permission no
   * route distinguishes is being anticipated rather than enforced. Splitting
   * it out later is one line here and one line in the route.
   */
  | "conversation.reply"
  /**
   * Change who owns a conversation — claim it, or release it (ADR-026 §3).
   *
   * Named for the capability rather than for the verb, following
   * `organization.manage`'s own shape: one permission covering rename,
   * settings, and suspend rather than three.
   *
   * Held by every role that holds `conversation.reply`, because claiming is
   * how an agent takes responsibility for the reply they are about to write —
   * a role that could answer conversations but never pick one up could only
   * ever work someone else's queue.
   *
   * Deliberately separate from `conversation.reply` even so. Ownership and
   * participation are orthogonal, and a tenant that later wants "supervisors
   * assign, agents close" gets it from a table edit; it would get nothing if
   * the two rode on one permission.
   *
   * What this permission does NOT confer is taking a conversation from
   * another agent — that is refused for every role, and an override needs its
   * own permission and a notification design (ADR-026 §4, §15).
   */
  | "conversation.assign"
  /** Writing the team's saved replies (ADR-042 §1). Using them needs only `conversation.read`. */
  | "saved_reply.manage";

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
    /*
      Owner-only, and the ONLY row in this table that `admin` below does not
      also carry (ADR-028 §2). Everything else in this file is deliberately
      identical between the two roles; this single entry is what the word
      "owner" now means in Serviqo.
    */
    "organization.transfer_ownership",
    "member.read",
    "member.manage",
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "saved_reply.manage",
  ],
  /**
   * Everything the owner can do except what ownership itself confers.
   *
   * As of ADR-028 §2 that sentence is literal rather than aspirational: the
   * difference between this row and `owner`'s is exactly
   * `organization.transfer_ownership`, and `permissions.test.ts` asserts the
   * difference is exactly that one entry — so a future slice cannot widen it
   * or grant ownership transfer here without the test saying so.
   */
  admin: [
    "organization.read",
    "organization.manage",
    "member.read",
    "member.manage",
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "saved_reply.manage",
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
  supervisor: [
    "organization.read",
    "member.read",
    "conversation.read",
    "conversation.reply",
    "conversation.assign",
    "saved_reply.manage",
  ],
  /**
   * Handles conversations — which, as of ADR-025, is a thing this role can
   * actually do rather than a description of one. Still sees nothing about
   * the tenant's configuration or its roster.
   */
  agent: ["organization.read", "conversation.read", "conversation.reply", "conversation.assign"],
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
