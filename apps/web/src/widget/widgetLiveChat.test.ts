import { afterEach, describe, expect, it, vi } from "vitest";

import { isWithinBusinessHours, darken } from "./availability";
import { createFakeSocketHarness } from "./testing/fakeSocket";
import { initWidget } from "./widget";

import type { FakeSocketHarness } from "./testing/fakeSocket";
import type { WidgetConfig } from "./types";

/**
 * Live chat in the widget (ADR-040): the organisation's colour and title,
 * online/away, typing indicators, "Seen", and the launcher's unread badge.
 */

const CONFIG: WidgetConfig = {
  widgetKey: "wk_live",
  apiBase: "https://app.example.com/api/v1/widget",
  socketOrigin: "https://app.example.com",
};
const CONVERSATION_ID = "6a8c0fbf909d5192a6bbd66f";

const APPEARANCE = {
  accentColor: "#7C3AED",
  title: "CentralService Support",
  welcomeMessage: "Hi! Ask us anything.",
  awayMessage: "We're away — leave a message.",
  businessHours: { enabled: false, timezone: "UTC", days: [null, null, null, null, null, null, null] },
};

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function routedFetch(options: { agentsOnline?: boolean; agentLastReadAt?: string | null; unreadCount?: number; history?: unknown[] } = {}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) {
      return Promise.resolve(
        json(201, {
          success: true,
          data: {
            token: "TOKEN_1",
            expiresInSeconds: 86400,
            customer: { id: "c1", name: null, email: null, phone: null },
            appearance: APPEARANCE,
            availability: { online: options.agentsOnline ?? false, agentsOnline: options.agentsOnline ?? false, withinBusinessHours: true },
          },
        }),
      );
    }
    if (url.endsWith("/conversations") && init?.method === "POST") {
      return Promise.resolve(
        json(201, {
          success: true,
          data: {
            id: CONVERSATION_ID,
            status: "open",
            createdAt: "2026-09-14T09:00:00.000Z",
            lastMessageAt: "2026-09-14T09:00:00.000Z",
            agentLastReadAt: options.agentLastReadAt ?? null,
            unreadCount: options.unreadCount ?? 0,
          },
        }),
      );
    }
    if (url.includes("/messages")) {
      return Promise.resolve(json(200, { success: true, data: { messages: url.includes("cursor=") ? [] : (options.history ?? []), nextCursor: null } }));
    }
    return Promise.resolve(json(404, { success: false, error: {} }));
  });
}

function message(id: string, senderType: "customer" | "agent", createdAt: string, body = "hi") {
  return { id, conversationId: CONVERSATION_ID, senderType, body, createdAt };
}

const host = () => document.querySelector("[data-serviqo-widget-host]") as HTMLElement | null;
const shadow = () => host()!.shadowRoot!;

async function mountOpen(harness: FakeSocketHarness) {
  initWidget(CONFIG, { socketFactory: harness.factory });
  (shadow().querySelector(".launcher") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow().querySelector(".chat")).not.toBeNull());
  await vi.waitFor(() => expect(harness.sockets.length).toBeGreaterThan(0));
  const socket = harness.last();
  socket.simulateConnect();
  await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join")).toBe(true));
  socket.respondTo("conversation:join", { ok: true, data: { id: CONVERSATION_ID, status: "open", createdAt: "x", lastMessageAt: "x" } });
  return socket;
}

afterEach(() => {
  host()?.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the widget's live chat", () => {
  it("takes the organisation's colour and title from the session", async () => {
    vi.stubGlobal("fetch", routedFetch());
    await mountOpen(createFakeSocketHarness());

    expect(shadow().querySelector(".panel__title")!.textContent).toBe("CentralService Support");
    const root = shadow().querySelector(".root") as HTMLElement;
    expect(root.style.getPropertyValue("--sq-brand")).toBe("#7C3AED");
  });

  it("says away when nobody is online, and switches to the welcome message live when an agent connects", async () => {
    vi.stubGlobal("fetch", routedFetch({ agentsOnline: false }));
    const socket = await mountOpen(createFakeSocketHarness());

    expect(shadow().querySelector(".panel__subtitle")!.textContent).toBe("We're away — leave a message.");
    expect(shadow().querySelector(".panel__dot--online")).toBeNull();

    socket.fire("presence:update", { agentsOnline: true });

    expect(shadow().querySelector(".panel__subtitle")!.textContent).toBe("Hi! Ask us anything.");
    expect(shadow().querySelector(".panel__dot--online")).not.toBeNull();
  });

  it("shows support typing, and hides it when the reply arrives", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const socket = await mountOpen(createFakeSocketHarness());
    const typing = () => shadow().querySelector(".chat__typing") as HTMLElement;

    socket.fire("typing", { conversationId: CONVERSATION_ID, sender: "agent", isTyping: true });
    expect(typing().hidden).toBe(false);

    socket.fire("message:new", message("m2", "agent", "2026-09-14T09:05:00.000Z", "Here you go"));
    expect(typing().hidden).toBe(true);
  });

  it("ignores typing about another conversation, and a customer's own typing echo", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const socket = await mountOpen(createFakeSocketHarness());

    socket.fire("typing", { conversationId: "000000000000000000000000", sender: "agent", isTyping: true });
    socket.fire("typing", { conversationId: CONVERSATION_ID, sender: "customer", isTyping: true });

    expect((shadow().querySelector(".chat__typing") as HTMLElement).hidden).toBe(true);
  });

  it("tells the server the visitor is typing, and that they stopped when they send", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const socket = await mountOpen(createFakeSocketHarness());
    const input = shadow().querySelector(".chat__input") as HTMLTextAreaElement;

    input.value = "Where is";
    input.dispatchEvent(new Event("input"));
    input.value = "Where is my order";
    input.dispatchEvent(new Event("input"));

    const typingEvents = () => socket.emissions.filter((entry) => entry.event === "typing").map((entry) => entry.payload);
    // Throttled: two keystrokes in a row send one "typing".
    expect(typingEvents()).toEqual([{ conversationId: CONVERSATION_ID, isTyping: true }]);

    (shadow().querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
    expect(typingEvents().at(-1)).toEqual({ conversationId: CONVERSATION_ID, isTyping: false });
  });

  it("shows 'Seen' under the visitor's latest message once the team has read past it", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ history: [message("m1", "customer", "2026-09-14T09:01:00.000Z", "Help please")] }),
    );
    const socket = await mountOpen(createFakeSocketHarness());

    expect(shadow().querySelector(".msg__seen")).toBeNull();

    socket.fire("conversation:read", { conversationId: CONVERSATION_ID, reader: "agent", readAt: "2026-09-14T09:02:00.000Z" });
    expect(shadow().querySelector(".msg__seen")?.textContent).toBe("Seen");

    // A newer message has not been seen yet.
    socket.fire("message:new", message("m3", "customer", "2026-09-14T09:03:00.000Z", "Hello?"));
    expect(shadow().querySelector(".msg__seen")).toBeNull();
  });

  it("marks the conversation read when an agent's reply arrives while the chat is open", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const socket = await mountOpen(createFakeSocketHarness());

    socket.fire("message:new", message("m2", "agent", "2026-09-14T09:05:00.000Z"));

    expect(socket.emissions.some((entry) => entry.event === "conversation:read")).toBe(true);
  });

  it("badges the launcher with replies that arrive while the panel is closed", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const socket = await mountOpen(createFakeSocketHarness());
    (shadow().querySelector(".panel__close") as HTMLButtonElement).click();

    socket.fire("message:new", message("m2", "agent", "2026-09-14T09:05:00.000Z"));
    socket.fire("message:new", message("m3", "agent", "2026-09-14T09:06:00.000Z"));

    const badge = shadow().querySelector(".launcher__badge") as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("2");

    (shadow().querySelector(".launcher") as HTMLButtonElement).click();
    expect(badge.hidden).toBe(true);
  });
});

describe("availability helpers", () => {
  it("works out business hours in the organisation's timezone", () => {
    const hours = { enabled: true, timezone: "Asia/Kolkata", days: [null, { open: "09:00", close: "18:00" }, null, null, null, null, null] };
    expect(isWithinBusinessHours(hours, new Date("2026-09-14T04:00:00Z"))).toBe(true);
    expect(isWithinBusinessHours(hours, new Date("2026-09-14T13:00:00Z"))).toBe(false);
    expect(isWithinBusinessHours({ ...hours, enabled: false }, new Date("2026-09-13T06:00:00Z"))).toBe(true);
  });

  it("darkens a colour and leaves anything else alone", () => {
    expect(darken("#ffffff", 0.5)).toBe("#808080");
    expect(darken("not-a-colour")).toBe("not-a-colour");
  });
});
