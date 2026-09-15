import { Schema, model } from "mongoose";

import { MESSAGE_BODY_MAX_LENGTH } from "../../config/constants";

import type { HydratedDocument, Model, Types } from "mongoose";

/**
 * A reply an organisation writes once and sends many times (ADR-042 §1).
 *
 * Owned by the organisation, not by the person who wrote it: a team's answers
 * to "where is my order?" should not disappear when that person leaves.
 */
export interface SavedReplyAttrs {
  organizationId: Types.ObjectId;
  /** What an agent types after `/` to find it, e.g. `refund`. Unique per organisation. */
  shortcut: string;
  title: string;
  body: string;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type SavedReplyDocument = HydratedDocument<SavedReplyAttrs>;

export const SAVED_REPLY_SHORTCUT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const savedReplySchema = new Schema<SavedReplyAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, immutable: true },
    shortcut: { type: String, required: true, trim: true, lowercase: true, match: SAVED_REPLY_SHORTCUT_PATTERN },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    body: { type: String, required: true, trim: true, maxlength: MESSAGE_BODY_MAX_LENGTH },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  },
  { timestamps: true },
);

savedReplySchema.index({ organizationId: 1, shortcut: 1 }, { unique: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose's transform-hook type is impractical to hand-type precisely.
function stripInternalFields(_doc: any, ret: any) {
  delete ret.__v;
  return ret;
}
savedReplySchema.set("toJSON", { transform: stripInternalFields });
savedReplySchema.set("toObject", { transform: stripInternalFields });

export const SavedReplyModel: Model<SavedReplyAttrs> = model<SavedReplyAttrs>("SavedReply", savedReplySchema);
