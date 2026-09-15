import { afterEach, describe, expect, it, vi } from "vitest";

import { problemWith } from "./attachments";
import { splitLinks } from "./richText";
import { createFakeSocketHarness } from "./testing/fakeSocket";
import { initWidget } from "./widget";

import type { FakeSocketHarness } from "./testing/fakeSocket";
import type { WidgetConfig } from "./types";

/**
 * Files, emoji and links in the widget (ADR-041 §6).
 */

const CONFIG: WidgetConfig = {
  widgetKey: "wk_files",
  apiBase: "https://api.example.com/api/v1/widget",
  socketOrigin: "https://api.example.com",
};
const CONVERSATION_ID = "6a8c0fbf909d5192a6bbd66f";

const UPLOADED = {
  id: "6a8c0fbf909d5192a6bbd111",
  name: "receipt.png",
  contentType: "image/png",
  size: 2048,
  url: `/api/v1/files/6a8c0fbf909d5192a6bbd111/receipt.png?key=${"k".repeat(43)}`,
};

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function routedFetch(history: unknown[] = []) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) {
      return Promise.resolve(
        json(201, {
          success: true,
          data: { token: "TOKEN_1", expiresInSeconds: 86400, customer: { id: "c1", name: "Ada", email: null, phone: null } },
        }),
      );
    }
    if (url.endsWith("/conversations") && init?.method === "POST") {
      return Promise.resolve(
        json(201, {
          success: true,
          data: { id: CONVERSATION_ID, status: "open", createdAt: "2026-09-14T09:00:00.000Z", lastMessageAt: "2026-09-14T09:00:00.000Z" },
        }),
      );
    }
    if (url.endsWith("/attachments") && init?.method === "POST") {
      return Promise.resolve(json(201, { success: true, data: UPLOADED }));
    }
    if (url.includes("/messages")) {
      return Promise.resolve(json(200, { success: true, data: { messages: url.includes("cursor=") ? [] : history, nextCursor: null } }));
    }
    return Promise.resolve(json(404, { success: false, error: {} }));
  });
}

const host = () => document.querySelector("[data-serviqo-widget-host]") as HTMLElement | null;
const shadow = () => host()!.shadowRoot!;
const $ = <T extends Element>(selector: string) => shadow().querySelector(selector) as T;

async function mountOpen(harness: FakeSocketHarness) {
  initWidget(CONFIG, { socketFactory: harness.factory });
  $<HTMLButtonElement>(".launcher").click();
  await vi.waitFor(() => expect($(".chat")).not.toBeNull());
  await vi.waitFor(() => expect(harness.sockets.length).toBeGreaterThan(0));
  const socket = harness.last();
  socket.simulateConnect();
  await vi.waitFor(() => expect(socket.hasPendingAck("conversation:join")).toBe(true));
  socket.respondTo("conversation:join", { ok: true, data: {} });
  return socket;
}

function pickFiles(files: File[]) {
  const input = $<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

afterEach(() => {
  host()?.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("attachments in the widget", () => {
  it("shows a sent picture from the API's origin, and links in the text", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch([
        {
          id: "m1",
          conversationId: CONVERSATION_ID,
          senderType: "agent",
          body: "Label attached, track at https://track.example.com/123. Not javascript:alert(1)",
          attachments: [UPLOADED],
          createdAt: "2026-09-14T09:01:00.000Z",
        },
      ]),
    );
    await mountOpen(createFakeSocketHarness());

    const image = $<HTMLImageElement>(".msg__image img");
    expect(image.src).toBe(`https://api.example.com${UPLOADED.url}`);
    expect(image.alt).toBe("receipt.png");

    const links = shadow().querySelectorAll<HTMLAnchorElement>(".msg__body a");
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toBe("https://track.example.com/123");
    expect(links[0]!.rel).toContain("noopener");
    expect($(".msg__body").textContent).toContain("javascript:alert(1)");
  });

  it("uploads a picked file, then sends it with the message", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const socket = await mountOpen(createFakeSocketHarness());

    pickFiles([new File([new Uint8Array([0x89, 0x50])], "receipt.png", { type: "image/png" })]);

    await vi.waitFor(() => expect($(".chip--ready")).not.toBeNull());
    const upload = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/attachments"))!;
    expect(upload[0]).toBe(`${CONFIG.apiBase}/conversations/${CONVERSATION_ID}/attachments`);
    expect((upload[1]!.headers as Record<string, string>)["X-Filename"]).toBe("receipt.png");
    expect((upload[1]!.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN_1");

    $<HTMLFormElement>(".chat__composer").requestSubmit();
    await vi.waitFor(() => expect(socket.hasPendingAck("message:send")).toBe(true));
    expect(socket.emissions.find((entry) => entry.event === "message:send")!.payload).toEqual({
      conversationId: CONVERSATION_ID,
      body: "",
      attachmentIds: [UPLOADED.id],
    });

    socket.respondTo("message:send", {
      ok: true,
      data: { id: "m9", conversationId: CONVERSATION_ID, senderType: "customer", body: "", attachments: [UPLOADED], createdAt: "2026-09-14T09:02:00.000Z" },
    });
    await vi.waitFor(() => expect($<HTMLElement>(".chat__tray").hidden).toBe(true));
    expect($(".msg--customer .msg__image")).not.toBeNull();
  });

  it("refuses a file type the server would refuse, without uploading it", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mountOpen(createFakeSocketHarness());

    pickFiles([new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })]);

    expect($(".chat__notice").textContent).toBe("Only images, PDFs and text files can be sent.");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/attachments"))).toBe(false);
  });

  it("inserts an emoji into the message", async () => {
    vi.stubGlobal("fetch", routedFetch());
    await mountOpen(createFakeSocketHarness());
    const input = $<HTMLTextAreaElement>(".chat__input");
    input.value = "Thanks ";
    input.setSelectionRange(7, 7);

    $<HTMLButtonElement>('button[aria-label="Insert emoji"]').click();
    expect($<HTMLElement>(".chat__emoji").hidden).toBe(false);
    Array.from(shadow().querySelectorAll<HTMLButtonElement>(".chat__emojiOption"))
      .find((option) => option.textContent === "🙏")!
      .click();

    expect(input.value).toBe("Thanks 🙏");
    expect($<HTMLElement>(".chat__emoji").hidden).toBe(true);
  });
});

describe("splitLinks", () => {
  it("finds http, https and www links, trimming sentence punctuation", () => {
    expect(splitLinks("See https://a.example/x, or www.b.example.")).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: "https://a.example/x", href: "https://a.example/x" },
      { type: "text", value: ", or " },
      { type: "link", value: "www.b.example", href: "https://www.b.example/" },
      { type: "text", value: "." },
    ]);
  });

  it("keeps a bracketed link's closing bracket out of the link", () => {
    expect(splitLinks("(https://a.example)")[1]).toEqual({ type: "link", value: "https://a.example", href: "https://a.example/" });
  });

  it("never makes a link of anything but http(s)", () => {
    expect(splitLinks("javascript:alert(1) data:text/html,x ftp://x")).toEqual([
      { type: "text", value: "javascript:alert(1) data:text/html,x ftp://x" },
    ]);
  });

  it("checks files before upload", () => {
    expect(problemWith(new File(["x"], "a.txt", { type: "text/plain" }))).toBeNull();
    expect(problemWith(new File([], "a.txt", { type: "text/plain" }))).toBe("That file is empty.");
    expect(problemWith(new File(["x"], "a.html", { type: "text/html" }))).not.toBeNull();
  });
});
