/**
 * The lookup behind an organisation's chat link (ADR-038 §2).
 *
 * `GET /api/v1/widget/organizations/:slug` answers the organisation's name and
 * its widget key, or a 404 that means "this link does not lead anywhere" —
 * unknown, malformed and suspended alike. Nothing here is a credential: the
 * widget key is public by design, and the session it opens is anonymous.
 *
 * Deliberately not built on `authorizedFetch`. The person on this page is a
 * customer, customers never sign in (ADR-037), and a staff session that
 * happens to exist in the same browser must not ride along on a public read.
 */

export interface WidgetDirectoryEntry {
  name: string;
  widgetKey: string;
}

/** The link resolves nowhere. Its own type so the page can tell it from a dropped connection. */
export class ChatLinkNotFoundError extends Error {}

/** The server could not be reached, or answered something unexpected. Worth a retry. */
export class ChatLinkUnavailableError extends Error {}

function isDirectoryEntry(value: unknown): value is WidgetDirectoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WidgetDirectoryEntry>;
  return typeof candidate.name === "string" && typeof candidate.widgetKey === "string";
}

export async function fetchWidgetDirectoryEntry(slug: string, signal?: AbortSignal): Promise<WidgetDirectoryEntry> {
  let response: Response;

  try {
    response = await fetch(`/api/v1/widget/organizations/${encodeURIComponent(slug)}`, {
      // No cookie and no Authorization header, for the reason in the file header.
      credentials: "omit",
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChatLinkUnavailableError("Could not reach the chat service.");
  }

  if (response.status === 404) {
    throw new ChatLinkNotFoundError("This chat is not available.");
  }

  const body: unknown = await response.json().catch(() => null);
  const data = (body as { success?: unknown; data?: unknown } | null)?.data;

  if (!response.ok || !isDirectoryEntry(data)) {
    throw new ChatLinkUnavailableError("Could not reach the chat service.");
  }

  return data;
}
