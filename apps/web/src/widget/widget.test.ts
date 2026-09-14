import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeSocketHarness } from "./testing/fakeSocket";
import { initWidget } from "./widget";

import type { FakeSocketHarness } from "./testing/fakeSocket";
import type { WidgetConfig } from "./types";

const CONFIG: WidgetConfig = {
  widgetKey: "wk_test",
  apiBase: "https://dashboard.example.com/api/v1/widget",
  socketOrigin: "https://dashboard.example.com",
};

const CONVERSATION_ID = "6a8c0fbf909d5192a6bbd66f";
const TOKEN_STORAGE_KEY = `serviqo_widget_token::${CONFIG.widgetKey}`;
const VISITOR_KEY_STORAGE_KEY = `serviqo_widget_visitor::${CONFIG.widgetKey}`;
/** 43 base64url characters — the shape the server issues (ADR-038 §3). */
const VISITOR_KEY = "V".repeat(43);

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

interface TestCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

const ANONYMOUS_CUSTOMER: TestCustomer = { id: "c1", name: null, email: null };

function sessionBody(token = "TOKEN_1", customer: TestCustomer = ANONYMOUS_CUSTOMER) {
  return { success: true, data: { token, expiresInSeconds: 86400, customer } };
}

const CONVERSATION_BODY = {
  success: true,
  data: {
    id: CONVERSATION_ID,
    status: "open",
    createdAt: "2026-08-24T09:32:47.215Z",
    lastMessageAt: "2026-08-24T09:32:47.213Z",
  },
};

function message(id: string, body: string, senderType: "customer" | "agent" = "customer") {
  return {
    id,
    conversationId: CONVERSATION_ID,
    senderType,
    body,
    createdAt: "2026-08-24T09:35:02.207Z",
  };
}

function historyBody(messages: unknown[], nextCursor: string | null = null) {
  return { success: true, data: { messages, nextCursor } };
}

/**
 * Routes the three REST calls ADR-024 §3's open sequence makes, so a test
 * states only what it cares about (usually the history) and gets a working
 * session and conversation for free.
 */
function routedFetch(options: { history?: unknown[]; sessionToken?: string; customer?: TestCustomer } = {}) {
  const history = options.history ?? [];
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) {
      return Promise.resolve(
        jsonResponse(201, sessionBody(options.sessionToken ?? "TOKEN_1", options.customer ?? ANONYMOUS_CUSTOMER)),
      );
    }
    if (url.endsWith("/conversations") && init?.method === "POST") {
      return Promise.resolve(jsonResponse(201, CONVERSATION_BODY));
    }
    if (url.includes("/messages")) {
      // A cursor-bearing request is the reconnect catch-up: it has nothing
      // further to return unless a test overrides this mock.
      return Promise.resolve(jsonResponse(200, url.includes("cursor=") ? historyBody([]) : historyBody(history)));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: {} }));
  });
}

function shadowOf(host: Element): ShadowRoot {
  const shadow = host.shadowRoot;
  if (shadow === null) throw new Error("expected a shadow root");
  return shadow;
}

function findHost(): HTMLElement | null {
  return document.querySelector("[data-serviqo-widget-host]");
}

/** Mounts, opens the panel, and waits for the chat surface to be ready. */
async function mountAndOpen(harness: FakeSocketHarness) {
  initWidget(CONFIG, { socketFactory: harness.factory });
  const shadow = shadowOf(findHost()!);
  (shadow.querySelector(".launcher") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(shadow.querySelector(".chat")).not.toBeNull());
  return shadow;
}

/** Completes the socket handshake and the join ack the client waits on. */
async function connectAndJoin(harness: FakeSocketHarness) {
  await vi.waitFor(() => expect(harness.sockets.length).toBeGreaterThan(0));
  const socket = harness.last();
  socket.simulateConnect();
  await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join")).toBe(true));
  socket.respondTo("conversation:join", { ok: true, data: CONVERSATION_BODY.data });
  return socket;
}

function bodies(shadow: ShadowRoot): string[] {
  return [...shadow.querySelectorAll(".msg__body")].map((el) => el.textContent ?? "");
}

afterEach(() => {
  findHost()?.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("initWidget", () => {
  // ---- mount and shell (ADR-021, preserved) ----

  describe("mount and isolation", () => {
    it("mounts one host element into document.body with an open shadow root", () => {
      vi.stubGlobal("fetch", routedFetch());

      initWidget(CONFIG, { socketFactory: createFakeSocketHarness().factory });

      const host = findHost();
      expect(host).not.toBeNull();
      expect(host!.parentElement).toBe(document.body);
      expect(host!.shadowRoot!.mode).toBe("open");
    });

    it("renders the chat entirely inside the shadow root, leaking nothing into the page", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "in the shadow")] }));
      const harness = createFakeSocketHarness();

      const shadow = await mountAndOpen(harness);

      expect(shadow.querySelector(".chat__list")).not.toBeNull();
      // The light DOM holds the host and nothing else the widget rendered.
      expect(document.querySelector(".chat")).toBeNull();
      expect(document.body.textContent).not.toContain("in the shadow");
    });

    it("returns null and mounts nothing when Shadow DOM is unsupported", () => {
      const original = Element.prototype.attachShadow;
      // @ts-expect-error -- deliberately simulating an old browser for this one test
      delete Element.prototype.attachShadow;

      const handle = initWidget(CONFIG);

      expect(handle).toBeNull();
      expect(findHost()).toBeNull();

      Element.prototype.attachShadow = original;
    });

    it("keeps the mobile full-screen breakpoint and a pinned composer", () => {
      vi.stubGlobal("fetch", routedFetch());
      initWidget(CONFIG, { socketFactory: createFakeSocketHarness().factory });

      const css = shadowOf(findHost()!).querySelector("style")!.textContent ?? "";
      expect(css).toContain("@media (max-width: 480px)");
      // The list scrolls, so the composer stays reachable above the keyboard.
      expect(css).toContain(".chat__list");
      expect(css).toContain("overflow-y: auto");
    });

    it("does not connect a socket or call the API before the panel is opened", () => {
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();

      initWidget(CONFIG, { socketFactory: harness.factory });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(harness.sockets).toHaveLength(0);
    });
  });

  // ---- the open sequence (ADR-024 §3) ----

  describe("the open sequence", () => {
    it("calls session, then conversation, then history, then connects the socket", async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();

      await mountAndOpen(harness);

      const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
      expect(urls[0]).toContain("/session");
      expect(urls[1]).toContain("/conversations");
      expect(urls[2]).toContain("/messages");
      // History is fetched BEFORE the socket exists, so no message can slip
      // between the snapshot and the first listener (ADR-024 §3).
      await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    });

    it("authenticates the socket with the session token and never a second credential", async () => {
      vi.stubGlobal("fetch", routedFetch({ sessionToken: "TOKEN_FROM_SESSION" }));
      const harness = createFakeSocketHarness();

      await mountAndOpen(harness);
      await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));

      expect(harness.last().options.auth).toEqual({ token: "TOKEN_FROM_SESSION" });
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("TOKEN_FROM_SESSION");
    });

    it("joins the conversation the REST call resolved", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();

      await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      const join = socket.emissions.find((e) => e.event === "conversation:join");
      expect(join!.payload).toEqual({ conversationId: CONVERSATION_ID });
    });
  });

  // ---- history ----

  describe("message history", () => {
    it("renders existing history on open, oldest first", async () => {
      vi.stubGlobal(
        "fetch",
        routedFetch({ history: [message("m1", "first"), message("m2", "second"), message("m3", "third", "agent")] }),
      );

      const shadow = await mountAndOpen(createFakeSocketHarness());

      expect(bodies(shadow)).toEqual(["first", "second", "third"]);
    });

    it("styles an agent message distinctly from a customer message", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "mine"), message("m2", "theirs", "agent")] }));

      const shadow = await mountAndOpen(createFakeSocketHarness());

      expect(shadow.querySelectorAll(".msg--customer")).toHaveLength(1);
      expect(shadow.querySelectorAll(".msg--agent")).toHaveLength(1);
    });

    it("shows an empty state when there is no history yet", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [] }));

      const shadow = await mountAndOpen(createFakeSocketHarness());

      expect(shadow.querySelector(".chat__empty")).not.toBeNull();
      expect(bodies(shadow)).toEqual([]);
    });

    it("renders a message body as text, never as markup", async () => {
      const hostile = '<img src=x onerror="alert(1)">';
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", hostile)] }));

      const shadow = await mountAndOpen(createFakeSocketHarness());

      // ADR-022 §9 assigned this obligation to the consuming component.
      expect(shadow.querySelector(".msg__body")!.textContent).toBe(hostile);
      expect(shadow.querySelector(".msg__body")!.querySelector("img")).toBeNull();
    });
  });

  // ---- sending ----

  describe("sending a message", () => {
    it("emits message:send and renders the persisted message from the ack", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      const input = shadow.querySelector(".chat__input") as HTMLTextAreaElement;
      input.value = "hello there";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();

      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
      const sent = socket.emissions.find((e) => e.event === "message:send");
      expect(sent!.payload).toEqual({ conversationId: CONVERSATION_ID, body: "hello there" });

      socket.respondTo("message:send", { ok: true, data: message("m10", "hello there") });

      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["hello there"]));
      expect(input.value).toBe("");
    });

    it("does not render optimistically before the server confirms", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      const input = shadow.querySelector(".chat__input") as HTMLTextAreaElement;
      input.value = "not yet persisted";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));

      // The ack has not been answered: nothing claims the server has it.
      expect(bodies(shadow)).toEqual([]);
    });

    it("ignores an empty or whitespace-only composer", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      const input = shadow.querySelector(".chat__input") as HTMLTextAreaElement;
      input.value = "   \n  ";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();

      expect(socket.emissions.filter((e) => e.event === "message:send")).toHaveLength(0);
    });

    it("bounds the composer at the server's message length, without replacing server validation", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const shadow = await mountAndOpen(createFakeSocketHarness());

      expect((shadow.querySelector(".chat__input") as HTMLTextAreaElement).maxLength).toBe(4000);
    });

    it("restores the typed text and shows a notice when a send fails", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      const input = shadow.querySelector(".chat__input") as HTMLTextAreaElement;
      input.value = "a paragraph the visitor typed";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));

      socket.respondTo("message:send", { ok: false, error: { code: "TOO_MANY_REQUESTS", message: "…" } });

      await vi.waitFor(() => expect(shadow.querySelector(".chat__notice")!.hasAttribute("hidden")).toBe(false));
      // The visitor must not lose what they typed.
      expect(input.value).toBe("a paragraph the visitor typed");
      expect(bodies(shadow)).toEqual([]);
    });

    it("never renders the server's own error text for a failed send", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      (shadow.querySelector(".chat__input") as HTMLTextAreaElement).value = "hi";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
      socket.respondTo("message:send", { ok: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });

      await vi.waitFor(() => expect(shadow.querySelector(".chat__notice")!.hasAttribute("hidden")).toBe(false));
      const notice = shadow.querySelector(".chat__notice")!.textContent ?? "";
      expect(notice).not.toContain("NOT_FOUND");
      expect(notice).not.toContain("Conversation not found");
    });
  });

  // ---- receiving ----

  describe("receiving messages in real time", () => {
    it("renders a message:new broadcast as it arrives", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.fire("message:new", message("m20", "an agent replied", "agent"));

      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["an agent replied"]));
      expect(shadow.querySelector(".msg--agent")).not.toBeNull();
    });

    it("announces new messages politely without stealing focus", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const shadow = await mountAndOpen(createFakeSocketHarness());

      const list = shadow.querySelector(".chat__list")!;
      expect(list.getAttribute("role")).toBe("log");
      expect(list.getAttribute("aria-live")).toBe("polite");
    });

    it("ignores a malformed broadcast rather than rendering it", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.fire("message:new", { id: "x", body: "no senderType" });
      socket.fire("message:new", null);

      expect(bodies(shadow)).toEqual([]);
    });
  });

  // ---- duplicate prevention (ADR-024 §4) ----

  describe("duplicate prevention", () => {
    it("renders a message once when the ack and the broadcast both carry it", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      (shadow.querySelector(".chat__input") as HTMLTextAreaElement).value = "echoed";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));

      // The server echoes to the whole room INCLUDING the sender (ADR-023 §5),
      // so both paths deliver the same persisted message.
      socket.fire("message:new", message("m30", "echoed"));
      socket.respondTo("message:send", { ok: true, data: message("m30", "echoed") });

      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["echoed"]));
    });

    it("renders a message once when history and a live broadcast overlap", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "already in history")] }));
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.fire("message:new", message("m1", "already in history"));

      expect(bodies(shadow)).toEqual(["already in history"]);
    });

    it("does not duplicate messages when the catch-up re-returns one already rendered", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse(201, sessionBody()));
        if (url.endsWith("/conversations") && init?.method === "POST")
          return Promise.resolve(jsonResponse(201, CONVERSATION_BODY));
        // Both the initial load and the catch-up return the same message.
        return Promise.resolve(jsonResponse(200, historyBody([message("m1", "seen once")])));
      });
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.simulateDisconnect();
      socket.simulateConnect();
      await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
      socket.respondTo("conversation:join", { ok: true, data: CONVERSATION_BODY.data }, 1);

      await vi.waitFor(() => expect(fetchMock.mock.calls.filter((c) => (c as [string])[0].includes("cursor=")).length).toBe(1));
      expect(bodies(shadow)).toEqual(["seen once"]);
    });

    it("does not duplicate history when the panel is closed and reopened", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "one"), message("m2", "two")] }));
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      await connectAndJoin(harness);

      const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;
      launcher.click(); // close
      launcher.click(); // reopen

      await vi.waitFor(() => expect(shadow.querySelector(".chat")).not.toBeNull());
      expect(bodies(shadow)).toEqual(["one", "two"]);
    });
  });

  // ---- reconnect and re-join (ADR-024 §5) ----

  describe("reconnect and re-join", () => {
    it("re-joins on every reconnect and catches up from the last rendered message", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse(201, sessionBody()));
        if (url.endsWith("/conversations") && init?.method === "POST")
          return Promise.resolve(jsonResponse(201, CONVERSATION_BODY));
        if (url.includes("cursor=m1")) return Promise.resolve(jsonResponse(200, historyBody([message("m2", "missed while away")])));
        return Promise.resolve(jsonResponse(200, historyBody([message("m1", "before the drop")])));
      });
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.simulateDisconnect();
      await vi.waitFor(() => expect(shadow.querySelector(".chat__status")!.textContent).toBe("Reconnecting…"));

      socket.simulateConnect();
      await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
      socket.respondTo("conversation:join", { ok: true, data: CONVERSATION_BODY.data }, 1);

      // The message persisted while the socket was away is recovered over
      // the existing cursor endpoint — no server-side replay exists.
      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["before the drop", "missed while away"]));
    });

    it("keeps the conversation readable while reconnecting", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "still readable")] }));
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.simulateDisconnect();

      await vi.waitFor(() => expect(shadow.querySelector(".chat__status")!.textContent).toBe("Reconnecting…"));
      expect(bodies(shadow)).toEqual(["still readable"]);
      // Reconnecting is not failure: the composer stays usable.
      expect((shadow.querySelector(".chat__input") as HTMLTextAreaElement).disabled).toBe(false);
    });

    it("survives a re-join that is refused, without duplicating or losing the conversation", async () => {
      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "intact")] }));
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.simulateDisconnect();
      socket.simulateConnect();
      await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
      socket.respondTo("conversation:join", { ok: false, error: { code: "NOT_FOUND", message: "…" } }, 1);

      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["intact"]));
    });
  });

  // ---- transport state (ADR-024 §7) ----

  describe("transport state", () => {
    it("shows no status line while connected", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      await connectAndJoin(harness);

      await vi.waitFor(() => expect(shadow.querySelector(".chat__status")!.hasAttribute("hidden")).toBe(true));
    });

    it("disables the composer only when the connection has failed", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));

      harness.last().simulateConnectError("Authentication required");

      await vi.waitFor(() =>
        expect((shadow.querySelector(".chat__input") as HTMLTextAreaElement).disabled).toBe(true),
      );
      expect((shadow.querySelector(".chat__send") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  // ---- token rejection (ADR-024 §8) ----

  describe("token rejection", () => {
    it("clears the stored token when the handshake is refused as an auth failure", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      await mountAndOpen(harness);
      await vi.waitFor(() => expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("TOKEN_1"));

      harness.last().simulateConnectError("Authentication required");

      // Keeping a refused credential would make every retry and every reload
      // fail identically for the life of the tab (ADR-024 §8).
      await vi.waitFor(() => expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull());
    });

    it("keeps the stored token when the failure is only a transport error", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      await mountAndOpen(harness);
      await vi.waitFor(() => expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("TOKEN_1"));

      harness.last().simulateConnectError("websocket error");

      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("TOKEN_1");
    });

    it("clears the stored token when a REST call rejects the credential", async () => {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, "STALE_TOKEN");
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse(201, sessionBody("TOKEN_1")));
        // The conversation call refuses the credential.
        return Promise.resolve(jsonResponse(401, { success: false, error: { code: "INVALID_WIDGET_TOKEN" } }));
      });
      vi.stubGlobal("fetch", fetchMock);

      initWidget(CONFIG, { socketFactory: createFakeSocketHarness().factory });
      const shadow = shadowOf(findHost()!);
      (shadow.querySelector(".launcher") as HTMLButtonElement).click();

      await vi.waitFor(() => expect(shadow.querySelector('[role="alert"]')).not.toBeNull());
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    });
  });

  // ---- customer isolation, from the client's side ----

  describe("customer isolation", () => {
    it("renders nothing when the server refuses the conversation as not found", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse(201, sessionBody()));
        // The server's opaque refusal for a conversation that is not this
        // customer's (ADR-022 §8) — identical to one that does not exist.
        return Promise.resolve(jsonResponse(404, { success: false, error: { code: "NOT_FOUND" } }));
      });
      vi.stubGlobal("fetch", fetchMock);

      initWidget(CONFIG, { socketFactory: createFakeSocketHarness().factory });
      const shadow = shadowOf(findHost()!);
      (shadow.querySelector(".launcher") as HTMLButtonElement).click();

      await vi.waitFor(() => expect(shadow.querySelector('[role="alert"]')).not.toBeNull());
      expect(shadow.querySelector(".chat")).toBeNull();
    });

    it("never sends an organizationId or customerId the client could have forged", async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      (shadow.querySelector(".chat__input") as HTMLTextAreaElement).value = "hi";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));

      const everySocketPayload = JSON.stringify(socket.emissions);
      const everyRequestBody = JSON.stringify(fetchMock.mock.calls);
      for (const forbidden of ["organizationId", "customerId", "senderType"]) {
        expect(everySocketPayload).not.toContain(forbidden);
        expect(everyRequestBody).not.toContain(forbidden);
      }
    });
  });

  // ---- errors ----

  describe("error handling", () => {
    it("shows an error state and offers a retry that re-runs the open sequence", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { success: false, error: { code: "WIDGET_SESSION_REFUSED" } }));
      vi.stubGlobal("fetch", fetchMock);

      initWidget(CONFIG, { socketFactory: createFakeSocketHarness().factory });
      const shadow = shadowOf(findHost()!);
      (shadow.querySelector(".launcher") as HTMLButtonElement).click();

      await vi.waitFor(() => expect(shadow.querySelector('[role="alert"]')).not.toBeNull());
      expect(shadow.querySelector(".error p")!.textContent).not.toContain("WIDGET_SESSION_REFUSED");

      vi.stubGlobal("fetch", routedFetch({ history: [message("m1", "recovered")] }));
      (shadow.querySelector(".retry") as HTMLButtonElement).click();

      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["recovered"]));
    });

    it("still shows the conversation when the catch-up fetch fails", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/session")) return Promise.resolve(jsonResponse(201, sessionBody()));
        if (url.endsWith("/conversations") && init?.method === "POST")
          return Promise.resolve(jsonResponse(201, CONVERSATION_BODY));
        if (url.includes("cursor=")) return Promise.reject(new Error("network down"));
        return Promise.resolve(jsonResponse(200, historyBody([message("m1", "kept")])));
      });
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      socket.simulateDisconnect();
      socket.simulateConnect();
      await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join", 1)).toBe(true));
      socket.respondTo("conversation:join", { ok: true, data: CONVERSATION_BODY.data }, 1);

      await vi.waitFor(() => expect(bodies(shadow)).toEqual(["kept"]));
    });
  });

  // ---- what never reaches the console (ADR-024 §9) ----

  describe("what never reaches the console", () => {
    it("logs no token, message body, or personal detail across the full flow", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

      vi.stubGlobal(
        "fetch",
        routedFetch({
          sessionToken: "SENTINEL_TOKEN_VALUE",
          history: [message("m1", "SENTINEL_HISTORY_BODY")],
          customer: { id: "c1", name: "SENTINEL_NAME", email: "sentinel@example.com" },
        }),
      );
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);
      const socket = await connectAndJoin(harness);

      (shadow.querySelector(".chat__input") as HTMLTextAreaElement).value = "SENTINEL_TYPED_BODY";
      (shadow.querySelector(".chat__composer") as HTMLFormElement).requestSubmit();
      await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
      socket.respondTo("message:send", { ok: false, error: { code: "NOT_FOUND", message: "…" } });
      socket.simulateConnectError("websocket error to internal-host:3001");

      const output = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
        ...infoSpy.mock.calls,
      ]
        .flat()
        .map((v) => String(v))
        .join(" ");

      expect(output).not.toContain("SENTINEL_TOKEN_VALUE");
      expect(output).not.toContain("SENTINEL_HISTORY_BODY");
      expect(output).not.toContain("SENTINEL_TYPED_BODY");
      expect(output).not.toContain("SENTINEL_NAME");
      expect(output).not.toContain("sentinel@example.com");
      expect(output).not.toContain("internal-host");
      expect(output).not.toContain(CONFIG.widgetKey);

      for (const spy of [logSpy, warnSpy, errorSpy, infoSpy]) spy.mockRestore();
    });

    it("exposes no debug handle on window", async () => {
      vi.stubGlobal("fetch", routedFetch());
      await mountAndOpen(createFakeSocketHarness());

      const globals = window as unknown as Record<string, unknown>;
      expect(globals.__serviqo).toBeUndefined();
      expect(globals.serviqo).toBeUndefined();
    });
  });

  // ---- preserved ADR-021 behavior ----

  describe("preserved shell behavior", () => {
    it("closes on Escape and returns focus to the launcher", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(shadow.querySelector(".panel")!.hasAttribute("hidden")).toBe(true);
      expect(shadow.activeElement).toBe(shadow.querySelector(".launcher"));
    });

    it("does not re-open a session on a second open once one is ready", async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);

      const sessionCalls = fetchMock.mock.calls.filter((c) => (c as [string])[0].endsWith("/session")).length;
      const launcher = shadow.querySelector(".launcher") as HTMLButtonElement;
      launcher.click();
      launcher.click();

      expect(fetchMock.mock.calls.filter((c) => (c as [string])[0].endsWith("/session"))).toHaveLength(sessionCalls);
    });

    it("offers the optional name/email form and resumes the same session on submit", async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);
      const harness = createFakeSocketHarness();
      const shadow = await mountAndOpen(harness);

      expect(shadow.querySelector(".details--chat")).not.toBeNull();

      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(jsonResponse(201, sessionBody("TOKEN_2", { id: "c1", name: "Ada", email: null }))),
      );
      const nameInput = shadow.querySelector("#serviqo-widget-name") as HTMLInputElement;
      nameInput.value = "Ada";
      (shadow.querySelector(".details--chat form") as HTMLFormElement).requestSubmit();

      // Once the server confirms it holds the details, the control is gone.
      await vi.waitFor(() => expect(shadow.querySelector(".details--chat")).toBeNull());
      const resumeCall = fetchMock.mock.calls.find(
        (c) => (c as [string])[0].endsWith("/session") && (c as [string, RequestInit])[1]?.body !== undefined && String((c as [string, RequestInit])[1].body).includes("visitorToken"),
      ) as [string, RequestInit];
      expect(JSON.parse(resumeCall[1].body as string)).toMatchObject({ visitorToken: "TOKEN_1", name: "Ada" });
    });

    it("destroy() removes the host, closes the socket, and stops listening for Escape", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      const handle = initWidget(CONFIG, { socketFactory: harness.factory })!;
      const shadow = shadowOf(findHost()!);
      (shadow.querySelector(".launcher") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));

      handle.destroy();

      expect(findHost()).toBeNull();
      // The socket must not outlive the mount that opened it.
      expect(harness.last().disconnectCalls).toBe(1);
      expect(harness.last().removeAllListenersCalls).toBe(1);
      expect(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))).not.toThrow();
    });
  });

  // ---- ADR-038: the hosted page, the visitor key, optional phone ----

  describe("the hosted chat page presentation", () => {
    function mountPage(harness: FakeSocketHarness, title = "CentralService") {
      const container = document.createElement("div");
      document.body.appendChild(container);
      initWidget(CONFIG, { socketFactory: harness.factory, presentation: "page", container, title });
      return { container, shadow: shadowOf(findHost()!) };
    }

    afterEach(() => {
      document.body.replaceChildren();
    });

    it("mounts into the given container, open, with no launcher and no close button", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();

      const { container, shadow } = mountPage(harness);

      expect(findHost()!.parentElement).toBe(container);
      expect(shadow.querySelector(".launcher")).toBeNull();
      expect((shadow.querySelector(".panel") as HTMLElement).hidden).toBe(false);
      expect((shadow.querySelector(".panel__close") as HTMLElement).hidden).toBe(true);
      // Opens the session without waiting for a click: the chat is the page.
      await vi.waitFor(() => expect(shadow.querySelector(".chat")).not.toBeNull());
    });

    it("titles the chat with the organisation's name, as text", () => {
      vi.stubGlobal("fetch", routedFetch());

      const { shadow } = mountPage(createFakeSocketHarness(), "<b>Central</b>Service");

      const title = shadow.querySelector(".panel__title")!;
      expect(title.textContent).toBe("<b>Central</b>Service");
      expect(title.querySelector("b")).toBeNull();
    });

    it("is not a modal dialog, and Escape does not close it", async () => {
      vi.stubGlobal("fetch", routedFetch());
      const { shadow } = mountPage(createFakeSocketHarness());
      await vi.waitFor(() => expect(shadow.querySelector(".chat")).not.toBeNull());

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      const panel = shadow.querySelector(".panel") as HTMLElement;
      expect(panel.getAttribute("role")).toBeNull();
      expect(panel.getAttribute("aria-modal")).toBeNull();
      expect(panel.hidden).toBe(false);
    });
  });

  describe("the visitor key", () => {
    function sessionRequests(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
      return fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/session"))
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    }

    it("stores the key the server issues", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/session")) {
          return Promise.resolve(
            jsonResponse(201, {
              success: true,
              data: { token: "TOKEN_1", expiresInSeconds: 86400, customer: ANONYMOUS_CUSTOMER, visitorKey: VISITOR_KEY },
            }),
          );
        }
        return routedFetch()(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      await mountAndOpen(createFakeSocketHarness());

      await vi.waitFor(() => expect(window.localStorage.getItem(VISITOR_KEY_STORAGE_KEY)).toBe(VISITOR_KEY));
    });

    it("offers a stored key with the stored token, so an expired token still finds the conversation", async () => {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, "OLD_TOKEN");
      window.localStorage.setItem(VISITOR_KEY_STORAGE_KEY, VISITOR_KEY);
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);

      await mountAndOpen(createFakeSocketHarness());

      expect(sessionRequests(fetchMock)[0]).toEqual({
        widgetKey: CONFIG.widgetKey,
        visitorToken: "OLD_TOKEN",
        visitorKey: VISITOR_KEY,
      });
    });

    it("keeps the key when a refused token is cleared", async () => {
      window.localStorage.setItem(VISITOR_KEY_STORAGE_KEY, VISITOR_KEY);
      vi.stubGlobal("fetch", routedFetch());
      const harness = createFakeSocketHarness();
      await mountAndOpen(harness);
      await vi.waitFor(() => expect(harness.sockets.length).toBeGreaterThan(0));

      harness.last().simulateConnectError("Authentication required");

      await vi.waitFor(() => expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull());
      expect(window.localStorage.getItem(VISITOR_KEY_STORAGE_KEY)).toBe(VISITOR_KEY);
    });
  });

  describe("optional phone number", () => {
    it("offers a phone field beside name and email, and sends it when given", async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal("fetch", fetchMock);
      const shadow = await mountAndOpen(createFakeSocketHarness());

      const phone = shadow.querySelector("#serviqo-widget-phone") as HTMLInputElement;
      expect(phone).not.toBeNull();
      expect(phone.type).toBe("tel");

      phone.value = "+44 20 7946 0958";
      (shadow.querySelector(".details--chat form") as HTMLFormElement).requestSubmit();

      await vi.waitFor(() => {
        const bodies = fetchMock.mock.calls
          .filter(([url]) => String(url).endsWith("/session"))
          .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
        expect(bodies.at(-1)).toMatchObject({ phone: "+44 20 7946 0958", visitorToken: "TOKEN_1" });
      });
    });
  });
});
