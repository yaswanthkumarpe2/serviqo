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
