/**
 * Which files may be sent in a chat, and how to tell they are what they claim
 * (ADR-041 §2).
 *
 * An allowlist, not a blocklist: images people screenshot, PDFs people are
 * asked for, and plain text. Everything else — HTML, SVG, scripts, archives,
 * office documents with macros — is refused. SVG in particular is excluded
 * because it is a document that can carry script, not a picture.
 */

export interface AllowedFileType {
  contentType: string;
  /** Shown inline (images) or downloaded (everything else). */
  inline: boolean;
  /** Checks the first bytes match the claimed type. */
  matches(bytes: Buffer): boolean;
}

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

export const ALLOWED_FILE_TYPES: AllowedFileType[] = [
  { contentType: "image/png", inline: true, matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", inline: true, matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { contentType: "image/gif", inline: true, matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    contentType: "image/webp",
    inline: true,
    matches: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
  { contentType: "application/pdf", inline: false, matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
  {
    contentType: "text/plain",
    inline: false,
    // Text has no signature; refuse anything with NUL bytes, which text never contains.
    matches: (b) => !b.subarray(0, 8192).includes(0),
  },
];

export function allowedTypeFor(contentType: string | undefined): AllowedFileType | null {
  const bare = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return ALLOWED_FILE_TYPES.find((type) => type.contentType === bare) ?? null;
}

/**
 * A filename safe to store and to put in a header: no path, no control
 * characters, no quotes, bounded length, never empty.
 */
export function sanitizeFileName(raw: string | undefined, fallbackExtension: string): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded; use as given.
  }
  name = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  name = name.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot).slice(0, 10) : "";
    name = name.slice(0, 120 - extension.length) + extension;
  }
  return name.length > 0 ? name : `file.${fallbackExtension}`;
}

export function extensionFor(contentType: string): string {
  return contentType.split("/")[1]?.replace("jpeg", "jpg").replace("plain", "txt") ?? "bin";
}
