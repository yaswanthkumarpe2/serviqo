import { Types } from "mongoose";

import { MessageModel } from "./message.model";

import type { MessageAttachment } from "../attachments/attachmentResponses";
import type { MessageDocument, MessageSenderType } from "./message.model";

/** Mongoose casts a 24-char hex string to an ObjectId, so callers may pass either. */
type ObjectIdLike = Types.ObjectId | string;

export interface CreateMessageInput {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  customerId: ObjectIdLike;
  senderType: MessageSenderType;
  body: string;
  /** Pre-generated so attachments can be bound to it before it exists (ADR-041 §1). */
  _id?: Types.ObjectId;
  attachments?: MessageAttachment[];
}

export interface ListMessagesOptions {
  /** Exclusive lower bound — return messages with `_id` after this one (ADR-022 §11). */
  cursor?: ObjectIdLike;
  /** Row count to return. The caller (the service) decides the default/max. */
  limit: number;
}

/**
 * Message persistence (ADR-022 §4, §11).
 *
 * Every method takes `organizationId`; `list` and `create` both take
 * `conversationId` too, matching `conversationRepository`'s own discipline —
 * there is no `findAll` and no lookup that accepts fewer than the tenant
 * boundary this collection's every row carries.
 */
export const messageRepository = {
  /** Persists a message. Ownership of the conversation is the caller's (the service's) to prove first. */
  async create(input: CreateMessageInput): Promise<MessageDocument> {
    return MessageModel.create(input);
  },

  /**
   * Lists one conversation's messages, oldest first, keyset-paginated by
   * `_id` (ADR-022 §11).
   *
   * Requests `limit + 1` rows so the caller can tell whether a further page
   * exists without a separate `count()` — the extra row, if present, is the
   * service's to trim before building `nextCursor`.
   */
  async list(
    organizationId: ObjectIdLike,
    conversationId: ObjectIdLike,
    { cursor, limit }: ListMessagesOptions,
  ): Promise<MessageDocument[]> {
    const filter: Record<string, unknown> = { organizationId, conversationId };
    if (cursor !== undefined) {
      filter._id = { $gt: new Types.ObjectId(cursor) };
    }

    return MessageModel.find(filter).sort({ _id: 1 }).limit(limit + 1);
  },
};
