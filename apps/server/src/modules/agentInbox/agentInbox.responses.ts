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
    // Optional contact detail the visitor chose to give (ADR-038 §5).
    phone: customer.phone,
  };
}

/**
 * What an agent learns about the colleague a conversation is assigned to
 * (ADR-026 §11).
 *
 * The `id` is ALWAYS present and the `name` is not, and that split is the
 * whole decision. An inbox row must let an agent tell their own work from
 * someone else's — which the id does, compared client-side against the
 * reader's own user id — without disclosing the staff roster, which
 * `member.read` gates and which the `agent` role does not hold:
 *
 *   agent: ["organization.read", "conversation.read", "conversation.reply", "conversation.assign"]
 *
 * So `name` is resolved by the caller ONLY for a reader who holds
 * `member.read`, and is `null` otherwise. `null` also covers an assignee
 * whose membership in this tenant has since been revoked — that renders as an
 * assignment to someone no longer on the team, rather than as a name crossing
 * a boundary that has already closed.
 *
 * The `User` document is deliberately never passed here: an email address is
 * roster data of exactly the kind this projection exists to withhold, and a
 * function holding the document is one edit away from including it.
 */
export function toAssignedAgentResponse(assignee: { id: string; name: string | null } | null) {
  if (assignee === null) return null;

  return { id: assignee.id, name: assignee.name };
}

/**
 * Projects a `Conversation` for the agent inbox.
 *
 * `organizationId` is absent for the same reason the widget's projection
 * omits it: the caller named the tenant in the URL and the server proved it,
 * so echoing it back tells them nothing they did not supply.
 *
 * `assignedTo` is resolved by the CALLER rather than read off the document
 * here (ADR-026 §11), because turning an id into a name requires two batched
 * tenant-scoped queries and a `can()` check against the reader's role —
 * neither of which a per-row projection can perform without becoming an N+1
 * and a second place authorization is decided.
 */
export function toInboxConversationResponse(
  conversation: ConversationDocument,
  customer: CustomerDocument | null,
  assignee: { id: string; name: string | null } | null = null,
) {
  return {
    id: conversation._id.toString(),
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
    customer: toInboxCustomerResponse(customer),
    assignedTo: toAssignedAgentResponse(assignee),
    ...toReadStateResponse(conversation),
  };
}

/**
 * Projects the fields of a `Conversation` that a state change can alter
 * (ADR-026 §9) — the payload `conversation:updated` carries.
 *
 * Deliberately NARROWER than `toInboxConversationResponse`, and the omissions
 * are the decision:
 *
 * - **No `customer`.** It did not change, the receiving client already has
 *   it on the row, and including it would mean every claim broadcast carried
 *   a customer's name and email to every connected agent socket for no
 *   reason.
 * - **No assignee NAME**, only the id. A broadcast has no single reader, so
 *   there is no role to run `can(role, "member.read")` against — and a
 *   payload that cannot make that check must not carry the thing the check
 *   protects. The receiving client compares the id to its own user id, which
 *   is what it needs to re-render the row's controls; a name arrives on the
 *   next fetch, from a request that has a reader.
 *
 * `lastMessageAt` IS included: closing a conversation does not touch it, but
 * including it keeps the merge on the client a plain field replacement rather
 * than a per-field exception list.
 */
/** Unread and "seen" state (ADR-040 §4). */
export function toReadStateResponse(conversation: ConversationDocument) {
  return {
    unreadCount: conversation.unreadByAgents ?? 0,
    agentLastReadAt: conversation.agentLastReadAt ?? null,
    customerLastReadAt: conversation.customerLastReadAt ?? null,
  };
}

export function toConversationStateResponse(conversation: ConversationDocument) {
  return {
    id: conversation._id.toString(),
    status: conversation.status,
    lastMessageAt: conversation.lastMessageAt,
    assignedTo: conversation.assignedTo === null ? null : { id: conversation.assignedTo.toString(), name: null },
  };
}
