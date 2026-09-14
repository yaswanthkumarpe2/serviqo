import { z } from "zod";

import { isWellFormedWidgetKey } from "../organizations/widgetConfig";

/**
 * Request schemas for the widget module (ADR-019 §12).
 *
 * The most important property of this file is what it does NOT accept.
 * `middleware/validate.ts` replaces `req.body` with the schema's output, and
 * Zod object schemas strip unrecognized keys — so a client that sends
 * `organizationId`, `customerId`, `userId`, `role`, `sessionId`, or
 * `permissions` is not rejected: the field simply never reaches the service.
 * That is the stronger guarantee, and it is the same instrument
 * `organization.validation.ts` relies on to make `ownerUserId` unreachable.
 *
 * A caller identifies a tenant through `widgetKey` and identifies themselves
 * through `visitorToken`. There is no third way to say who or where you are,
 * which is ADR-010 §7's "organizationId is derived server-side from the
 * widget credential, never read from the request body" enforced by the shape
 * of the input rather than by a check.
 */

/**
 * Long enough for a real name, short enough that the field cannot be used to
 * store content. `express.json()`'s body limit caps the request; this caps
 * the field.
 */
const NAME_MAX_LENGTH = 100;

/**
 * RFC 5321's practical maximum. Matching the bound a mail system would apply
 * anyway, so an address that could never be delivered to is refused here
 * rather than stored.
 */
const EMAIL_MAX_LENGTH = 254;

/**
 * C0 and C1 control characters, including DEL — the one rule genuinely shared
 * with `auth.validation.ts` and `organization.validation.ts`, restated rather
 * than imported so this module does not depend on another for a regex (the
 * convention `organization.validation.ts` set).
 *
 * These values reach an agent's screen, an export, and eventually an email
 * envelope, where a bare CR is a header-injection primitive. Rejecting them
 * at the boundary is cheaper than escaping them at every sink.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * A JWT is three base64url segments separated by dots. Bounded so a
 * megabyte-long "token" is refused before `jose` is asked to parse it, and
 * shape-checked so an obviously-not-a-token value never reaches the verifier.
 *
 * This is NOT a security check — the verifier is (`widgetToken.ts`). A value
 * that passes here is still unauthenticated text until its signature says
 * otherwise.
 */
const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN_MAX_LENGTH = 4096;

/**
 * A visitor key is exactly what `generateSecret` produces: 32 bytes as
 * base64url, 43 characters (ADR-038 §3). Anything else cannot be one, so it is
 * refused as a shape error before a hash is computed or a query runs.
 */
const VISITOR_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Deliberately permissive: digits, spaces and the punctuation people type in
 * phone numbers, with an optional leading plus. It is contact detail offered by
 * the visitor, never dialled by Serviqo and never a lookup key, so the check
 * exists to bound length and keep control characters out — not to decide what
 * a valid number in some country looks like.
 */
const PHONE_PATTERN = /^\+?[0-9 ().-]{5,32}$/;

/**
 * Opening a widget session takes a widget key, and optionally a previous
 * token and the details a visitor typed.
 *
 * `widgetKey` is shape-checked here so a malformed value is refused at the
 * HTTP boundary as a 400, before any database lookup. That distinction is
 * safe to expose: it depends only on the submitted string's form, never on
 * whether any tenant exists (ADR-019 §12).
 *
 * `name` and `email` are optional because an anonymous visitor supplies
 * neither and must still be served (ADR-019 §7). An empty string is
 * normalized away to `undefined` rather than stored, so a widget sending
 * empty inputs does not overwrite what the visitor typed earlier with
 * nothing.
 */
export const createWidgetSessionSchema = z.object({
  widgetKey: z
    .string()
    .min(1, "widgetKey is required")
    .refine(isWellFormedWidgetKey, "widgetKey is not a valid widget key"),

  /*
    The visitor's own previous credential, offered so the session can resume
    the customer it names (ADR-019 §6). Optional in every sense: absent,
    expired, forged, or belonging to another tenant all lead to a new
    anonymous customer rather than to an error.

    This is the ONLY slot in the request that says who the caller is, and it
    is a signed token rather than an id. A `customerId` field here would be an
    impersonation primitive; there is deliberately none, and Zod strips one
    that is sent.
  */
  visitorToken: z
    .string()
    .max(TOKEN_MAX_LENGTH)
    .refine((value) => COMPACT_JWT_PATTERN.test(value), "visitorToken is not a well-formed token")
    .optional(),

  /*
    The visitor's long-lived key (ADR-038 §3), offered so a visitor whose
    token has expired can still continue their conversation. Optional, and
    handled like `visitorToken`: a key that matches nothing in this
    organisation leads to a new anonymous customer, never to an error.
  */
  visitorKey: z
    .string()
    .refine((value) => VISITOR_KEY_PATTERN.test(value), "visitorKey is not a well-formed key")
    .optional(),

  name: z
    .string()
    .trim()
    .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), "name must not contain control characters")
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),

  /*
    Validated as an address and stored as an attribute — never used to find a
    customer (ADR-019 §5). `z.email()` plus the length bound; no MX check and
    no deliverability probe, which would be a network call on a public
    unauthenticated path.
  */
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
    .pipe(z.email("email must be a valid email address"))
    .transform((value) => value.toLowerCase())
    .optional(),

  phone: z
    .string()
    .trim()
    .refine((value) => value.length === 0 || PHONE_PATTERN.test(value), "phone must be a phone number")
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),
});

export type CreateWidgetSessionInput = z.infer<typeof createWidgetSessionSchema>;
