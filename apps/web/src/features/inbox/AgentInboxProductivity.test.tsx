import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";

import { AgentInbox } from "./AgentInbox";
import { matchSavedReplies, matchTeammates, mentionAt, mentionedIds, savedReplyQuery } from "./composerSuggestions";
import { SavedRepliesSettings } from "./SavedRepliesSettings";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Agent productivity in the inbox (ADR-042): search and filters, tags,
 * internal notes with @mentions, saved replies, and keyboard shortcuts.
 */

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: "SEEDED_ACCESS_TOKEN",
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const ROWS = [
  {
    id: "c1",
    status: "open",
    createdAt: "2026-09-14T09:00:00.000Z",
    lastMessageAt: "2026-09-14T10:00:00.000Z",
    customer: { id: "cust-1", name: "Grace", email: null },
    assignedTo: null,
    tags: ["billing"],
  },
  {
    id: "c2",
    status: "open",
    createdAt: "2026-09-14T09:00:00.000Z",
    lastMessageAt: "2026-09-14T09:50:00.000Z",
    customer: { id: "cust-2", name: "Linus", email: null },
    assignedTo: null,
    tags: [],
  },
];

const HISTORY = [
  { id: "m1", conversationId: "c1", senderType: "customer", body: "Refund please", createdAt: "2026-09-14T09:00:00.000Z" },
];

const NOTE = {
  id: "n1",
  conversationId: "c1",
  author: { id: "u-olivia", name: "Olivia Owner" },
  body: "Customer is a VIP",
  mentions: [],
  createdAt: "2026-09-14T09:05:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;

function requests(pattern: RegExp, method = "GET") {
  return fetchMock.mock.calls.filter(
    ([url, init]) => pattern.test(String(url)) && ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  const base = stubAuthFetch();
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const [path, query = ""] = String(url).split("?");
    const method = init?.method ?? "GET";
    const ok = (data: unknown, status = 200) => Promise.resolve(jsonResponse(status, { success: true, data }));

    if (path!.endsWith("/saved-replies")) {
      return ok({ savedReplies: [{ id: "r1", shortcut: "refund", title: "Refund policy", body: "Refunds take 5 days." }] });
    }
    if (path!.endsWith("/teammates")) {
      return ok({ teammates: [{ id: CURRENT_USER.id, name: CURRENT_USER.name }, { id: "u-alan", name: "Alan Agent" }] });
    }
    if (path!.endsWith("/conversations/tags")) return ok({ tags: ["billing", "shipping"] });
    if (/\/c1\/notes$/.test(path!) && method === "POST") {
      const sent = JSON.parse(init!.body as string);
      return ok({ ...NOTE, id: "n2", body: sent.body, author: { id: CURRENT_USER.id, name: CURRENT_USER.name }, createdAt: "2026-09-14T10:02:00.000Z" }, 201);
    }
    if (/\/notes$/.test(path!)) return ok({ notes: /\/c1\//.test(path!) ? [NOTE] : [] });
    if (/\/c1\/tags$/.test(path!) && method === "PUT") {
      return ok({ ...ROWS[0], tags: JSON.parse(init!.body as string).tags });
    }
    if (/\/c1\/messages$/.test(path!)) return ok({ messages: HISTORY, nextCursor: null });
    if (/\/messages$/.test(path!)) return ok({ messages: [], nextCursor: null });
    if (/\/conversations$/.test(path!)) {
      const params = new URLSearchParams(query);
      const rows = params.get("q") === "nobody" ? [] : params.get("assignee") === "me" ? [ROWS[1]] : ROWS;
      return ok({ conversations: rows, nextCursor: null });
    }
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderInbox() {
  const harness = createFakeInboxSocketHarness();
  render(
    <AuthProvider initialSession={session}>
      <AgentInbox key="org-acme" organizationId="org-acme" socketFactory={harness.factory} />
    </AuthProvider>,
  );
  await screen.findByRole("button", { name: /Grace/ });
  const socket = harness.last();
  act(() => socket.simulateConnect());
  return socket;
}

async function openGrace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Grace/ }));
  await screen.findByText("Refund please");
}

describe("search and filters", () => {
  it("asks the server for mine, and for a search, and says when nothing matches", async () => {
    await renderInbox();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Mine" }));
    await waitFor(() => expect(requests(/assignee=me/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Grace/ })).toBeNull());

    await user.type(screen.getByLabelText("Search conversations"), "nobody");
    await waitFor(() => expect(requests(/q=nobody/).length).toBeGreaterThan(0), { timeout: 2000 });
    expect(await screen.findByText("No conversations match these filters.")).toBeDefined();
    // The filters stay on screen, so the agent can undo them.
    expect(screen.getByLabelText("Search conversations")).toBeDefined();
  });

  it("shows a conversation's tags on its row and filters by tag", async () => {
    await renderInbox();

    const row = screen.getByRole("button", { name: /Grace/ });
    expect(within(row).getByText("billing")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "shipping" } });
    await waitFor(() => expect(requests(/tag=shipping/)).toHaveLength(1));
  });
});

describe("tags", () => {
  it("adds a normalised tag to the open conversation", async () => {
    await renderInbox();
    const user = userEvent.setup();
    await openGrace(user);

    await user.type(screen.getByLabelText("Add a tag"), "  VIP   Customer {Enter}");

    await waitFor(() => expect(requests(/\/c1\/tags$/, "PUT")).toHaveLength(1));
    const [, init] = requests(/\/c1\/tags$/, "PUT")[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ tags: ["billing", "vip customer"] });
  });
});

describe("internal notes", () => {
  it("shows notes in the thread, labelled, and never as a message", async () => {
    await renderInbox();
    const user = userEvent.setup();
    await openGrace(user);

    const note = await screen.findByText("Customer is a VIP");
    expect(note.closest("li")!.className).toContain("inbox__message--note");
    expect(screen.getByText(/Internal note · Olivia Owner/)).toBeDefined();
  });

  it("writes a note with an @mention picked from the team", async () => {
    await renderInbox();
    const user = userEvent.setup();
    await openGrace(user);

    await user.click(screen.getByRole("tab", { name: /Internal note/ }));
    const box = screen.getByLabelText("Write an internal note");
    await user.type(box, "Please check @al");
    const option = await screen.findByRole("option", { name: "@Alan Agent" });
    // The signed-in agent is never offered to themselves.
    expect(screen.queryByRole("option", { name: `@${CURRENT_USER.name}` })).toBeNull();
    fireEvent.mouseDown(option);
    await user.type(box, "thanks");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => expect(requests(/\/c1\/notes$/, "POST")).toHaveLength(1));
    const [, init] = requests(/\/c1\/notes$/, "POST")[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      body: "Please check @Alan Agent thanks",
      mentionedUserIds: ["u-alan"],
    });
    // A note never goes to the reply endpoint.
    expect(requests(/\/c1\/messages$/, "POST")).toHaveLength(0);
  });

  it("appends a teammate's note that arrives live", async () => {
    const socket = await renderInbox();
    const user = userEvent.setup();
    await openGrace(user);

    act(() => socket.fire("note:new", { ...NOTE, id: "n9", body: "Called them just now", createdAt: "2026-09-14T11:00:00.000Z" }));

    expect(await screen.findByText("Called them just now")).toBeDefined();
  });
});

describe("saved replies", () => {
  it("inserts a saved reply when the agent types its shortcut", async () => {
    await renderInbox();
    const user = userEvent.setup();
    await openGrace(user);

    const reply = screen.getByLabelText("Reply to this conversation") as HTMLTextAreaElement;
    await user.type(reply, "/ref");
    expect(await screen.findByRole("option", { name: /\/refund.*Refund policy/ })).toBeDefined();
    await user.keyboard("{Enter}");

    expect(reply.value).toBe("Refunds take 5 days.");
    // Choosing a suggestion does not send anything.
    expect(requests(/\/c1\/messages$/, "POST")).toHaveLength(0);
  });
});

describe("keyboard shortcuts", () => {
  it("moves through conversations with j and k, and lists shortcuts on ?", async () => {
    await renderInbox();
    const user = userEvent.setup();

    await user.keyboard("j");
    await waitFor(() => expect(screen.getByRole("button", { name: /Grace/ }).getAttribute("aria-current")).toBe("true"));
    await user.keyboard("j");
    await waitFor(() => expect(screen.getByRole("button", { name: /Linus/ }).getAttribute("aria-current")).toBe("true"));
    await user.keyboard("k");
    await waitFor(() => expect(screen.getByRole("button", { name: /Grace/ }).getAttribute("aria-current")).toBe("true"));

    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeDefined();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("does not steal letters typed into the reply box", async () => {
    await renderInbox();
    const user = userEvent.setup();
    await openGrace(user);

    await user.type(screen.getByLabelText("Reply to this conversation"), "jk?");

    expect((screen.getByLabelText("Reply to this conversation") as HTMLTextAreaElement).value).toBe("jk?");
    expect(screen.getByRole("button", { name: /Grace/ }).getAttribute("aria-current")).toBe("true");
  });
});

describe("saved replies settings", () => {
  it("lets a manager create a saved reply", async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={session}>
        <SavedRepliesSettings organizationId="org-acme" canManage />
      </AuthProvider>,
    );

    expect(await screen.findByText("Refund policy")).toBeDefined();
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(201, { success: true, data: { id: "r2", ...JSON.parse(init!.body as string) } })),
    );

    await user.click(screen.getByRole("button", { name: "New saved reply" }));
    await user.type(screen.getByLabelText("Shortcut", { exact: false }), "Shipping");
    await user.type(screen.getByLabelText("Title"), "Shipping times");
    await user.type(screen.getByLabelText("Message"), "2–3 days.");
    await user.click(screen.getByRole("button", { name: "Save reply" }));

    expect(await screen.findByText("Shipping times")).toBeDefined();
    const [, init] = requests(/\/saved-replies$/, "POST")[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ shortcut: "shipping", title: "Shipping times", body: "2–3 days." });
  });

  it("offers no editing controls to an agent", async () => {
    render(
      <AuthProvider initialSession={session}>
        <SavedRepliesSettings organizationId="org-acme" canManage={false} />
      </AuthProvider>,
    );

    expect(await screen.findByText("Refund policy")).toBeDefined();
    expect(screen.queryByRole("button", { name: "New saved reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("composer suggestion rules", () => {
  const replies = [
    { id: "1", shortcut: "refund", title: "Refund policy", body: "" },
    { id: "2", shortcut: "shipping", title: "Where is my refund?", body: "" },
  ];

  it("reads a /shortcut only at the start of an otherwise empty draft", () => {
    expect(savedReplyQuery("/Ref")).toBe("ref");
    expect(savedReplyQuery("/")).toBe("");
    expect(savedReplyQuery("hello /ref")).toBeNull();
    expect(savedReplyQuery("/ref more")).toBeNull();
  });

  it("ranks shortcut matches before title matches", () => {
    expect(matchSavedReplies(replies, "ref").map((r) => r.id)).toEqual(["1", "2"]);
    expect(matchSavedReplies(replies, "ship").map((r) => r.id)).toEqual(["2"]);
  });

  it("finds the @mention at the cursor and matches any part of a name", () => {
    expect(mentionAt("hi @ala", 7)).toEqual({ query: "ala", start: 3 });
    expect(mentionAt("email@example", 13)).toBeNull();
    const team = [
      { id: "a", name: "Alan Agent" },
      { id: "b", name: "Bea Agent" },
      { id: "me", name: "Me Myself" },
    ];
    expect(matchTeammates(team, "agent", "me").map((t) => t.id)).toEqual(["a", "b"]);
    expect(matchTeammates(team, "me", "me")).toEqual([]);
  });

  it("sends only mentions still present in the text", () => {
    const picked = [
      { id: "a", name: "Alan Agent" },
      { id: "b", name: "Bea Agent" },
    ];
    expect(mentionedIds("thanks @Alan Agent", picked)).toEqual(["a"]);
  });
});
