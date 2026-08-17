import { z } from "zod";

/**
 * Request schemas for the organizations module (ADR-016 §5).
 *
 * Deliberately not sharing `auth.validation.ts`'s name field. The two look
 * alike and are validated for different reasons: a person's name is bounded
 * and control-stripped because it reaches an email envelope, where a bare CR
 * is a header-injection primitive, while an organization's name is bounded
 * because it becomes a URL segment and a tenant label. They will diverge —
 * organization names will grow a uniqueness-adjacent policy long before
 * person names do — and merging them now would mean unpicking that later.
 *
 * The one rule genuinely shared is the control-character rejection, restated
 * below rather than imported, so this module does not depend on the auth
 * module for a regex.
 */

/**
 * Long enough for a real legal entity name, short enough that it cannot be
 * used to store content. `express.json()`'s body limit already caps the
 * request; this caps the field.
 */
const NAME_MAX_LENGTH = 100;

/**
 * C0 and C1 control characters, including DEL.
 *
 * An organization name is rendered in the dashboard, will appear in the
 * widget, and lands in exports and notification subjects. None of those want
 * a bare CR or a NUL, and rejecting them at the boundary is cheaper than
 * escaping them at every sink.
 *
 * Deliberately narrow, matching the convention `auth.validation.ts` set: no
 * case folding, no Unicode normalization, no script restrictions. A tenant's
 * name belongs to the tenant. Slug generation does its own folding
 * (`organizationSlug.ts`) and never writes back to the name.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Creating an organization takes a name and nothing else (ADR-016 §1, §5).
 *
 * There is no `slug` field: the slug is derived server-side, so a client
 * cannot squat on a URL segment, and there is no second identifier to
 * validate or collide.
 *
 * There is no `ownerUserId`, and there must never be one. The owner is the
 * verified access token's subject; an endpoint that accepted an owner id
 * would let any authenticated caller mint a tenant owned by someone else.
 * Zod object schemas strip unrecognized keys (`middleware/validate.ts`), so a
 * client that sends one is not rejected — the field simply never reaches the
 * service, which is the stronger guarantee.
 */
export const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Organization name is required")
    .max(NAME_MAX_LENGTH, `Organization name must be at most ${NAME_MAX_LENGTH} characters`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), "Organization name must not contain control characters"),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
