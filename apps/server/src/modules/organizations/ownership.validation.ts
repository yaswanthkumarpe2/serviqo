import { z } from "zod";

/**
 * The request schema for ownership transfer (ADR-028 §1, §4).
 *
 * One field, and what the schema does NOT name is the security property. There
 * is no `organizationId`, no `currentOwnerId`, no `userId`, no `role`, and no
 * `status`. Zod object schemas strip unrecognized keys (`middleware/validate.ts`),
 * so a client that sends any of them has it STRIPPED rather than rejected — a
 * forged value never becomes observable to a controller at all, which is the
 * stronger of the two outcomes and the reason no handler in this slice contains
 * a comparison defending against one.
 *
 * That is ADR-022 §5's rule — "assigned as a literal … never a parameter that
 * traces back to request input" — applied to identity for the third time, after
 * ADR-026 applied it to conversation assignment and ADR-027 §4 to the member
 * routes. The acting organization comes from `req.organizationContext`, which
 * `requireOrganization` built from the PATH segment; the acting owner comes
 * from `req.principal` and from the membership document that same middleware
 * loaded on this request.
 */

/**
 * A 24-character hex ObjectId.
 *
 * Restated here rather than imported from `member.validation.ts`: this module
 * is the organizations domain, and depending on the members module for a regex
 * would be a cross-domain import for four characters of pattern. The same
 * restating `organization.validation.ts` already does with the control-character
 * rule it shares with `auth.validation.ts`, and for the same reason.
 *
 * Checked in the SCHEMA rather than in the service, so a malformed id is a
 * `400 VALIDATION_ERROR` before any query runs. A malformed value reaching
 * `Mongoose.findOne` raises a `CastError`, which `errorHandler` turns into a
 * generic `500` — reporting a client's mistyped id as a server fault.
 *
 * Answering `400` specifically is safe: it depends only on the submitted
 * string's shape, never on whether any membership exists, so it is not an
 * existence oracle (ADR-028 §5).
 */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * `POST /organizations/:organizationId/ownership`.
 *
 * `membershipId` rather than `userId`, and that is deliberate. A `User` id is
 * global and carries no tenancy of its own; a `Membership` id is tenant-scoped
 * by construction, which is what lets the service resolve it with the
 * two-key query that makes cross-tenant isolation a property of the query
 * rather than of a comparison (ADR-027 §9, ADR-028 §5).
 *
 * The target is a body field here and a path segment on every other
 * membership-targeting route. ADR-028 §1 argues the departure: the path already
 * names the resource being changed — this organization's ownership, of which
 * there is exactly one — so the body carries the value, the same shape
 * `PUT …/widget-config/origins` has.
 */
export const transferOwnershipSchema = z.object({
  membershipId: z
    .string()
    .trim()
    .regex(OBJECT_ID_PATTERN, "membershipId is not a valid id"),
});

export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
