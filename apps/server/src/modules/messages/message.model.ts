import { Schema, model } from "mongoose";

import { MESSAGE_BODY_MAX_LENGTH } from "../../config/constants";

import type { MessageAttachment } from "../attachments/attachmentResponses";
import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * A Message is one entry in a Conversation (ADR-022 §4). Serviqo's third
 * tenant-owned resource model, inheriting the same scoping discipline
 * `Customer` and `Conversation` already established.
 */
export type MessageSenderType = "customer" | "agent";

export interface MessageAttrs {
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  /**
   * WHICH customer this conversation is with — copied from the owning
   * `Conversation` at creation, present on every message regardless of
   * `senderType`. Not "who sent this"; that is `senderType`'s job
   * (ADR-022 §4).
   */
  customerId: Types.ObjectId;
  /**
   * Who sent this message. Two values exist today; no route in this slice
   * can produce `"agent"` (ADR-022 §5) — the model supporting a value and an
   * endpoint being able to assign it are deliberately separate questions.
   */
  senderType: MessageSenderType;
  /** Empty when the message is only attachments (ADR-041 §1). */
  body: string;
  /** Files sent with the message, copied at send time (ADR-041 §1). */
  attachments: MessageAttachment[];
  createdAt: Date;
}

export type MessageDocument = HydratedDocument<MessageAttrs>;

const messageSchema = new Schema<MessageAttrs>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      immutable: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      immutable: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      immutable: true,
    },
    senderType: {
      type: String,
      enum: ["customer", "agent"] satisfies MessageSenderType[],
      required: true,
      immutable: true,
    },
    /*
      Trimmed and bounded here too, not only at the Zod boundary
      (ADR-022 §9) — this model's own defense for the day a second caller
      (the eventual AI_AGENT/SYSTEM sender) writes through the service
      without passing through this HTTP boundary at all. One shared
      constant, two enforcement points, matching how `allowedOrigins`
      validation already runs at both layers (ADR-020 §3).
    */
    body: {
      type: String,
      // Text is optional only when the message carries files (ADR-041 §1).
      required: [
        function (this: { attachments?: unknown[] }) {
          return (this.attachments?.length ?? 0) === 0;
        },
        "body is required",
      ],
      default: "",
      trim: true,
      maxlength: MESSAGE_BODY_MAX_LENGTH,
      immutable: true,
    },
    attachments: {
      type: [
        new Schema<MessageAttachment>(
          {
            id: { type: Schema.Types.ObjectId, ref: "Attachment", required: true },
            name: { type: String, required: true },
            contentType: { type: String, required: true },
            size: { type: Number, required: true },
            accessKey: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
      immutable: true,
    },
  },
  {
    /*
      No updatedAt: messages are immutable in this slice — no edit, no
      delete — so it would be a field nothing ever writes and nothing ever
      reads (ADR-022 §4).
    */
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/**
 * Serves the one read this slice performs: a conversation's messages, in
 * order, paginated (ADR-022 §11).
 *
 * Trailing `_id` — not `createdAt` — is what makes this a single covering
 * index for both the equality filter (both ids) and the ranged, sorted scan
 * (`_id > cursor`, ascending) the message list query performs; see
 * `message.repository.ts` and ADR-022 §11 for why `_id` rather than
 * `createdAt` is the ordering key.
 */
messageSchema.index({ organizationId: 1, conversationId: 1, _id: 1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
messageSchema.set("toJSON", { transform: stripInternalFields });
messageSchema.set("toObject", { transform: stripInternalFields });

export const MessageModel: Model<MessageAttrs> = model<MessageAttrs>("Message", messageSchema);
