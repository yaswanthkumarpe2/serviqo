/**
 * The dashboard's single permission predicate (ADR-027 §16).
 *
 * A UX AFFORDANCE, NEVER A BOUNDARY. The server re-proves every permission on
 * every request from the `Membership` document it reads on that request
 * (ADR-017 §5), so a control hidden here and un-hidden in a debugger still
 * receives a `403`. What this decides is whether showing the control would
 * only offer the reader a refusal.
 *
 * Deliberately NOT a client-side copy of `ROLE_PERMISSIONS`. A permission
 * table in the browser is a second authorization model that can disagree with
 * the first, and ADR-017 §10 already refused to put one in a response for the
 * same reason: "a permission list in a payload invites a client to authorize
 * itself from it". So this asks one question about one role string, in one
 * place, and the answer is derived from the two roles the server's catalogue
 * grants `member.manage` to.
 *
 * The role it is given is the SERVER-CONFIRMED one — `OrganizationSwitcher`
 * takes it from `GET /organizations/:id`, which resolved it from the database
 * on that request. It is never read from storage and never remembered across
 * a reload, matching that component's own rule: "Role and permissions are
 * never stored in any form — a UI that remembered 'I am an owner' is a UI that
 * can be edited into one."
 */

/**
 * The roles the server's catalogue grants `member.manage`:
 *
 *   owner: [… "member.read", "member.manage", …]
 *   admin: [… "member.read", "member.manage", …]
 *
 * One list, in one file, so a catalogue change has exactly one client-side
 * line to follow rather than a comparison scattered through JSX.
 */
const MEMBER_MANAGE_ROLES: readonly string[] = ["owner", "admin"];

/**
 * Whether this role may add members, change roles, and remove members.
 *
 * `null` — no server-confirmed role yet — answers `false`. A control that
 * appeared while the role was still loading and then vanished is worse than
 * one that appears a moment late.
 */
export function canManageMembers(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && MEMBER_MANAGE_ROLES.includes(role);
}
