import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";

import { AgentInbox } from "./AgentInbox";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Live chat in the agent inbox (ADR-040): unread counts that come from the
 * server, "customer is typing", "a colleague is replying", "Seen", marking a
 * conversation read, and the new-message sound switch.
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
    customer: { id: "cust-1", name: "Grace", email: "grace@example.com", phone: "+44 20 7946 0958" },
    assignedTo: null,
    unreadCount: 3,
    customerLastReadAt: "2026-09-14T09:31:00.000Z",
  },
  {
    id: "c2",
    status: "open",
    createdAt: "2026-09-14T09:00:00.000Z",
    lastMessageAt: "2026-09-14T09:50:00.000Z",
    customer: { id: "cust-2", name: "Linus", email: null },
    assignedTo: null,
    unreadCount: 0,
  },
];

const HISTORY = [
  { id: "m1", conversationId: "c1", senderType: "customer", body: "Order missing", createdAt: "2026-09-14T09:00:00.000Z" },
  { id: "m2", conversationId: "c1", senderType: "agent", body: "Looking now", createdAt: "2026-09-14T09:30:00.000Z" },
];

function stubInbox() {
  const base = stubAuthFetch();
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url).split("?")[0]!;
    if (/\/c1\/messages$/.test(path)) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { messages: HISTORY, nextCursor: null } }));
    }
    if (/\/messages$/.test(path)) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
    }
    if (/\/conversations$/.test(path)) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { conversations: ROWS, nextCursor: null } }));
    }
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function renderConnected() {
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

beforeEach(() => {
  stubInbox();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentInbox live chat", () => {
  it("shows the unread count the server stored, so it survives a reload", async () => {
    await renderConnected();

    const row = screen.getByRole("button", { name: /Grace/ });
    expect(within(row).getByLabelText("3 new messages")).toBeDefined();
    expect(within(screen.getByRole("button", { name: /Linus/ })).queryByLabelText(/new messages/)).toBeNull();
  });

  it("marks a conversation read for the team when it is opened, and clears its badge", async () => {
    const socket = await renderConnected();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Grace/ }));

    expect(socket.emissions).toContainEqual({ event: "conversation:read", payload: { conversationId: "c1" } });
    expect(within(screen.getByRole("button", { name: /Grace/ })).queryByLabelText(/new messages/)).toBeNull();
  });

  it("clears a badge when a colleague reads the conversation", async () => {
    const socket = await renderConnected();

    act(() => socket.fire("conversation:read", { conversationId: "c1", reader: "agent", readAt: "2026-09-14T10:01:00.000Z" }));

    expect(within(screen.getByRole("button", { name: /Grace/ })).queryByLabelText(/new messages/)).toBeNull();
  });

  it("counts only customer messages as unread, never a colleague's reply", async () => {
    const socket = await renderConnected();

    act(() => {
      socket.deliver({ id: "x1", conversationId: "c2", senderType: "agent", body: "colleague", createdAt: "2026-09-14T10:02:00.000Z" });
    });
    expect(within(screen.getByRole("button", { name: /Linus/ })).queryByLabelText(/new messages/)).toBeNull();

    act(() => {
      socket.deliver({ id: "x2", conversationId: "c2", senderType: "customer", body: "hello", createdAt: "2026-09-14T10:03:00.000Z" });
    });
    expect(within(screen.getByRole("button", { name: /Linus/ })).getByLabelText("1 new messages")).toBeDefined();
  });

  it("shows a customer typing in the list and in the open thread", async () => {
    const socket = await renderConnected();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Grace/ }));
    await screen.findByText("Looking now");

    act(() => socket.fire("typing", { conversationId: "c1", sender: "customer", isTyping: true }));

    expect(within(screen.getByRole("button", { name: /Grace/ })).getByText("typing…")).toBeDefined();
    expect(screen.getByText("Customer is typing…")).toBeDefined();

    act(() => socket.fire("typing", { conversationId: "c1", sender: "customer", isTyping: false }));
    expect(screen.queryByText("Customer is typing…")).toBeNull();
  });

  it("warns when a colleague is replying to the same conversation", async () => {
    const socket = await renderConnected();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Grace/ }));
    await screen.findByText("Looking now");

    act(() => socket.fire("typing", { conversationId: "c1", sender: "agent", isTyping: true }));

    expect(screen.getByText("A colleague is replying to this conversation.")).toBeDefined();
  });

  it("marks the last reply the customer has read as Seen", async () => {
    await renderConnected();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Grace/ }));

    const reply = (await screen.findByText("Looking now")).closest("li")!;
    expect(within(reply).getByText("Seen")).toBeDefined();
  });

  it("shows the contact details the visitor gave", async () => {
    await renderConnected();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Grace/ }));

    expect(await screen.findByText("grace@example.com · +44 20 7946 0958")).toBeDefined();
  });

  it("tells the server the agent is typing as they write a reply", async () => {
    const socket = await renderConnected();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Grace/ }));

    await user.type(await screen.findByLabelText("Reply to this conversation"), "On it");

    await waitFor(() =>
      expect(socket.emissions).toContainEqual({ event: "typing", payload: { conversationId: "c1", isTyping: true } }),
    );
  });

  it("remembers the sound switch in this browser", async () => {
    await renderConnected();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Mute new-message sound" }));

    expect(screen.getByRole("button", { name: "Turn on new-message sound" })).toBeDefined();
    expect(JSON.parse(window.localStorage.getItem("serviqo_inbox_notifications")!)).toMatchObject({ sound: false });
  });
});
