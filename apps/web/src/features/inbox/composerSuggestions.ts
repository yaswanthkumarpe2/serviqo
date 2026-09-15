import type { SavedReply, Teammate } from "./inboxApi";

/**
 * What the composer offers as the agent types (ADR-042 §1–2). Pure, so both
 * rules are tested without rendering.
 */

/** A draft that starts with `/word` is asking for saved replies matching `word`. */
export function savedReplyQuery(draft: string): string | null {
  const match = /^\/([a-z0-9_-]*)$/i.exec(draft);
  return match === null ? null : match[1]!.toLowerCase();
}

export function matchSavedReplies(replies: SavedReply[], query: string, limit = 6): SavedReply[] {
  const q = query.toLowerCase();
  const byShortcut = replies.filter((reply) => reply.shortcut.startsWith(q));
  const byTitle = replies.filter((reply) => !reply.shortcut.startsWith(q) && reply.title.toLowerCase().includes(q));
  return [...byShortcut, ...byTitle].slice(0, limit);
}

/** The `@name` being typed at the cursor, if any: its text and where it starts. */
export function mentionAt(draft: string, cursor: number): { query: string; start: number } | null {
  const before = draft.slice(0, cursor);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (match === null) return null;
  return { query: match[2]!.toLowerCase(), start: cursor - match[2]!.length - 1 };
}

export function matchTeammates(teammates: Teammate[], query: string, excludeId: string | null, limit = 6): Teammate[] {
  return teammates
    .filter((teammate) => teammate.id !== excludeId && teammate.name !== null)
    .filter((teammate) => teammate.name!.toLowerCase().split(/\s+/).some((part) => part.startsWith(query)) || teammate.name!.toLowerCase().startsWith(query))
    .slice(0, limit);
}

/** The ids still mentioned when the note is sent: a mention deleted from the text is not sent. */
export function mentionedIds(draft: string, picked: Teammate[]): string[] {
  return [...new Set(picked.filter((teammate) => teammate.name !== null && draft.includes(`@${teammate.name}`)).map((t) => t.id))];
}
