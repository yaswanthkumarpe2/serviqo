import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";

import { AgentInbox } from "./AgentInbox";
import { CustomerProfilePanel } from "./CustomerProfilePanel";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The contact panel (ADR-043): details, a team note, earlier conversations,
 * and blocking and merging for the roles that may.
 */

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: "SEEDED_ACCESS_TOKEN",
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const PROFILE = {
  id: "cust-1",
  name: "Grace",
  email: "grace@example.com",
  phone: null,
  blocked: false,
  profileNote: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  lastSeenAt: "2026-09-14T09:00:00.000Z",
  blockedAt: null,
  blockedBy: null,
  conversations: [
    { id: "c1", status: "open", createdAt: "2026-09-14T09:00:00.000Z", lastMessageAt: "2026-09-14T10:00:00.000Z", tags: [] },
    { id: "c0", status: "closed", createdAt: "2026-09-02T09:00:00.000Z", lastMessageAt: "2026-09-02T10:00:00.000Z", tags: ["billing"] },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
const calls = (pattern: RegExp, method: string) =>
  fetchMock.mock.calls.filter(([url, init]) => pattern.test(String(url)) && ((init as RequestInit | undefined)?.method ?? "GET") === method);

beforeEach(() => {
  const base = stubAuthFetch();
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const [path, query = ""] = String(url).split("?");
    const method = init?.method ?? "GET";
    const ok = (data: unknown) => Promise.resolve(jsonResponse(200, { success: true, data }));

    if (/\/customers\/cust-1$/.test(path!) && method === "PATCH") return ok({ ...PROFILE, ...JSON.parse(init!.body as string) });
    if (/\/customers\/cust-1\/block$/.test(path!)) {
      return ok({ ...PROFILE, blocked: method === "POST", blockedBy: method === "POST" ? { id: "u", name: "Olivia Owner" } : null });
    }
    if (/\/customers\/cust-1\/merge$/.test(path!)) return ok({ ...PROFILE, phone: "+44 20 7946 0958" });
    if (/\/customers\/cust-1$/.test(path!)) return ok(PROFILE);
    if (/\/customers$/.test(path!) && query.includes("q=")) {
      return ok({ customers: [{ id: "cust-2", name: "Grace H", email: null, phone: "+44 20 7946 0958", blocked: false, lastSeenAt: "x" }] });
    }
    if (/\/conversations$/.test(path!)) {
      return ok({
        conversations: [
          { id: "c1", status: "open", createdAt: "x", lastMessageAt: "2026-09-14T10:00:00.000Z", customer: { id: "cust-1", name: "Grace", email: null }, assignedTo: null },
        ],
        nextCursor: null,
      });
    }
    if (/\/messages$/.test(path!)) return ok({ messages: [], nextCursor: null });
    return base(url, init) as Promise<Response>;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel(canManage: boolean, onOpenConversation = vi.fn()) {
  render(
    <AuthProvider initialSession={session}>
      <CustomerProfilePanel
        organizationId="org-acme"
        customerId="cust-1"
        canManage={canManage}
        currentConversationId="c1"
        onOpenConversation={onOpenConversation}
      />
    </AuthProvider>,
  );
  return onOpenConversation;
}

describe("CustomerProfilePanel", () => {
  it("shows the contact and their earlier conversations, and opens one", async () => {
    const open = renderPanel(false);
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Grace" })).toBeDefined();
    expect(screen.getByText("grace@example.com")).toBeDefined();
    await user.click(screen.getByRole("button", { name: /Closed · billing/ }));

    expect(open).toHaveBeenCalledWith("c0");
    // No blocking or merging for a role that cannot.
    expect(screen.queryByRole("button", { name: "Block visitor" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Merge a duplicate/ })).toBeNull();
  });

  it("edits details and saves a team note", async () => {
    renderPanel(false);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Grace" });

    await user.click(screen.getByRole("button", { name: "Edit details" }));
    await user.type(screen.getByLabelText("Phone"), "+44 20 7946 0958");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls(/\/customers\/cust-1$/, "PATCH")).toHaveLength(1));
    expect(JSON.parse(calls(/\/customers\/cust-1$/, "PATCH")[0]![1].body as string)).toEqual({
      name: "Grace",
      email: "grace@example.com",
      phone: "+44 20 7946 0958",
    });

    await user.type(screen.getByLabelText("Team note about this contact"), "Prefers email");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls(/\/customers\/cust-1$/, "PATCH")).toHaveLength(2));
    expect(JSON.parse(calls(/\/customers\/cust-1$/, "PATCH")[1]![1].body as string)).toEqual({ profileNote: "Prefers email" });
  });

  it("blocks after confirming, then offers unblock", async () => {
    renderPanel(true);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Grace" });

    await user.click(screen.getByRole("button", { name: "Block visitor" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Unblock" })).toBeDefined();
    expect(screen.getByText(/Blocked by Olivia Owner/)).toBeDefined();
  });

  it("finds a duplicate and merges it in", async () => {
    renderPanel(true);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Grace" });

    await user.click(screen.getByRole("button", { name: /Merge a duplicate/ }));
    await user.type(screen.getByLabelText("Find the duplicate"), "7946");
    await user.click(await screen.findByRole("button", { name: "Merge" }, { timeout: 2000 }));

    await waitFor(() => expect(calls(/\/customers\/cust-1\/merge$/, "POST")).toHaveLength(1));
    expect(JSON.parse(calls(/\/customers\/cust-1\/merge$/, "POST")[0]![1].body as string)).toEqual({ sourceCustomerId: "cust-2" });
    expect(await screen.findByText("+44 20 7946 0958")).toBeDefined();
  });
});

describe("the inbox and customer changes", () => {
  it("renames a row live, and marks a blocked visitor", async () => {
    const harness = createFakeInboxSocketHarness();
    render(
      <AuthProvider initialSession={session}>
        <AgentInbox key="org-acme" organizationId="org-acme" socketFactory={harness.factory} role="agent" />
      </AuthProvider>,
    );
    await screen.findByRole("button", { name: /Grace/ });
    const socket = harness.last();
    act(() => socket.simulateConnect());

    act(() => socket.fire("customer:updated", { id: "cust-1", name: "Grace Hopper", email: null, phone: null, blocked: true }));

    const row = await screen.findByRole("button", { name: /Grace Hopper/ });
    expect(row.textContent).toContain("Blocked");
  });
});
