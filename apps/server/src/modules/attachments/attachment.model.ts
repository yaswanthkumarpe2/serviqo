import { Schema, model } from "mongoose";

import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * A file sent in a conversation (ADR-041).
 *
 * The bytes live in GridFS (`attachments.files` / `attachments.chunks`), so an
 * organisation's uploads sit in the same database as its conversations and a
 * deployment needs no second storage service. This document is the metadata:
 * which organisation and conversation it belongs to, who uploaded it, and the
 * message it was eventually sent in.
 */

export type AttachmentUploaderType = "customer" | "agent";

export interface AttachmentAttrs {
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  uploaderType: AttachmentUploaderType;
  /** The customer's id or the agent's user id. */
  uploaderId: Types.ObjectId;
  /** The GridFS file holding the bytes. */
  fileId: Types.ObjectId;
  name: string;
  contentType: string;
  size: number;
  /**
   * 256 bits that make the download link unguessable (ADR-041 §3). A browser
   * cannot send a bearer token with `<img src>`, so the link itself is the
   * credential — the same model as a private share link.
   */
  accessKey: string;
  /** Set once, when the attachment is sent in a message. `null` while only uploaded. */
  messageId: Types.ObjectId | null;
  createdAt: Date;
}

export type AttachmentDocument = HydratedDocument<AttachmentAttrs>;

const attachmentSchema = new Schema<AttachmentAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, immutable: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, immutable: true },
    uploaderType: { type: String, enum: ["customer", "agent"], required: true, immutable: true },
    uploaderId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    fileId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    accessKey: { type: String, required: true, select: false },
    messageId: { type: Schema.Types.ObjectId, ref: "Message", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

attachmentSchema.index({ organizationId: 1, conversationId: 1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.accessKey;
  delete ret.__v;
  return ret;
}
attachmentSchema.set("toJSON", { transform: stripInternalFields });
attachmentSchema.set("toObject", { transform: stripInternalFields });

export const AttachmentModel: Model<AttachmentAttrs> = model<AttachmentAttrs>("Attachment", attachmentSchema);
