/**
 * Links, file sizes and emoji for the inbox (ADR-041 §6).
 *
 * `splitLinks` mirrors `apps/web/src/widget/richText.ts`. It is restated
 * rather than imported because the widget bundle shares no code with the
 * dashboard (ADR-021 §2); both copies have tests pinning the same cases.
 */

export type TextPart = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:'"]+$/;

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    let raw = match[0];
    const start = match.index;

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

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The same small set the widget offers (ADR-041 §6). */
export const EMOJI = [
  "😀", "😂", "😊", "😍", "🤔", "😅", "😢", "😡",
  "👍", "👎", "👏", "🙏", "👋", "🙌", "💪", "🤝",
  "❤️", "🎉", "✅", "❌", "⚠️", "⭐", "🔥", "💡",
  "📦", "🚚", "💳", "🧾", "📎", "📷", "⏰", "📞",
];
