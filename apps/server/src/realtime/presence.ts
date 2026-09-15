/**
 * Which organisations have an agent connected right now (ADR-040 §2).
 *
 * Counted per organisation from agent socket connects and disconnects. A person
 * with two tabs open is two connections; the organisation is "online" while the
 * count is above zero.
 *
 * In-process: correct for one server process, which is how Serviqo runs today.
 * A deployment with several processes would move this count to a shared store
 * (Redis), and nothing outside this module would need to change.
 */

type Listener = (organizationId: string, agentsOnline: boolean) => void;

const connections = new Map<string, number>();
const listeners = new Set<Listener>();

function notify(organizationId: string, agentsOnline: boolean) {
  for (const listener of listeners) listener(organizationId, agentsOnline);
}

export const agentPresence = {
  connected(organizationId: string): void {
    const next = (connections.get(organizationId) ?? 0) + 1;
    connections.set(organizationId, next);
    if (next === 1) notify(organizationId, true);
  },

  disconnected(organizationId: string): void {
    const current = connections.get(organizationId) ?? 0;
    if (current <= 1) {
      connections.delete(organizationId);
      if (current === 1) notify(organizationId, false);
      return;
    }
    connections.set(organizationId, current - 1);
  },

  isOnline(organizationId: string): boolean {
    return (connections.get(organizationId) ?? 0) > 0;
  },

  /** Called whenever an organisation goes from nobody online to somebody, or back. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Tests only: forget every connection. */
  reset(): void {
    connections.clear();
  },
};
