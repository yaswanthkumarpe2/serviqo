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
  /**
   * The status filter (ADR-026 §5). Absent means both, which is ADR-025 §5's
   * behaviour unchanged — an inbox that hides rows by default is an inbox
   * whose emptiness cannot be trusted.
   */
  status: z.enum(["open", "closed"]).optional(),
  /**
   * The assignment filter (ADR-026 §5).
   *
   * `me` and `unassigned` are the ONLY two values, and the absence of a
   * user-id form is the decision. A `?assignee=<userId>` filter would be a
   * client naming a person, which forces the server to answer "may this
   * caller ask about that person?" — the roster-disclosure question §11 is
   * built to avoid. `me` is resolved from the verified principal in the
   * controller, so the only identity this filter can express is one the
   * server already proved.
   */
  assignee: z.enum(["me", "unassigned"]).optional(),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/**
 * `PATCH .../conversations/:conversationId/assignment` (ADR-026 §2).
 *
 * Names `action` and NOTHING else. There is deliberately no `assignedTo`,
 * no `userId`, and no `agentId` field — in this schema or in any other schema
 * in this codebase — so a client cannot express "assign this to someone else"
 * even malformedly. The subject of both verbs is the authenticated caller,
 * resolved server-side from `req.principal.userId`.
 *
 * That is ADR-022 §5's rule ("assigned as a literal … never a parameter that
 * traces back to request input") applied to IDENTITY rather than to
 * `senderType`: a forged `assignedTo` is not rejected here, it is stripped by
 * Zod before the controller runs, so it never becomes observable at all.
 */
export const updateAssignmentSchema = z.object({
  action: z.enum(["claim", "release"]),
});

export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;

/**
 * `PATCH .../conversations/:conversationId/status` (ADR-026 §2, §7).
 *
 * The two values of `Conversation.status`, and a separate `/reopen` route was
 * declined because "open" and "closed" are one field and a second endpoint
 * would be a second name for one write.
 *
 * Restated here as a literal enum rather than imported from
 * `conversation.model.ts`'s `ConversationStatus`: that type is a TypeScript
 * union with no runtime value, so a schema built from it would still have to
 * spell the strings out. The `satisfies` in the controller is what keeps the
 * two from drifting.
 */
export const updateConversationStatusSchema = z.object({
  status: z.enum(["open", "closed"]),
});

export type UpdateConversationStatusInput = z.infer<typeof updateConversationStatusSchema>;

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
