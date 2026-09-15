import type { Types } from "mongoose";

/**
 * What a message stores about each file it carries (ADR-041 §1), copied from
 * the `Attachment` document when the message is sent. A message never changes
 * afterwards, so a copy is safe and saves a lookup on every history read.
 */
export interface MessageAttachment {
  id: Types.ObjectId;
  name: string;
  contentType: string;
  size: number;
  accessKey: string;
}

/**
 * The download path for a file. Relative to the API origin: the web app calls
 * the API on its own origin, and the embedded widget resolves it against the
 * API base it was configured with.
 *
 * The name is in the path only so a saved file and a browser tab read
 * sensibly; the server ignores it and serves by id and key.
 */
export function attachmentUrl(attachment: { id: Types.ObjectId | string; name: string; accessKey: string }): string {
  return `/api/v1/files/${attachment.id.toString()}/${encodeURIComponent(attachment.name)}?key=${attachment.accessKey}`;
}

/** The client-facing shape: never the raw key field, only the URL that carries it. */
export function toAttachmentResponse(attachment: MessageAttachment) {
  return {
    id: attachment.id.toString(),
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    url: attachmentUrl(attachment),
  };
}

export type AttachmentResponse = ReturnType<typeof toAttachmentResponse>;
