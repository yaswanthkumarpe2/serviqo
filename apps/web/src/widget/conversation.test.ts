import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_HISTORY_PAGES,
  WidgetAuthError,
  WidgetConversationError,
  listMessages,
  loadHistory,
  resolveConversation,
} from "./conversation";

const API_BASE = "https://dashboard.example.com/api/v1/widget";
const TOKEN = "TOKEN_SENTINEL_VALUE";
const CONVERSATION_ID = "6a8c0fbf909d5192a6bbd66f";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function ok(data: unknown): Response {
  return jsonResponse(200, { success: true, data });
}

function message(id: string, body = "hello") {
  return {
    id,
    conversationId: CONVERSATION_ID,
    senderType: "customer",
    body,
    createdAt: "2026-08-24T09:35:02.207Z",
  };
}

const CONVERSATION = {
  id: CONVERSATION_ID,
  status: "open",
  createdAt: "2026-08-24T09:32:47.215Z",
  lastMessageAt: "2026-08-24T09:32:47.213Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveConversation", () => {
  it("POSTs to /conversations with the bearer token and returns the conversation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: CONVERSATION }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveConversation(API_BASE, TOKEN);

    expect(result).toEqual(CONVERSATION);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/conversations`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no identity fields in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: CONVERSATION }));
    vi.stubGlobal("fetch", fetchMock);

    await resolveConversation(API_BASE, TOKEN);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The server derives both from the token (ADR-022 §5); the widget has no
    // way to know them and never sends them.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it.each([
    [401, "an unusable credential"],
    [403, "a refused session"],
  ])("raises WidgetAuthError on %i (%s) so the caller can clear the token", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, { success: false, error: {} })));

    await expect(resolveConversation(API_BASE, TOKEN)).rejects.toBeInstanceOf(WidgetAuthError);
  });

  it("raises a plain WidgetConversationError on a server fault, which must NOT clear the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { success: false, error: {} })));

    const error = await resolveConversation(API_BASE, TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WidgetConversationError);
    expect(error).not.toBeInstanceOf(WidgetAuthError);
  });

  it("raises on a transport failure without attaching the underlying error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:3001")));

    const error = await resolveConversation(API_BASE, TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WidgetConversationError);
    // An internal host must not reach a message rendered on a tenant's page.
    expect((error as Error).message).not.toContain("10.0.0.5");
    expect((error as Error).message).toBe("Chat is not available right now.");
  });

  it("rejects a malformed conversation payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ id: CONVERSATION_ID })));

    await expect(resolveConversation(API_BASE, TOKEN)).rejects.toBeInstanceOf(WidgetConversationError);
  });
});

describe("listMessages", () => {
  it("GETs history with no query parameters when none are given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ messages: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await listMessages(API_BASE, TOKEN, CONVERSATION_ID);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/conversations/${CONVERSATION_ID}/messages`);
    expect(init.method).toBe("GET");
  });

  it("passes the cursor through as the keyset parameter ADR-022 §11 defines", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ messages: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await listMessages(API_BASE, TOKEN, CONVERSATION_ID, { cursor: "m5", limit: 10 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("cursor=m5");
    expect(url).toContain("limit=10");
  });

  it("rejects a page whose messages are malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ messages: [{ id: "m1" }], nextCursor: null })));

    await expect(listMessages(API_BASE, TOKEN, CONVERSATION_ID)).rejects.toBeInstanceOf(WidgetConversationError);
  });

  it("rejects a message claiming an unknown senderType", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ messages: [{ ...message("m1"), senderType: "root" }], nextCursor: null })),
    );

    await expect(listMessages(API_BASE, TOKEN, CONVERSATION_ID)).rejects.toBeInstanceOf(WidgetConversationError);
  });
});

describe("loadHistory", () => {
  it("returns a single page unchanged when there is no next cursor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ messages: [message("m1"), message("m2")], nextCursor: null })));

    const history = await loadHistory(API_BASE, TOKEN, CONVERSATION_ID);

    expect(history.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("walks successive pages forward and concatenates them in order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ messages: [message("m1"), message("m2")], nextCursor: "m2" }))
      .mockResolvedValueOnce(ok({ messages: [message("m3")], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const history = await loadHistory(API_BASE, TOKEN, CONVERSATION_ID);

    expect(history.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect((fetchMock.mock.calls[1] as [string])[0]).toContain("cursor=m2");
  });

  it("starts from a supplied cursor, which is how the reconnect catch-up works", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ messages: [message("m7")], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await loadHistory(API_BASE, TOKEN, CONVERSATION_ID, "m6");

    expect((fetchMock.mock.calls[0] as [string])[0]).toContain("cursor=m6");
  });

  it("stops at the page bound rather than spinning on a server that never returns a null cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ messages: [message("m1")], nextCursor: "m1" }));
    vi.stubGlobal("fetch", fetchMock);

    await loadHistory(API_BASE, TOKEN, CONVERSATION_ID);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_HISTORY_PAGES);
  });
});
