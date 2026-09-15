import { toAttachmentResponse } from "../attachments/attachmentResponses";

import type { ConversationDocument } from "../conversations/conversation.model";
import type { MessageDocument } from "../messages/message.model";

/**
 * Response projections shared by every transport that speaks for the widget
 * principal — REST (`widget.controller.ts`) and Socket.IO
 * (`realtime/createSocketServer.ts`, ADR-023 §7). Moved out of the controller
 * so a second transport calls the same projection rather than a second copy
 * of it; the shape itself is unchanged from ADR-022 §13.
 */

/**
 * Projects a `Conversation` to what the widget needs (ADR-022 §13). No
 * `organizationId`, no `customerId` — the caller already knows both, they
 * hold the token, and echoing an identifier back to the party that supplied
 * it discloses nothing (the same minimalism `toSessionCustomer` in
 * `widgetSession.service.ts` established).
 */
export function toConversationResponse(conversation: ConversationDocument) {
  return {
    id: conversation._id.toString(),
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
    // When the team last read it, so the chat can show "Seen" (ADR-040 §4). No one's identity.
    agentLastReadAt: conversation.agentLastReadAt ?? null,
    unreadCount: conversation.unreadByCustomer ?? 0,
  };
}

/** Projects a `Message` to exactly the fields ADR-022 §13 names. */
export function toMessageResponse(message: MessageDocument) {
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    senderType: message.senderType,
    body: message.body ?? "",
    // Download links, never the raw keys (ADR-041 §3).
    attachments: (message.attachments ?? []).map(toAttachmentResponse),
    createdAt: message.createdAt,
  };
}
