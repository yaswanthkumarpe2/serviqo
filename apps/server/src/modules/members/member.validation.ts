import { z } from "zod";

import { ROLE_PERMISSIONS } from "../memberships/permissions";

import type { MembershipRole, MembershipStatus } from "../memberships/membership.model";

/**
 * Request schemas for the team-management routes (ADR-027 §4, §6;
 * ADR-029 §3–4).
 *
 * Three schemas, and what they do NOT name is the security property. None
 * carries `userId`, `organizationId`, `membershipId`, or `invitedByUserId`.
 * Zod object schemas strip unrecognized keys (ADR-007 §6), so a client that
 * posts one has it STRIPPED rather than rejected: a forged value never becomes
 * observable to a controller at all.
 *
 * `status` is the one identity-adjacent field that IS nameable, and only by
 * `updateMemberStatusSchema` at the bottom — the route whose entire purpose is
 * setting it (ADR-029 §1). `addMemberSchema` still writes `active` as a
 * literal, because who may join is not the same question as who may be
 * suspended, and the two routes carry different meanings for the same word.
 *
 * That is ADR-022 §5's rule — "assigned as a literal … never a parameter that
 * traces back to request input" — applied to identity, exactly as ADR-026 §2
 * applied it to conversation assignment. The acting user comes from
 * `req.principal`, the tenant from `req.organizationContext`, and the target
 * membership from the path.
 */

/**
 * A 24-character hex ObjectId — the same guard `requireOrganization` and
 * `agentInbox.controller.ts` apply, for the same reason: a malformed value
 * reaching `Mongoose.findOne` raises a `CastError`, and a `CastError` reaching
 * `errorHandler` becomes a generic 500, reporting a client's mistyped URL as a
 * server fault.
 */
export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * The roles a request may name, derived from the authorization table itself
 * (ADR-027 §6).
 *
 * `ROLE_PERMISSIONS` is a runtime value AND is the catalogue
 * `requirePermission` consults, so deriving from it means there is exactly one
 * list of role names in the codebase. A role added to the catalogue becomes
 * assignable in the same commit that gives it permissions; a role removed from
 * it stops being assignable in the same commit. `agentInbox.validation.ts`
 * spells its status enum out and explains why it must —
 * `ConversationStatus` is a type with no runtime value — and that reasoning
 * does not apply here.
 *
 * `owner` is excluded (ADR-027 §7a). Granting ownership is ownership transfer,
 * which is a single atomic demote-and-promote against index B's partial unique
 * constraint, in a database this project deliberately runs without
 * transactions. Refusing the value in the schema means index B is a backstop
 * rather than the error path — a promotion that reached MongoDB would be a 500
 * for a request a 400 could have refused.
 */
export const ASSIGNABLE_ROLES = (Object.keys(ROLE_PERMISSIONS) as MembershipRole[]).filter(
  (role): role is Exclude<MembershipRole, "owner"> => role !== "owner",
);

/**
 * A non-empty tuple, because `z.enum` requires one and `Object.keys` cannot
 * prove it. Asserted rather than defaulted: a catalogue with no assignable
 * role is a broken build, and failing at import is louder than shipping a
 * schema that accepts nothing.
 */
function assignableRoleEnum() {
  const [first, ...rest] = ASSIGNABLE_ROLES;
  /* c8 ignore next -- unreachable while ROLE_PERMISSIONS has any non-owner row. */
  if (first === undefined) throw new Error("ROLE_PERMISSIONS declares no assignable role");
  return z.enum([first, ...rest]);
}

const roleSchema = assignableRoleEnum();

/**
 * The email a member request names.
 *
 * Bounded and shape-checked here; NORMALIZED in the service, through
 * `normalizeEmail` — the one place that rule lives (`user.model.ts`). Doing it
 * in two places would be two places for casing and whitespace handling to
 * drift, and the service is where the lookup that depends on it happens.
 *
 * The bound matches what the registration schema accepts, so an address that
 * could register is an address that can be added.
 */
const emailSchema = z.string().trim().min(3).max(254).email("email must be a valid email address");

/**
 * `POST /organizations/:organizationId/members` (ADR-027 §3, §4).
 *
 * `{ email, role }` and nothing else. `status` is absent because this route
 * writes `active` as a literal, and `invitedByUserId` is absent because it is
 * the verified caller — neither is the client's to choose.
 */
export const addMemberSchema = z.object({
  email: emailSchema,
  role: roleSchema,
  /**
   * Present when inviting someone who has no account yet (ADR-039 §4): the
   * account is created under this name and emailed its credentials.
   */
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(120, "Name is too long")
    .refine((value) => !/\p{Cc}/u.test(value), "Name must not contain control characters")
    .optional(),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;

/**
 * `PATCH /organizations/:organizationId/members/:membershipId/role`
 * (ADR-027 §1, §6).
 *
 * The path names the field being changed, following ADR-026 §2's shape, so the
 * body carries only the value. The target is the path segment, never a body
 * field — which is what makes "you cannot aim this at another tenant" a
 * property of the query rather than of a comparison.
 */
export const updateMemberRoleSchema = z.object({
  role: roleSchema,
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

/**
 * The statuses a request may name (ADR-029 §3).
 *
 * SPELLED OUT rather than derived, unlike `ASSIGNABLE_ROLES` above, and the
 * difference is not a stylistic one: `ROLE_PERMISSIONS` is a runtime value
 * that can be enumerated, while `MembershipStatus` is a TypeScript type with
 * no runtime counterpart — there is nothing to derive from. The identical
 * situation `agentInbox.validation.ts` documents for `ConversationStatus`.
 *
 * `satisfies` ties the literal list back to the type anyway, so a fourth
 * status added to `membership.model.ts` fails to compile here until this file
 * decides whether a request may name it.
 *
 * `invited` IS ABSENT, and that absence is the decision (ADR-027 §3,
 * ADR-029 §3). An invitation is accepted by the invitee; a manager writing
 * `invited` onto an active membership would be manufacturing a pending
 * invitation that nobody sent and nobody can accept. The email-backed flow
 * will own that value and will not reach it through this route.
 */
export const SETTABLE_STATUSES = ["active", "suspended"] as const satisfies readonly MembershipStatus[];

/**
 * `PATCH /organizations/:organizationId/members/:membershipId/status`
 * (ADR-029 §1, §4).
 *
 * The path names the field being changed and the body carries the value —
 * ADR-026 §2's shape, identical to the sibling `/role` route above and to
 * `PATCH …/conversations/:id/status`.
 *
 * One field, and what it does NOT carry is the security property. There is no
 * `membershipId` (it is the path segment), no `organizationId` (the mount
 * path), no `userId` or `role` (never the client's to state), and no
 * `currentStatus`: "only an active membership may be suspended" is checked
 * against the document the SERVER loaded, never against a client's claim about
 * what that document says (ADR-029 §4).
 */
export const updateMemberStatusSchema = z.object({
  status: z.enum(SETTABLE_STATUSES),
});

export type UpdateMemberStatusInput = z.infer<typeof updateMemberStatusSchema>;
