import type { SocketFactory } from "../realtime";
import type { Socket } from "socket.io-client";

/**
 * A controllable stand-in for a `socket.io-client` socket (ADR-024 §2).
 *
 * Lives under `testing/` and is imported by no production module, so the
 * widget bundle never contains it — `vite.widget.config.ts` builds from
 * `main.ts`, which does not reach this file.
 *
 * It implements only the surface `realtime.ts` actually uses (`on`, `emit`,
 * `connected`, `disconnect`, `removeAllListeners`), so a change that starts
 * depending on more of the real client fails loudly here rather than passing
 * against a fake that pretends to be complete.
 */

export interface FakeSocket {
  /** Options the factory was constructed with — lets a test assert `auth`/`transports`. */
  options: Record<string, unknown>;
  origin: string;
  connected: boolean;
  /** Every `emit` the client made, in order. */
  emissions: { event: string; payload: unknown }[];
  disconnectCalls: number;
  removeAllListenersCalls: number;

  /** Drives the client: fire a server-sent event. */
  fire(event: string, ...args: unknown[]): void;
  /** Convenience: transition to connected and fire `connect`. */
  simulateConnect(): void;
  /** Convenience: transition to disconnected and fire `disconnect`. */
  simulateDisconnect(reason?: string): void;
  /** Convenience: fire `connect_error` with a given message. */
  simulateConnectError(message: string): void;
  /** Answers the pending ack for the Nth emission of `event`. */
  respondTo(event: string, response: unknown, occurrence?: number): void;
  /** Whether an ack callback is still outstanding for that emission. */
  hasPendingAck(event: string, occurrence?: number): boolean;
}

interface Emission {
  event: string;
  payload: unknown;
  ack?: (response: unknown) => void;
}

export interface FakeSocketHarness {
  factory: SocketFactory;
  /** The sockets created, in order. A reconnect in these tests is a new `connect` on the same socket. */
  sockets: FakeSocket[];
  /** The most recently created socket. */
  last(): FakeSocket;
}

export function createFakeSocketHarness(): FakeSocketHarness {
  const sockets: FakeSocket[] = [];

  const factory: SocketFactory = (origin, options) => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const emissions: Emission[] = [];

    const socket: FakeSocket = {
      origin,
      options,
      connected: false,
      emissions,
      disconnectCalls: 0,
      removeAllListenersCalls: 0,

      fire(event, ...args) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },

      simulateConnect() {
        socket.connected = true;
        socket.fire("connect");
      },

      simulateDisconnect(reason = "transport close") {
        socket.connected = false;
        socket.fire("disconnect", reason);
      },

      simulateConnectError(message) {
        socket.connected = false;
        socket.fire("connect_error", new Error(message));
      },

      respondTo(event, response, occurrence = 0) {
        const matches = emissions.filter((e) => e.event === event);
        const target = matches[occurrence];
        if (target === undefined) throw new Error(`no emission #${occurrence} for "${event}"`);
        if (target.ack === undefined) throw new Error(`emission "${event}" carried no ack callback`);
        target.ack(response);
      },

      hasPendingAck(event, occurrence = 0) {
        const matches = emissions.filter((e) => e.event === event);
        return matches[occurrence]?.ack !== undefined;
      },
    };

    // The three methods `realtime.ts` calls on a socket, plus the listener
    // registry the fire helpers above read.
    const impl = {
      on(event: string, listener: (...args: unknown[]) => void) {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
        return impl;
      },
      emit(event: string, payload: unknown, ack?: (response: unknown) => void) {
        emissions.push(ack === undefined ? { event, payload } : { event, payload, ack });
        return impl;
      },
      disconnect() {
        socket.disconnectCalls += 1;
        socket.connected = false;
        return impl;
      },
      removeAllListeners() {
        socket.removeAllListenersCalls += 1;
        listeners.clear();
        return impl;
      },
      get connected() {
        return socket.connected;
      },
    };

    Object.assign(socket, {
      on: impl.on,
      emit: impl.emit,
      disconnect: impl.disconnect,
      removeAllListeners: impl.removeAllListeners,
    });

    sockets.push(socket);
    return impl as unknown as Socket;
  };

  return {
    factory,
    sockets,
    last() {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) throw new Error("no socket has been created");
      return socket;
    },
  };
}
