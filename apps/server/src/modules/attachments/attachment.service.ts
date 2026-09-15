import { randomBytes } from "node:crypto";

import mongoose, { Types } from "mongoose";

import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE } from "../../config/constants";
import {
  ConversationClosedError,
  ConversationNotAccessibleError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import { logger } from "../../lib/logger";
import { conversationRepository } from "../conversations/conversation.repository";
import { AttachmentModel } from "./attachment.model";
import { toAttachmentResponse } from "./attachmentResponses";
import { allowedTypeFor, extensionFor, sanitizeFileName } from "./fileTypes";

import type { AuthLogger } from "../auth/authLogging";
import type { ConversationDocument } from "../conversations/conversation.model";
import type { AttachmentDocument, AttachmentUploaderType } from "./attachment.model";
import type { AttachmentResponse, MessageAttachment } from "./attachmentResponses";

/**
 * Uploading, sending and serving chat attachments (ADR-041).
 *
 * Two steps, the way every chat does it: a file is uploaded into a conversation
 * first and gets an id; a message then names the ids it carries. That keeps a
 * message send a small JSON request, and an upload can fail or be abandoned
 * without anything being sent.
 */

const BUCKET_NAME = "attachments";

function bucket() {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error("Database is not connected");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

/** The same opaque refusal every unreachable conversation gets (ADR-022 §8). */
function requireReachable(conversation: ConversationDocument | null): ConversationDocument {
  if (conversation === null) throw new ConversationNotAccessibleError("Conversation not found");
  // Uploading into a closed conversation would only strand the file (ADR-026 §6).
  if (conversation.status === "closed") throw new ConversationClosedError("This conversation has been closed");
  return conversation;
}

export interface UploadedFile {
  contentType: string | undefined;
  fileName: string | undefined;
  bytes: Buffer;
}

async function store(
  conversation: ConversationDocument,
  uploaderType: AttachmentUploaderType,
  uploaderId: string,
  file: UploadedFile,
  log: AuthLogger,
): Promise<AttachmentResponse> {
  const type = allowedTypeFor(file.contentType);
  if (type === null) {
    throw new ValidationError("That type of file cannot be sent", [
      { field: "file", message: "Send an image (PNG, JPEG, GIF or WebP), a PDF, or a text file" },
    ]);
  }
  if (file.bytes.length === 0) {
    throw new ValidationError("The file is empty", [{ field: "file", message: "The file is empty" }]);
  }
  if (file.bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new ValidationError("The file is too large", [
      { field: "file", message: `Files can be at most ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB` },
    ]);
  }
  // The claimed type must match the bytes, so a script cannot arrive labelled as a picture.
  if (!type.matches(file.bytes)) {
    throw new ValidationError("The file does not match its type", [
      { field: "file", message: "That file's contents do not match its type" },
    ]);
  }

  const organizationId = conversation.organizationId.toString();
  const conversationId = conversation._id.toString();
  const name = sanitizeFileName(file.fileName, extensionFor(type.contentType));
  const fileId = new Types.ObjectId();

  await new Promise<void>((resolve, reject) => {
    const upload = bucket().openUploadStreamWithId(fileId, name, {
      metadata: { organizationId, conversationId },
    });
    upload.once("finish", () => resolve());
    upload.once("error", reject);
    upload.end(file.bytes);
  });

  const accessKey = randomBytes(32).toString("base64url");
  let attachment: AttachmentDocument;
  try {
    attachment = await AttachmentModel.create({
      organizationId,
      conversationId,
      uploaderType,
      uploaderId,
      fileId,
      name,
      contentType: type.contentType,
      size: file.bytes.length,
      accessKey,
    });
  } catch (err) {
    // Never leave bytes nobody can reach.
    await bucket().delete(fileId).catch(() => undefined);
    throw err;
  }

  log.info(
    {
      event: "attachment.uploaded",
      organizationId,
      conversationId,
      attachmentId: attachment._id.toString(),
      uploaderType,
      size: file.bytes.length,
      contentType: type.contentType,
    },
    "Attachment uploaded",
  );

  return toAttachmentResponse({
    id: attachment._id,
    name,
    contentType: type.contentType,
    size: file.bytes.length,
    accessKey,
  });
}

export const attachmentService = {
  /** A visitor uploads into their own open conversation. */
  async uploadForCustomer(
    organizationId: string,
    customerId: string,
    conversationId: string,
    file: UploadedFile,
    log: AuthLogger = logger,
  ): Promise<AttachmentResponse> {
    const conversation = requireReachable(
      await conversationRepository.findByIdForCustomer(conversationId, organizationId, customerId),
    );
    return store(conversation, "customer", customerId, file, log);
  },

  /** An agent uploads into an open conversation of their own organisation. */
  async uploadForAgent(
    organizationId: string,
    userId: string,
    conversationId: string,
    file: UploadedFile,
    log: AuthLogger = logger,
  ): Promise<AttachmentResponse> {
    const conversation = requireReachable(
      await conversationRepository.findByIdForOrganization(conversationId, organizationId),
    );
    return store(conversation, "agent", userId, file, log);
  },

  /**
   * Binds uploaded attachments to a message that is about to be created, in
   * one conditional update (ADR-041 §1).
   *
   * Every id must belong to this organisation and conversation, have been
   * uploaded by the same side, and not already be in a message. If any is
   * not, nothing stays bound and the send is refused, so a file cannot be sent
   * twice or borrowed from another conversation.
   */
  async claimForMessage(input: {
    attachmentIds: string[];
    organizationId: string;
    conversationId: string;
    uploaderType: AttachmentUploaderType;
    messageId: Types.ObjectId;
  }): Promise<MessageAttachment[]> {
    const ids = [...new Set(input.attachmentIds)];
    if (ids.length === 0) return [];
    if (ids.length > ATTACHMENTS_PER_MESSAGE || ids.some((id) => !Types.ObjectId.isValid(id))) {
      throw new ValidationError("Request validation failed", [{ field: "attachmentIds", message: "Invalid attachments" }]);
    }

    const result = await AttachmentModel.updateMany(
      {
        _id: { $in: ids },
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        uploaderType: input.uploaderType,
        messageId: null,
      },
      { $set: { messageId: input.messageId } },
    );

    if (result.modifiedCount !== ids.length) {
      await this.release(input.messageId);
      throw new ValidationError("Request validation failed", [
        { field: "attachmentIds", message: "One or more attachments could not be sent" },
      ]);
    }

    const claimed = await AttachmentModel.find({ _id: { $in: ids }, messageId: input.messageId }).select("+accessKey");
    // In the order the sender chose.
    return ids.map((id) => {
      const attachment = claimed.find((entry) => entry._id.toString() === id)!;
      return {
        id: attachment._id,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        accessKey: attachment.accessKey,
      };
    });
  },

  /** Releases attachments bound to a message whose creation then failed. */
  async release(messageId: Types.ObjectId): Promise<void> {
    await AttachmentModel.updateMany({ messageId }, { $set: { messageId: null } });
  },

  /**
   * Finds a file for download (ADR-041 §3). The key must match, and the file
   * must already be in a message: an uploaded-but-unsent file is not served,
   * so an upload cannot be used as free file hosting.
   */
  async findForDownload(attachmentId: string, key: unknown): Promise<AttachmentDocument> {
    if (!Types.ObjectId.isValid(attachmentId) || typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      throw new NotFoundError("File not found");
    }
    const attachment = await AttachmentModel.findOne({ _id: attachmentId, accessKey: key, messageId: { $ne: null } });
    if (attachment === null) throw new NotFoundError("File not found");
    return attachment;
  },

  openDownloadStream(fileId: Types.ObjectId) {
    return bucket().openDownloadStream(fileId);
  },
};
