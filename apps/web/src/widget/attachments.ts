import type { WidgetAttachment } from "./types";

/**
 * Uploading a file from the widget (ADR-041 §2).
 *
 * The file is the request body, its type is `Content-Type`, and its name goes
 * URI-encoded in `X-Filename`. The same bounds as the server are checked here
 * first, only so a visitor hears "too large" at once instead of after a
 * ten-megabyte upload; the server still enforces them.
 */

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 5;
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];

export class AttachmentError extends Error {}

/** A visitor-facing reason a file cannot be sent, or `null` if it can. */
export function problemWith(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Only images, PDFs and text files can be sent.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > ATTACHMENT_MAX_BYTES) return "Files can be at most 10 MB.";
  return null;
}

export function isWidgetAttachment(value: unknown): value is WidgetAttachment {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<WidgetAttachment>;
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.contentType === "string" &&
    typeof a.size === "number" &&
    typeof a.url === "string" &&
    a.url.startsWith("/api/v1/files/")
  );
}

export async function uploadAttachment(
  apiBase: string,
  token: string,
  conversationId: string,
  file: File,
): Promise<WidgetAttachment> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/conversations/${encodeURIComponent(conversationId)}/attachments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": file.type,
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
  } catch {
    throw new AttachmentError("The file couldn't be uploaded.");
  }

  const body: unknown = await response.json().catch(() => null);
  const data = (body as { success?: boolean; data?: unknown } | null)?.data;
  if (response.status === 413) throw new AttachmentError("Files can be at most 10 MB.");
  if (response.status === 409) throw new AttachmentError("CONVERSATION_CLOSED");
  if (!response.ok || !isWidgetAttachment(data)) throw new AttachmentError("The file couldn't be uploaded.");
  return data;
}
