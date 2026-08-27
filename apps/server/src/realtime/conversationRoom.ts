/**
 * Room-name derivation (ADR-023 §4). One function, so nothing joins or
 * broadcasts to a room built any other way.
 *
 * Scoped by organization AND conversation, satisfying CONTRIBUTING.md's
 * explicit rule ("Socket rooms must be scoped by organization") even though
 * a `Conversation._id` is already globally unique on its own — the same
 * "two keys, structurally, not by convention" discipline ADR-022 §1 applies
 * to every repository method touching this collection.
 */
export function conversationRoomName(organizationId: string, conversationId: string): string {
  return `org:${organizationId}:conversation:${conversationId}`;
}

/**
 * The agent inbox room (ADR-025 §8). One per organization, holding every
 * connected agent socket of that tenant.
 *
 * Scoped by organization and by NOTHING else, which is what makes
 * CONTRIBUTING.md's non-negotiable rule structural here rather than
 * conventional: an agent socket joins the room this function builds from the
 * organization the server itself proved at handshake time, so there is no
 * room name a client could cause to be constructed that reaches another
 * tenant.
 *
 * Deliberately not per-conversation. An agent socket joins this room only and
 * is never added to a conversation room, so "which conversations is this agent
 * watching?" is not state the server tracks, and the agent's client filters
 * for display — a UX concern, not a security one, because tenancy was proved
 * before the socket joined anything.
 */
export function organizationInboxRoomName(organizationId: string): string {
  return `org:${organizationId}:inbox`;
}
