import type { ConversationDocument } from "../conversations/conversation.model";
import type { CustomerDocument } from "../customers/customer.model";

/**
 * Response projections for the staff-facing conversation surface
 * (ADR-025 §7).
 *
 * Deliberately NOT `widgetResponses.ts`'s projections, and the difference is
 * the decision rather than duplication. `toConversationResponse` there omits
 * `customerId` because the customer already knows who they are and echoing it
 * back discloses nothing. An agent's inbox row needs the opposite: WHICH
 * customer a conversation is with, or the list is unreadable.
 *
 * `toMessageResponse` is NOT re-declared here — it is imported from
 * `widgetResponses.ts` by every consumer, because
 * `{ id, conversationId, senderType, body, createdAt }` is the correct shape
 * for both audiences. ADR-023 §7 moved it out of the widget controller so a
 * second transport would call the same projection rather than a second copy;
 * a third consumer reusing it is that decision working.
 */

/**
 * What an agent learns about a customer from the inbox.
 *
 * Three fields, and the absences are the disclosure decision (ADR-025 §7):
 * the name and email the visitor typed into this tenant's own widget, and
 * nothing else. No `lastSeenAt`, no IP address, no user agent — `Customer`
 * stores none of the last two by design (`customer.model.ts` explains why),
 * so there is nothing here to leak even by accident.
 *
 * `null` for a customer the conversation points at that no longer resolves.
 * A conversation outliving its customer should render as a conversation with
 * an unknown participant, not as a 500 — the row is still real and its
 * messages are still readable.
 */
export function toInboxCustomerResponse(customer: CustomerDocument | null) {
  if (customer === null) return null;

  return {
    id: customer._id.toString(),
    name: customer.name,
    email: customer.email,
  };
}

/**
 * Projects a `Conversation` for the agent inbox.
 *
 * `organizationId` is absent for the same reason the widget's projection
 * omits it: the caller named the tenant in the URL and the server proved it,
 * so echoing it back tells them nothing they did not supply.
 */
export function toInboxConversationResponse(conversation: ConversationDocument, customer: CustomerDocument | null) {
  return {
    id: conversation._id.toString(),
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
    customer: toInboxCustomerResponse(customer),
  };
}
