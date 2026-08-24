import type { InboxSocketFactory } from "../inboxRealtime";
import type { Socket } from "socket.io-client";

/**
 * A controllable stand-in for the agent inbox's socket.
 *
 * Deliberately NOT `widget/testing/fakeSocket.ts`. That harness models an
 * ack-carrying `emit`, because the widget's client emits `conversation:join`
 * and `message:send`. An agent socket emits NOTHING and joins nothing
 * (ADR-025 §8) — it only listens — so a fake with an ack registry would be
 * modelling a surface this client does not have, and a test could pass by
 * exercising it.
 *
 * It implements only what `inboxRealtime.ts` actually uses (`on`,
 * `disconnect`, `removeAllListeners`), so a change that starts depending on
 * more of the real client fails loudly here rather than passing against a
 * fake that pretends to be complete.
 */

export interface FakeInboxSocket {
  /** Options the factory was constructed with — lets a test assert the handshake `auth`. */
  options: Record<string, unknown>;
  origin: string;
  connected: boolean;
  disconnectCalls: number;
  removeAllListenersCalls: number;
  /** Every event this socket was asked to listen for. */
  listenedEvents: string[];

  /** Drives the client: fire a server-sent event. */
  fire(event: string, ...args: unknown[]): void;
  simulateConnect(): void;
  simulateDisconnect(reason?: string): void;
  simulateConnectError(message: string): void;
  /** Fires a `message:new` with the given payload. */
  deliver(message: unknown): void;
}

export interface FakeInboxSocketHarness {
  factory: InboxSocketFactory;
  sockets: FakeInboxSocket[];
  last(): FakeInboxSocket;
}

export function createFakeInboxSocketHarness(): FakeInboxSocketHarness {
  const sockets: FakeInboxSocket[] = [];

  const factory: InboxSocketFactory = (origin, options) => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

    const socket: FakeInboxSocket = {
      origin,
      options,
      connected: false,
      disconnectCalls: 0,
      removeAllListenersCalls: 0,
      listenedEvents: [],

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

      deliver(message) {
        socket.fire("message:new", message);
      },
    };

    const impl = {
      on(event: string, listener: (...args: unknown[]) => void) {
        socket.listenedEvents.push(event);
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
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
