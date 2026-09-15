import type { WidgetAttachment } from "./types";

/**
 * Message text with clickable links, and file attachments, built as DOM
 * (ADR-041 §6).
 *
 * Still never `innerHTML` (ADR-022 §9): text goes in as text nodes, and a link
 * is an `<a>` whose `href` is set only after the URL parses as http or https.
 * A `javascript:` URL can never become a link, because it never matches.
 */

export type TextPart = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:'"]+$/;

/** Splits text into plain runs and http(s) links. Pure, so both apps' tests pin one behaviour. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    let raw = match[0];
    const start = match.index;

    // A sentence's full stop, or the bracket around "(see https://x.com)", is not part of the link.
    raw = raw.replace(TRAILING_PUNCTUATION, "");
    if (raw.endsWith(")") && !raw.includes("(")) raw = raw.slice(0, -1);

    const href = safeHref(raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw);
    if (href === null) continue;

    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "link", value: raw, href });
    last = start + raw.length;
  }

  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Appends text to `parent`, with links as anchors that open in a new tab and send no referrer. */
export function appendRichText(parent: HTMLElement, text: string): void {
  for (const part of splitLinks(text)) {
    if (part.type === "text") {
      parent.appendChild(document.createTextNode(part.value));
      continue;
    }
    const anchor = document.createElement("a");
    anchor.href = part.href;
    anchor.textContent = part.value;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer nofollow";
    parent.appendChild(anchor);
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FILE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

/**
 * One attachment inside a bubble: a picture shown small and opened full size
 * on click, or a file card with its name and size.
 *
 * `resolveUrl` turns the server's `/api/v1/files/…` path into an absolute URL
 * on the API's origin, which is not the page's origin when the widget is embedded.
 */
export function createAttachmentElement(attachment: WidgetAttachment, resolveUrl: (path: string) => string): HTMLElement {
  const href = resolveUrl(attachment.url);
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  if (attachment.contentType.startsWith("image/")) {
    link.className = "msg__image";
    const image = document.createElement("img");
    image.src = href;
    image.alt = attachment.name;
    image.loading = "lazy";
    link.appendChild(image);
    return link;
  }

  link.className = "msg__file";
  link.setAttribute("download", attachment.name);
  const icon = document.createElement("span");
  icon.className = "msg__fileIcon";
  icon.innerHTML = FILE_ICON;
  const name = document.createElement("span");
  name.className = "msg__fileName";
  name.textContent = attachment.name;
  const size = document.createElement("span");
  size.className = "msg__fileSize";
  size.textContent = formatFileSize(attachment.size);
  link.append(icon, name, size);
  return link;
}

/** A small, dependency-free set of the emoji people actually use in support chats. */
export const EMOJI = [
  "😀", "😂", "😊", "😍", "🤔", "😅", "😢", "😡",
  "👍", "👎", "👏", "🙏", "👋", "🙌", "💪", "🤝",
  "❤️", "🎉", "✅", "❌", "⚠️", "⭐", "🔥", "💡",
  "📦", "🚚", "💳", "🧾", "📎", "📷", "⏰", "📞",
];
