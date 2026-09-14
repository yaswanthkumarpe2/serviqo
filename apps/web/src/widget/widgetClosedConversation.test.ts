import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeSocketHarness } from "./testing/fakeSocket";
import { initWidget } from "./widget";

import type { FakeSocketHarness } from "./testing/fakeSocket";
import type { WidgetConfig } from "./types";

/**
 * The widget's recovery from a conversation an agent closed (ADR-026 §6, §8).
 *
 * The claim under test is narrow and specific: on the `CONVERSATION_CLOSED`
 * ack and ONLY that ack, the widget resolves a new open conversation, joins
 * it, and re-sends once — so the visitor's message lands rather than failing,
 * and they are never told anything about an internal workflow event.
 *
 * Its own file rather than more cases in `widget.test.ts`: that suite is
 * ADR-021 and ADR-024's mount, open sequence, and delivery, and it routes
 * `POST /conversations` to one fixed conversation. This one needs the second
 * resolve to answer differently, which is the whole point.
 */

const CONFIG: WidgetConfig = {
  widgetKey: "wk_test",
  apiBase: "https://dashboard.example.com/api/v1/widget",
  socketOrigin: "https://dashboard.example.com",
};

const FIRST_CONVERSATION = "6a8c0fbf909d5192a6bbd66f";
const SECOND_CONVERSATION = "6a8c0fbf909d5192a6bbd670";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function conversationBody(id: string) {
  return {
    success: true,
    data: {
      id,
      status: "open",
      createdAt: "2026-08-24T09:32:47.215Z",
      lastMessageAt: "2026-08-24T09:32:47.213Z",
    },
  };
}

function message(id: string, conversationId: string, body: string) {
  return {
    id,
    conversationId,
    senderType: "customer" as const,
    body,
    createdAt: "2026-08-24T09:35:02.207Z",
  };
}

/**
 * Routes the open sequence, handing out a DIFFERENT conversation on each
 * `POST /conversations`.
 *
 * That is what makes the recovery observable: the second resolve is the
 * server doing exactly what ADR-022 §7 specifies — no open conversation
 * exists, because an agent closed it, so create one.
 */
function routedFetch(options: { resolveFails?: boolean } = {}) {
  const resolved: string[] = [];

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          data: { token: "TOKEN_1", expiresInSeconds: 86400, customer: { id: "c1", name: null, email: null } },
        }),
      );
    }

    if (url.endsWith("/conversations") && init?.method === "POST") {
      if (options.resolveFails === true && resolved.length > 0) {
        return Promise.resolve(jsonResponse(503, { success: false, error: { code: "INTERNAL_ERROR" } }));
      }
      const id = resolved.length === 0 ? FIRST_CONVERSATION : SECOND_CONVERSATION;
      resolved.push(id);
      return Promise.resolve(jsonResponse(201, conversationBody(id)));
    }

    if (url.includes("/messages")) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
    }

    return Promise.resolve(jsonResponse(404, { success: false, error: {} }));
  });

  return { fetchMock, resolved };
}

function shadowOf(host: Element): ShadowRoot {
  const shadow = host.shadowRoot;
  if (shadow === null) throw new Error("expected a shadow root");
  return shadow;
}

function findHost(): HTMLElement | null {
  return document.querySelector("[data-serviqo-widget-host]");
}

async function mountAndOpen(harness: FakeSocketHarness) {
  initWidget(CONFIG, { socketFactory: harness.factory });
  const shadow = shadowOf(findHost()!);
  (shadow.querySelector(".launcher") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow.querySelector(".chat")).not.toBeNull());
  return shadow;
}

async function connectAndJoin(harness: FakeSocketHarness) {
  await vi.waitFor(() => expect(harness.sockets.length).toBeGreaterThan(0));
  const socket = harness.last();
  socket.simulateConnect();
  await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join")).toBe(true));
  socket.respondTo("conversation:join", { ok: true, data: conversationBody(FIRST_CONVERSATION).data });
  return socket;
}

function bodies(shadow: ShadowRoot): string[] {
  return [...shadow.querySelectorAll(".msg__body")].map((el) => el.textContent ?? "");
}

function submit(shadow: ShadowRoot, text: string) {
  (shadow.querySelector(".chat__input") as HTMLTextAreaElement).value = text;
  (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
}

afterEach(() => {
  findHost()?.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the widget's closed-conversation recovery", () => {
  it("resolves a new conversation, joins it, and re-sends once", async () => {
    const { fetchMock, resolved } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    submit(shadow, "are you still there?");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));

    // An agent closed the thread while the panel was open (ADR-026 §6).
    socket.respondTo("message:send", {
      ok: false,
      error: { code: "CONVERSATION_CLOSED", message: "This conversation has been closed." },
    });

    // The recovery: a second resolve, then a join of the NEW conversation.
    await vi.waitFor(() => expect(resolved).toHaveLength(2));
    await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));

    const rejoin = socket.emissions.filter((e) => e.event === "conversation:join");
    expect(rejoin[1]!.payload).toEqual({ conversationId: SECOND_CONVERSATION });

    socket.respondTo("conversation:join", { ok: true, data: conversationBody(SECOND_CONVERSATION).data }, 1);

    await vi.waitFor(() => expect(socket.hasPendingAck("message:send", 1)).toBe(true));
    const retried = socket.emissions.filter((e) => e.event === "message:send");
    expect(retried[1]!.payload).toEqual({
      conversationId: SECOND_CONVERSATION,
      body: "are you still there?",
    });

    socket.respondTo("message:send", { ok: true, data: message("m1", SECOND_CONVERSATION, "are you still there?") }, 1);

    // The visitor's message landed. From their side nothing was closed
    // (ADR-026 §8, §10).
    await vi.waitFor(() => expect(bodies(shadow)).toContain("are you still there?"));
    expect(shadow.querySelector(".chat__notice")!.hasAttribute("hidden")).toBe(true);
  });

  it("tells the visitor nothing about the closure", async () => {
    const { fetchMock } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    submit(shadow, "hello?");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    socket.respondTo("message:send", {
      ok: false,
      error: { code: "CONVERSATION_CLOSED", message: "This conversation has been closed." },
    });

    await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
    socket.respondTo("conversation:join", { ok: true, data: conversationBody(SECOND_CONVERSATION).data }, 1);
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send", 1)).toBe(true));
    socket.respondTo("message:send", { ok: true, data: message("m1", SECOND_CONVERSATION, "hello?") }, 1);

    await vi.waitFor(() => expect(bodies(shadow)).toContain("hello?"));

    // The server's own text never reaches the panel (ADR-024 §7), and neither
    // does the fact that an agent closed anything.
    const rendered = shadow.textContent ?? "";
    expect(rendered).not.toContain("closed");
    expect(rendered).not.toContain("Closed");
  });

  it("keeps the messages already on screen rather than blanking the thread", async () => {
    const { fetchMock } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    // A message that landed before the agent closed the thread.
    socket.fire("message:new", message("m0", FIRST_CONVERSATION, "my first question"));
    await vi.waitFor(() => expect(bodies(shadow)).toContain("my first question"));

    submit(shadow, "and a follow-up");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    socket.respondTo("message:send", { ok: false, error: { code: "CONVERSATION_CLOSED", message: "…" } });

    await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
    socket.respondTo("conversation:join", { ok: true, data: conversationBody(SECOND_CONVERSATION).data }, 1);
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send", 1)).toBe(true));
    socket.respondTo("message:send", { ok: true, data: message("m1", SECOND_CONVERSATION, "and a follow-up") }, 1);

    /*
      Hiding the visitor's own history because an agent filed the thread
      differently would be the widget reporting an internal workflow event as
      a loss of their conversation (ADR-026 §8).
    */
    await vi.waitFor(() => expect(bodies(shadow)).toEqual(["my first question", "and a follow-up"]));
  });

  it("retries exactly once — a second closure is reported, not recovered again", async () => {
    const { fetchMock, resolved } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    submit(shadow, "persistent question");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    socket.respondTo("message:send", { ok: false, error: { code: "CONVERSATION_CLOSED", message: "…" } });

    await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
    socket.respondTo("conversation:join", { ok: true, data: conversationBody(SECOND_CONVERSATION).data }, 1);
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send", 1)).toBe(true));

    // The new conversation is closed too. A recovery that recursed here would
    // be an unbounded loop (ADR-026 §8).
    socket.respondTo("message:send", { ok: false, error: { code: "CONVERSATION_CLOSED", message: "…" } }, 1);

    await vi.waitFor(() => expect(shadow.querySelector(".chat__notice")!.hasAttribute("hidden")).toBe(false));
    expect(resolved).toHaveLength(2);
    expect(socket.emissions.filter((e) => e.event === "message:send")).toHaveLength(2);
    // The visitor must not lose what they typed.
    expect((shadow.querySelector(".chat__input") as HTMLTextAreaElement).value).toBe("persistent question");
  });

  it("does not recover from any other ack code", async () => {
    const { fetchMock, resolved } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    submit(shadow, "a message");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    socket.respondTo("message:send", { ok: false, error: { code: "TOO_MANY_REQUESTS", message: "…" } });

    await vi.waitFor(() => expect(shadow.querySelector(".chat__notice")!.hasAttribute("hidden")).toBe(false));

    // Only `CONVERSATION_CLOSED` has a recovery; everything else takes the
    // existing branch that restores the text and shows the notice.
    expect(resolved).toHaveLength(1);
    expect(socket.emissions.filter((e) => e.event === "conversation:join")).toHaveLength(1);
  });

  it("falls back to the ordinary failure notice when the new conversation cannot be resolved", async () => {
    const { fetchMock } = routedFetch({ resolveFails: true });
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    submit(shadow, "text worth keeping");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    socket.respondTo("message:send", { ok: false, error: { code: "CONVERSATION_CLOSED", message: "…" } });

    await vi.waitFor(() => expect(shadow.querySelector(".chat__notice")!.hasAttribute("hidden")).toBe(false));
    expect((shadow.querySelector(".chat__input") as HTMLTextAreaElement).value).toBe("text worth keeping");
  });

  it("re-joins the NEW conversation after a reconnect, not the closed one", async () => {
    const { fetchMock } = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const harness = createFakeSocketHarness();
    const shadow = await mountAndOpen(harness);
    const socket = await connectAndJoin(harness);

    submit(shadow, "hello");
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    socket.respondTo("message:send", { ok: false, error: { code: "CONVERSATION_CLOSED", message: "…" } });

    await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
    socket.respondTo("conversation:join", { ok: true, data: conversationBody(SECOND_CONVERSATION).data }, 1);
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send", 1)).toBe(true));
    socket.respondTo("message:send", { ok: true, data: message("m1", SECOND_CONVERSATION, "hello") }, 1);

    socket.simulateDisconnect();
    socket.simulateConnect();

    /*
      A reconnect that re-joined the conversation captured when the client was
      built would put the socket back in the CLOSED thread's room, and live
      delivery for the new one would silently stop (ADR-026 §8).
    */
    await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 2)).toBe(true));
    const joins = socket.emissions.filter((e) => e.event === "conversation:join");
    expect(joins[2]!.payload).toEqual({ conversationId: SECOND_CONVERSATION });
  });
});
