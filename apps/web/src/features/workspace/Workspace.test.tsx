import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { stubAuthFetch, stubMembership } from "@/features/auth/testing/stubAuthFetch";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { ProtectedRoute } from "@/routes/ProtectedRoute";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The workspace shell (ADR-033).
 *
 * The assertions that matter here are about HONESTY and NAVIGATION: every
 * figure comes from the conversations the server actually returned, a count
 * that is not a total says so, and one view is mounted at a time.
 *
 * `DashboardPage.test.tsx` keeps covering identity and the `/me` contract;
 * this file covers what the shell added.
 */

const session: Session = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  accessToken: "header.payload.signature",
};

const ORGANIZATION = stubMembership("org-acme", "Acme");

function conversation(
  id: string,
  overrides: Partial<{
    status: string;
    assignedTo: { id: string; name: string | null } | null;
    customer: { id: string; name: string | null; email: string | null } | null;
    lastMessageAt: string;
  }> = {},
) {
  return {
    id,
    status: "open",
    createdAt: "2026-09-01T09:00:00.000Z",
    lastMessageAt: new Date().toISOString(),
    customer: { id: `cus-${id}`, name: `Customer ${id}`, email: `${id}@example.com` },
    assignedTo: null,
    ...overrides,
  };
}

/**
 * Stubs `/me` plus the conversation list the overview reads.
 *
 * `nextCursor` is the interesting knob: a non-null cursor means the server has
 * more, which is the case where the overview must stop calling its counts
 * totals.
 */
function stubWorkspace(conversations: unknown[], nextCursor: string | null = null) {
  const base = stubAuthFetch({ memberships: [ORGANIZATION] });

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).includes("/conversations")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: { conversations, nextCursor } }),
      } as Response);
    }
    return base(url, init) as Promise<Response>;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AuthProvider initialSession={session}>
        <Routes>
          <Route path="/login" element={<h1>Sign-in page</h1>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const welcome = () => screen.findByRole("heading", { name: "Welcome back, Ada" });

beforeEach(() => {
  stubAuthFetch();
});

describe("the workspace shell", () => {
  it("greets a user who has not created an organization yet", async () => {
    stubAuthFetch({ memberships: [] });

    renderWorkspace();

    /*
      The regression this covers: the greeting used to live inside the
      overview, which renders only once a tenant is confirmed — so somebody who
      had just registered met a bare form with no sign they were signed in.
    */
    expect(await welcome()).toBeDefined();
    expect(screen.getByText("ada@example.com")).toBeDefined();
  });

  it("opens on the overview, not on a settings page", async () => {
    stubWorkspace([]);

    renderWorkspace();
    await welcome();

    expect(await screen.findByRole("heading", { name: "Quick access" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Dashboard" }).getAttribute("aria-selected")).toBe("true");
  });

  it("mounts one view at a time", async () => {
    stubWorkspace([]);

    renderWorkspace();
    await welcome();
    await screen.findByRole("heading", { name: "Quick access" });

    await userEvent.click(screen.getByRole("tab", { name: "Contacts" }));

    expect(await screen.findByRole("heading", { name: "Contacts" })).toBeDefined();
    // The overview is gone, not hidden — its socket-free panels included.
    expect(screen.queryByRole("heading", { name: "Quick access" })).toBeNull();
  });

  it("moves between destinations with the arrow keys", async () => {
    stubWorkspace([]);

    renderWorkspace();
    await welcome();
    await screen.findByRole("heading", { name: "Quick access" });

    screen.getByRole("tab", { name: "Dashboard" }).focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "My Chats" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the overview's figures", () => {
  it("counts what the server actually returned", async () => {
    stubWorkspace([
      conversation("a", { status: "open", assignedTo: { id: "u1", name: "Ada Lovelace" } }),
      conversation("b", { status: "open" }),
      conversation("c", { status: "closed" }),
    ]);

    renderWorkspace();
    await welcome();

    // One assigned to this reader, two open, one closed, three in total.
    expect(await screen.findByText("1 assigned to you")).toBeDefined();
    expect(screen.getByText("2 awaiting a reply")).toBeDefined();
  });

  /*
    The honesty rule (ADR-033 §4). One page is not a tenant, and a count
    presented as a total would be quietly wrong for exactly the organizations
    big enough to notice.
  */
  it("marks its counts as partial when the server has another page", async () => {
    stubWorkspace([conversation("a"), conversation("b")], "cursor-2");

    renderWorkspace();
    await welcome();

    expect(await screen.findByText("2+ awaiting a reply")).toBeDefined();
    expect(screen.getByText(/more than one page/i)).toBeDefined();
  });

  it("states a plain total when the page is the whole tenant", async () => {
    stubWorkspace([conversation("a"), conversation("b")], null);

    renderWorkspace();
    await welcome();

    expect(await screen.findByText("2 awaiting a reply")).toBeDefined();
    expect(screen.queryByText(/more than one page/i)).toBeNull();
  });

  it("invents nothing for an empty organization", async () => {
    stubWorkspace([]);

    renderWorkspace();
    await welcome();

    expect(await screen.findByText("No conversations yet")).toBeDefined();
    expect(screen.getByText("0 assigned to you")).toBeDefined();
    // The sample rows a mockup would show — none of them exist.
    expect(screen.queryByText(/support team|alex morgan|priya/i)).toBeNull();
  });

  it("lists real conversations, newest first, as the server ordered them", async () => {
    stubWorkspace([
      conversation("a", { customer: { id: "c1", name: "Priya Raghavan", email: "priya@example.com" } }),
      conversation("b", { customer: { id: "c2", name: null, email: null } }),
    ]);

    renderWorkspace();
    await welcome();

    expect(await screen.findByText("Priya Raghavan")).toBeDefined();
    // A visitor who gave no name is shown as one, never invented.
    expect(screen.getByText("Anonymous visitor")).toBeDefined();
  });
});

describe("contacts", () => {
  it("derives the people from the conversations, counting each once", async () => {
    const customer = { id: "c1", name: "Priya Raghavan", email: "priya@example.com" };
    stubWorkspace([
      conversation("a", { customer }),
      conversation("b", { customer }),
      conversation("c", { customer: { id: "c2", name: "Alex Morgan", email: "alex@example.com" } }),
    ]);

    renderWorkspace();
    await welcome();
    await userEvent.click(await screen.findByRole("tab", { name: "Contacts" }));

    expect(await screen.findByText("Priya Raghavan")).toBeDefined();
    expect(screen.getByText("Alex Morgan")).toBeDefined();
    expect(screen.getByText("2 people")).toBeDefined();
  });

  it("says so when there is nobody yet", async () => {
    stubWorkspace([]);

    renderWorkspace();
    await welcome();
    await userEvent.click(await screen.findByRole("tab", { name: "Contacts" }));

    expect(await screen.findByText("No contacts yet")).toBeDefined();
  });
});

describe("opening a conversation from the overview", () => {
  it("switches to My Chats and selects the row that was clicked", async () => {
    stubWorkspace([
      conversation("conv-1", { customer: { id: "c1", name: "Priya Raghavan", email: "priya@example.com" } }),
    ]);

    renderWorkspace();
    await welcome();

    await userEvent.click(await screen.findByText("Priya Raghavan"));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "My Chats" }).getAttribute("aria-selected")).toBe("true");
    });
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeDefined();
  });
});

describe("a reader whose role cannot see conversations", () => {
  it("says so without breaking the rest of the workspace", async () => {
    const base = stubAuthFetch({ memberships: [ORGANIZATION] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).includes("/conversations")) {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: () =>
              Promise.resolve({
                success: false,
                error: { code: "INSUFFICIENT_PERMISSION", message: "You do not have permission" },
              }),
          } as Response);
        }
        return base(url, init) as Promise<Response>;
      }),
    );

    renderWorkspace();
    await welcome();

    expect(await screen.findByText(/role does not include access/i)).toBeDefined();
    // Still signed in, still navigable — a 403 on one panel is not an outage.
    expect(screen.getByRole("tab", { name: "Team" })).toBeDefined();
  });
});
