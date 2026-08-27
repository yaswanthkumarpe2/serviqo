import { afterEach, describe, expect, it, vi } from "vitest";

import { createRealtimeClient, RealtimeError } from "./realtime";
import { createFakeSocketHarness } from "./testing/fakeSocket";

import type { RealtimeCallbacks, RealtimeStatus } from "./realtime";
import type { WidgetMessage } from "./types";

const ORIGIN = "https://dashboard.example.com";
const TOKEN = "TOKEN_SENTINEL_VALUE";
const CONVERSATION_ID = "6a8c0fbf909d5192a6bbd66f";

function message(overrides: Partial<WidgetMessage> = {}): WidgetMessage {
  return {
    id: "m1",
    conversationId: CONVERSATION_ID,
    senderType: "customer",
    body: "hello",
    createdAt: "2026-08-24T09:35:02.207Z",
    ...overrides,
  };
}

function harnessWithClient(overrides: Partial<RealtimeCallbacks> = {}) {
  const harness = createFakeSocketHarness();
  const messages: WidgetMessage[] = [];
  const statuses: RealtimeStatus[] = [];
  const callbacks: RealtimeCallbacks = {
    onMessage: (m) => messages.push(m),
    onStatusChange: (s) => statuses.push(s),
    onConnected: vi.fn(),
    onAuthFailure: vi.fn(),
    ...overrides,
  };

  const client = createRealtimeClient({
    socketOrigin: ORIGIN,
    token: TOKEN,
    callbacks,
    factory: harness.factory,
  });

  return { harness, client, messages, statuses, callbacks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRealtimeClient", () => {
  // ---- connection and authentication ----

  describe("connection and authentication", () => {
    it("connects to the socket origin carrying the token in the handshake auth payload", () => {
      const { harness, client } = harnessWithClient();

      client.connect();

      const socket = harness.last();
      expect(socket.origin).toBe(ORIGIN);
      expect(socket.options.auth).toEqual({ token: TOKEN });
    });

    it("never puts the token in a query string", () => {
      const { harness, client } = harnessWithClient();

      client.connect();

      const serialized = JSON.stringify({ origin: harness.last().origin, options: harness.last().options });
      // The token appears exactly once — inside `auth` — and nowhere that
      // would reach a proxy log, an access log, or browser history.
      expect(harness.last().origin).not.toContain(TOKEN);
      expect(serialized.match(/TOKEN_SENTINEL_VALUE/g)).toHaveLength(1);
      expect(harness.last().options.query).toBeUndefined();
    });

    it("pins the websocket transport with no polling fallback (ADR-024 §1)", () => {
      const { harness, client } = harnessWithClient();

      client.connect();

      expect(harness.last().options.transports).toEqual(["websocket"]);
    });

    it("leaves the library's own reconnection enabled (ADR-024 §5)", () => {
      const { harness, client } = harnessWithClient();

      client.connect();

      expect(harness.last().options.reconnection).toBe(true);
    });

    it("reports connecting then connected, and signals onConnected", () => {
      const onConnected = vi.fn();
      const { harness, client, statuses } = harnessWithClient({ onConnected });

      client.connect();
      expect(statuses).toEqual(["connecting"]);

      harness.last().simulateConnect();

      expect(statuses).toEqual(["connecting", "connected"]);
      expect(onConnected).toHaveBeenCalledOnce();
    });

    it("creates only one socket even if connect() is called twice", () => {
      const { harness, client } = harnessWithClient();

      client.connect();
      client.connect();

      expect(harness.sockets).toHaveLength(1);
    });
  });

  // ---- token rejection ----

  describe("token rejection", () => {
    it.each([["Authentication required"], ["This chat widget is not available."]])(
      "treats %s as an auth failure, stops retrying, and reports failed",
      (refusal) => {
        const onAuthFailure = vi.fn();
        const { harness, client, statuses } = harnessWithClient({ onAuthFailure });

        client.connect();
        harness.last().simulateConnectError(refusal);

        expect(onAuthFailure).toHaveBeenCalledOnce();
        expect(statuses.at(-1)).toBe("failed");
        // The library must stop re-presenting a credential already refused.
        expect(harness.last().disconnectCalls).toBe(1);
      },
    );

    it("treats a transport error as retryable, not an auth failure", () => {
      const onAuthFailure = vi.fn();
      const { harness, client, statuses } = harnessWithClient({ onAuthFailure });

      client.connect();
      harness.last().simulateConnectError("websocket error");

      expect(onAuthFailure).not.toHaveBeenCalled();
      expect(statuses.at(-1)).toBe("reconnecting");
      expect(harness.last().disconnectCalls).toBe(0);
    });
  });

  // ---- joining ----

  describe("joining a conversation", () => {
    it("emits conversation:join with only the conversation id", async () => {
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.join(CONVERSATION_ID);
      harness.last().respondTo("conversation:join", { ok: true, data: { id: CONVERSATION_ID } });
      await pending;

      const emission = harness.last().emissions.find((e) => e.event === "conversation:join");
      // No organizationId, no customerId — the widget has no way to know
      // them and the server derives both from the token (ADR-022 §5).
      expect(emission!.payload).toEqual({ conversationId: CONVERSATION_ID });
    });

    it("rejects with the ack's code when the join is refused", async () => {
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.join(CONVERSATION_ID);
      harness.last().respondTo("conversation:join", {
        ok: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });

      await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects immediately when the socket is not connected", async () => {
      const { client } = harnessWithClient();
      client.connect();

      await expect(client.join(CONVERSATION_ID)).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    });
  });

  // ---- sending ----

  describe("sending a message", () => {
    it("emits message:send and resolves with the persisted message from the ack", async () => {
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.send(CONVERSATION_ID, "hello there");
      harness.last().respondTo("message:send", { ok: true, data: message({ body: "hello there" }) });

      await expect(pending).resolves.toMatchObject({ id: "m1", body: "hello there" });
      const emission = harness.last().emissions.find((e) => e.event === "message:send");
      expect(emission!.payload).toEqual({ conversationId: CONVERSATION_ID, body: "hello there" });
    });

    it("never sends senderType, customerId, or organizationId", async () => {
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.send(CONVERSATION_ID, "hi");
      harness.last().respondTo("message:send", { ok: true, data: message() });
      await pending;

      const payload = harness.last().emissions.find((e) => e.event === "message:send")!.payload as object;
      expect(Object.keys(payload).sort()).toEqual(["body", "conversationId"]);
    });

    it("rejects with the ack's code when the send is refused", async () => {
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.send(CONVERSATION_ID, "hi");
      harness.last().respondTo("message:send", {
        ok: false,
        error: { code: "TOO_MANY_REQUESTS", message: "Too many requests." },
      });

      await expect(pending).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    });

    it("rejects a malformed ack payload rather than passing it to the renderer", async () => {
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.send(CONVERSATION_ID, "hi");
      harness.last().respondTo("message:send", { ok: true, data: { id: "m1" } });

      await expect(pending).rejects.toMatchObject({ code: "MALFORMED_ACK" });
    });

    it("times out rather than leaving the caller waiting forever", async () => {
      vi.useFakeTimers();
      const { harness, client } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      const pending = client.send(CONVERSATION_ID, "hi");
      const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    });
  });

  // ---- receiving ----

  describe("receiving message:new", () => {
    it("passes a well-formed message to the callback", () => {
      const { harness, client, messages } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      harness.last().fire("message:new", message({ id: "m9", body: "from the server" }));

      expect(messages).toEqual([expect.objectContaining({ id: "m9", body: "from the server" })]);
    });

    it("drops a malformed payload rather than rendering it", () => {
      const { harness, client, messages } = harnessWithClient();
      client.connect();
      harness.last().simulateConnect();

      harness.last().fire("message:new", { id: "m1", body: "no senderType" });
      harness.last().fire("message:new", null);
      harness.last().fire("message:new", message({ senderType: "root" as never }));

      expect(messages).toEqual([]);
    });
  });

  // ---- reconnect ----

  describe("reconnect", () => {
    it("reports reconnecting on disconnect and signals onConnected again on every reconnect", () => {
      const onConnected = vi.fn();
      const { harness, client, statuses } = harnessWithClient({ onConnected });

      client.connect();
      const socket = harness.last();
      socket.simulateConnect();
      socket.simulateDisconnect();
      socket.simulateConnect();

      expect(statuses).toEqual(["connecting", "connected", "reconnecting", "connected"]);
      // The first connect and the reconnect take the identical code path.
      expect(onConnected).toHaveBeenCalledTimes(2);
    });
  });

  // ---- teardown ----

  describe("destroy", () => {
    it("removes listeners, disconnects, and stops reporting status", () => {
      const { harness, client, statuses } = harnessWithClient();
      client.connect();
      const socket = harness.last();
      socket.simulateConnect();

      client.destroy();
      const afterDestroy = statuses.length;
      socket.simulateDisconnect();

      expect(socket.removeAllListenersCalls).toBe(1);
      expect(socket.disconnectCalls).toBe(1);
      expect(statuses).toHaveLength(afterDestroy);
    });

    it("does not create a socket after destroy", () => {
      const { harness, client } = harnessWithClient();

      client.destroy();
      client.connect();

      expect(harness.sockets).toHaveLength(0);
    });
  });

  it("exports RealtimeError carrying a code and no server message text", () => {
    const error = new RealtimeError("NOT_FOUND");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Realtime operation failed");
  });
});
