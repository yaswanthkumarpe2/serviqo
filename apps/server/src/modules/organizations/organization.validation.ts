import { z } from "zod";

import { isValidTimezone } from "./widgetAppearance";
import { normalizeOrigin } from "./widgetConfig";

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

/**
 * Replacing the allowed-origins list (ADR-020 §3).
 *
 * Taken verbatim from ADR-019 §10's own example — "a tenant with fifty
 * storefronts lists fifty origins" — rather than invented, matching
 * `config/constants.ts`'s rule that every bound in this codebase is either
 * derived or explicitly justified.
 */
const MAX_ALLOWED_ORIGINS = 50;

/**
 * Normalizes one entry with the exact function ADR-019 §10 defined and the
 * model's own setter uses, rather than a second implementation of what an
 * origin is. A value that is not an origin at all — a path, a query, a
 * fragment, userinfo, a non-http(s) scheme, or any wildcard — fails here as
 * a field-level issue, before any database call.
 */
const allowedOriginSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeOrigin(value);
  if (normalized === null) {
    ctx.addIssue({
      code: "custom",
      message: "must be an http(s) origin with no path, query, fragment, userinfo, or wildcard",
    });
    return z.NEVER;
  }
  return normalized;
});

/**
 * Replacing the whole list, never adding or removing one entry (ADR-020 §3).
 * The frontend computes the next array locally and sends it whole, so a
 * dropped request cannot leave a stale entry active the way a lost `DELETE`
 * could.
 *
 * Duplicates are rejected rather than silently deduplicated, checked AFTER
 * normalization so `https://Shop.example.com` and
 * `https://shop.example.com/` are caught as the same entry — a boundary that
 * quietly edited a caller's input is one a caller could not trust to store
 * what it sent.
 *
 * An empty array is valid and means "no website may embed this widget"
 * (ADR-019 §10) — this endpoint is how a tenant reaches that state on
 * purpose, not a case rejected here.
 */
export const replaceAllowedOriginsSchema = z.object({
  allowedOrigins: z
    .array(allowedOriginSchema)
    .max(MAX_ALLOWED_ORIGINS, `allowedOrigins must contain at most ${MAX_ALLOWED_ORIGINS} entries`)
    .refine(
      (origins) => new Set(origins).size === origins.length,
      "allowedOrigins must not contain duplicate origins",
    ),
});

export type ReplaceAllowedOriginsInput = z.infer<typeof replaceAllowedOriginsSchema>;

// ---- widget appearance (ADR-040 §1) ----

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `must be at most ${max} characters`)
    .refine((value) => !CONTROL_CHARACTERS.test(value.replace(/\n/g, "")), "must not contain control characters")
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();

const businessDaySchema = z
  .object({ open: z.string().regex(TIME_PATTERN, "use HH:MM"), close: z.string().regex(TIME_PATTERN, "use HH:MM") })
  .strict()
  .refine((day) => day.open < day.close, "closing time must be after opening time")
  .nullable();

export const widgetAppearanceSchema = z
  .object({
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a colour like #14684A"),
    title: optionalText(60),
    welcomeMessage: optionalText(200),
    awayMessage: optionalText(200),
    businessHours: z
      .object({
        enabled: z.boolean(),
        timezone: z.string().refine(isValidTimezone, "timezone must be an IANA timezone such as Asia/Kolkata"),
        days: z.array(businessDaySchema).length(7, "days must list all seven days, Sunday first"),
      })
      .strict(),
  })
  .strict();

export type WidgetAppearanceInput = z.infer<typeof widgetAppearanceSchema>;
