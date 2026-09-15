import { formatFileSize, splitLinks } from "./linkify";

import type { InboxAttachment } from "./inboxApi";
import type { ReactNode } from "react";

/**
 * Message text with clickable links, and attachments, for the inbox (ADR-041 §6).
 *
 * React escapes text, and a link's `href` is only ever an http(s) URL that
 * parsed, so a `javascript:` URL renders as plain text.
 */

export function LinkifiedText({ text }: { text: string }): ReactNode {
  return splitLinks(text).map((part, index) =>
    part.type === "text" ? (
      part.value
    ) : (
      <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow">
        {part.value}
      </a>
    ),
  );
}

/** A picture opens full size in a new tab; any other file is a named download card. */
export function AttachmentView({ attachment }: { attachment: InboxAttachment }) {
  if (attachment.contentType.startsWith("image/")) {
    return (
      <a className="inbox__image" href={attachment.url} target="_blank" rel="noopener noreferrer">
        <img src={attachment.url} alt={attachment.name} loading="lazy" />
      </a>
    );
  }

  return (
    <a className="inbox__file" href={attachment.url} download={attachment.name} target="_blank" rel="noopener noreferrer">
      <FileIcon />
      <span className="inbox__fileName">{attachment.name}</span>
      <span className="inbox__fileSize">{formatFileSize(attachment.size)}</span>
    </a>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
