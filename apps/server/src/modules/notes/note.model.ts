import { Schema, model } from "mongoose";

import { MESSAGE_BODY_MAX_LENGTH } from "../../config/constants";

import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * An internal note on a conversation (ADR-042 §2).
 *
 * Its own collection, deliberately NOT a `Message` with a third `senderType`.
 * Every customer-facing read — widget history, the socket's conversation room,
 * `toMessageResponse` — reads `Message`, so a note cannot reach a customer
 * through any of them: there is no filter to forget, because notes are not in
 * the data those paths read.
 */
export interface NoteAttrs {
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  authorUserId: Types.ObjectId;
  body: string;
  /** Teammates the author @mentioned; each was an active member when the note was written. */
  mentionedUserIds: Types.ObjectId[];
  createdAt: Date;
}

export type NoteDocument = HydratedDocument<NoteAttrs>;

const noteSchema = new Schema<NoteAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, immutable: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, immutable: true },
    authorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    body: { type: String, required: true, trim: true, maxlength: MESSAGE_BODY_MAX_LENGTH, immutable: true },
    mentionedUserIds: { type: [Schema.Types.ObjectId], default: [], immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

noteSchema.index({ organizationId: 1, conversationId: 1, _id: 1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
noteSchema.set("toJSON", { transform: stripInternalFields });
noteSchema.set("toObject", { transform: stripInternalFields });

export const NoteModel: Model<NoteAttrs> = model<NoteAttrs>("Note", noteSchema);
