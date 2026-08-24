import { z } from "zod";

import { MESSAGE_BODY_MAX_LENGTH, MESSAGE_PAGE_DEFAULT_LIMIT, MESSAGE_PAGE_MAX_LIMIT } from "../../config/constants";

/**
 * Request schemas for the widget conversation/message routes (ADR-022 §5,
 * §9, §11).
 *
 * The same instrument `widget.validation.ts` relies on for the session
 * endpoint: a Zod object schema names exactly the fields a caller may
 * supply, and `validateBody` (or the manual query parse below) replaces the
 * input with the schema's own output — so `organizationId`, `customerId`,
 * `senderType`, or `conversationId` sent in a body is not rejected, it is
 * STRIPPED, and never reaches a service (ADR-022 §5).
 */

/**
 * A 24-character hex ObjectId — the shape `requireOrganization.ts` and
 * `widgetToken.ts` already guard on. Exported so the controller can apply
 * the identical check to the `:conversationId` path parameter: a malformed
 * value reaching `Mongoose.findOne` raises a `CastError`, which
 * `errorHandler` turns into a generic 500 — a client's mistyped URL
 * reported as a server fault, the same failure this pattern exists
 * everywhere else in this codebase to prevent.
 */
export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * C0/C1 control characters EXCEPT tab and newline — deliberately narrower
 * than `widget.validation.ts`'s `CONTROL_CHARACTERS`, which blocks every
 * control character including newline. That is correct for the single-line
 * `name` field it validates; a chat message is legitimately multi-line, so
 * the two whitespace controls a body needs are excluded here (ADR-022 §9).
 *
 * Built from explicit code points rather than a `\\u little written inline,
 * so the pattern is unambiguous in source rather than relying on escape
 * sequences that are easy to mistype into something else entirely.
 */
const CONTROL_CODE_POINTS: number[] = [];
for (let code = 0x00; code <= 0x1f; code += 1) {
  if (code !== 0x09 && code !== 0x0a) CONTROL_CODE_POINTS.push(code);
}
CONTROL_CODE_POINTS.push(0x7f);
for (let code = 0x80; code <= 0x9f; code += 1) CONTROL_CODE_POINTS.push(code);

const DISALLOWED_CONTROL_CHARACTERS = new RegExp(
  `[${CONTROL_CODE_POINTS.map((code) => String.fromCharCode(code)).join("")}]`,
);

/**
 * `POST /widget/conversations` takes no body — resolving or creating the
 * caller's open conversation needs nothing beyond the identity the widget
 * token already asserts (ADR-022 §7).
 */
export const resolveConversationSchema = z.object({});

/**
 * `POST /widget/conversations/:id/messages`. `body` is the ONLY field a
 * client may supply; `senderType` is never a schema field on this route at
 * all (ADR-022 §5) — the service assigns the literal `"customer"` itself,
 * so there is no code path a client could reach with any other value.
 */
export const createMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "body is required")
    .max(MESSAGE_BODY_MAX_LENGTH, `body must be at most ${MESSAGE_BODY_MAX_LENGTH} characters`)
    .refine((value) => !DISALLOWED_CONTROL_CHARACTERS.test(value), "body must not contain control characters"),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

/**
 * `GET /widget/conversations/:id/messages` query parameters.
 *
 * Express 5 exposes `req.query` through a getter with no setter
 * (`middleware/validate.ts`'s own noted limitation), so this is parsed
 * directly in the controller rather than through a `validateQuery`
 * middleware that would have nowhere to write its result — the first
 * paginated endpoint in this codebase, and the first query-string schema.
 */
export const listMessagesQuerySchema = z.object({
  cursor: z
    .string()
    .regex(OBJECT_ID_PATTERN, "cursor is not a valid message id")
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_PAGE_MAX_LIMIT, `limit must be at most ${MESSAGE_PAGE_MAX_LIMIT}`)
    .optional()
    .default(MESSAGE_PAGE_DEFAULT_LIMIT),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
