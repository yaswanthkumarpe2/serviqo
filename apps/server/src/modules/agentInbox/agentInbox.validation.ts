import { z } from "zod";

import { CONVERSATION_PAGE_DEFAULT_LIMIT, CONVERSATION_PAGE_MAX_LIMIT } from "../../config/constants";
import { OBJECT_ID_PATTERN, createMessageSchema, listMessagesQuerySchema } from "../widget/widgetConversation.validation";

import type { ConversationListCursor } from "../conversations/conversation.repository";

/**
 * Request schemas for the agent inbox routes (ADR-025 §5, §6).
 *
 * The message body schema and the message-history query schema are IMPORTED
 * from the widget module rather than re-declared. That is deliberate and it
 * is the point of ADR-025 §6: an agent's message body is bounded by the same
 * `MESSAGE_BODY_MAX_LENGTH`, trimmed the same way, and rejects the same
 * control characters as a customer's. Two copies of that schema would be two
 * places for the rule to drift, and the widget's copy is the one that already
 * has the reasoning attached.
 *
 * Critically, `createMessageSchema` names `body` and NOTHING else. A client
 * that posts `senderType`, `customerId`, or `organizationId` has those fields
 * STRIPPED by Zod before the controller runs (ADR-022 §5) — not rejected,
 * stripped, so a forged value cannot be observed downstream at all.
 */

export { OBJECT_ID_PATTERN };

/**
 * `POST /organizations/:organizationId/conversations/:conversationId/messages`.
 *
 * Re-exported under a name that says what it is on this surface. Same schema
 * object, so there is exactly one definition of "a valid message body" in the
 * codebase (ADR-025 §6).
 */
export const sendAgentMessageSchema = createMessageSchema;

export type SendAgentMessageInput = z.infer<typeof sendAgentMessageSchema>;

/** `GET .../conversations/:conversationId/messages` — identical contract to the widget's history read (ADR-022 §11). */
export const listAgentMessagesQuerySchema = listMessagesQuerySchema;

/**
 * The composite conversation-list cursor, as it travels over the wire
 * (ADR-025 §5): `<lastMessageAt ISO-8601>_<conversation id>`.
 *
 * Validated strictly rather than parsed leniently. A cursor reaching
 * `new Date(…)` unchecked yields `Invalid Date`, which Mongoose then casts
 * into a comparison that silently matches nothing — a page that comes back
 * empty for a reason no one can see. A malformed cursor is a 400 instead,
 * which is safe to answer specifically because it depends only on the
 * submitted string's shape and never on whether any conversation exists
 * (the same reasoning `widget.controller.ts` applies to `:conversationId`).
 */
const CONVERSATION_CURSOR_PATTERN = /^(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_(?<id>[0-9a-f]{24})$/i;

export const listConversationsQuerySchema = z.object({
  cursor: z
    .string()
    .regex(CONVERSATION_CURSOR_PATTERN, "cursor is not a valid conversation cursor")
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONVERSATION_PAGE_MAX_LIMIT, `limit must be at most ${CONVERSATION_PAGE_MAX_LIMIT}`)
    .optional()
    .default(CONVERSATION_PAGE_DEFAULT_LIMIT),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/**
 * Decodes a cursor the schema above already proved well-formed.
 *
 * Returns `undefined` for an absent cursor — "start at the beginning" — so
 * the caller has one value to pass through rather than a branch. The regex
 * guarantees both halves are present and shaped correctly, so this cannot
 * produce an `Invalid Date`.
 */
export function decodeConversationCursor(cursor: string | undefined): ConversationListCursor | undefined {
  if (cursor === undefined) return undefined;

  const groups = CONVERSATION_CURSOR_PATTERN.exec(cursor)?.groups;
  // Unreachable for a cursor that passed the schema; present because "cannot
  // happen" is doing work a check does more cheaply, and because the
  // alternative is a non-null assertion on a value derived from user input.
  if (groups === undefined) return undefined;

  return { lastMessageAt: new Date(groups.timestamp!), id: groups.id! };
}
