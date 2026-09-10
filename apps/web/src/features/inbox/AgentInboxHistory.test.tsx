import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { AgentInbox } from "./AgentInbox";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Reaching the history that is already in the database (ADR-025 §5).
 *
 * Both inbox reads are paged, and before this suite existed the client asked
 * for one page of each and discarded the `nextCursor` — so a tenant's older
 * conversations and a long thread's most recent messages were stored, served,
 * and unreachable from the dashboard.
 *
 * The two lists page in OPPOSITE directions, which is the thing these tests
 * are really pinning down:
 *
 *   - conversations sort by `lastMessageAt` descending, so page two is OLDER;
 *   - messages sort by ascending `_id`, so page two is NEWER.
 *
 * That asymmetry is why a single "load more" written once for both would be
 * wrong in one of them, and why the message case asserts that a long thread
 * ends up whole rather than merely longer.
 */

const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";
const ORGANIZATION_ID = "org-acme";

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function conversation(id: string, name: string, lastMessageAt = "2026-08-20T10:00:00.000Z") {
  return {
    id,
    status: "open",
    createdAt: "2026-08-20T09:00:00.000Z",
    lastMessageAt,
    customer: { id: `cust-${id}`, name, email: `${name.toLowerCase()}@example.com` },
    assignedTo: null,
  };
}

function message(id: string, conversationId: string, body: string) {
  return { id, conversationId, senderType: "customer" as const, body, createdAt: "2026-08-20T10:05:00.000Z" };
}

/** One page of either list, as the server would envelope it. */
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface HistoryStubOptions {
  /** Conversation pages, keyed by the cursor that asks for them; `""` is the first. */
  conversationPages?: Record<string, Page<unknown>>;
  /** Message pages for `c1`, keyed the same way. */
  messagePages?: Record<string, Page<unknown>>;
  /** Cursors whose request must fail, to prove a failed page costs nothing already read. */
  failCursors?: string[];
}

/**
 * Routes on the PATH and reads the cursor from the query, the way the server
 * does — so a request carrying `?cursor=` reaches the handler that answers it.
 */
function stubHistory(options: HistoryStubOptions = {}) {
  const base = stubAuthFetch();

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const raw = String(url);
    const [path, query = ""] = raw.split("?");
    const cursor = new URLSearchParams(query).get("cursor") ?? "";
    const method = (init?.method ?? "GET").toUpperCase();

    if (options.failCursors?.includes(cursor) === true) {
      return Promise.reject(new TypeError("network down"));
    }

    if (/\/conversations\/[^/]+\/messages$/.test(path!) && method === "GET") {
      const page = options.messagePages?.[cursor] ?? { items: [], nextCursor: null };
      return Promise.resolve(
        jsonResponse(200, { success: true, data: { messages: page.items, nextCursor: page.nextCursor } }),
      );
    }

    if (/\/conversations$/.test(path!) && method === "GET") {
      const page = options.conversationPages?.[cursor] ?? {
        items: [conversation("c1", "Grace")],
        nextCursor: null,
      };
      return Promise.resolve(
        jsonResponse(200, { success: true, data: { conversations: page.items, nextCursor: page.nextCursor } }),
      );
    }

    return base(url, init) as Promise<Response>;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderInbox() {
  const harness = createFakeInboxSocketHarness();
  const result = render(
    <AuthProvider initialSession={session}>
      <AgentInbox organizationId={ORGANIZATION_ID} socketFactory={harness.factory} />
    </AuthProvider>,
  );
  return { harness, ...result };
}

/** Every conversation-list URL the client requested, in order. */
function listUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.split("?")[0]!.endsWith("/conversations"));
}

beforeEach(() => {
  stubAuthFetch();
});

describe("inbox history", () => {
  describe("older conversations", () => {
    it("offers no control when the server reports the list is complete", async () => {
      stubHistory({ conversationPages: { "": { items: [conversation("c1", "Grace")], nextCursor: null } } });
      renderInbox();

      await screen.findByRole("button", { name: /Grace/ });

      // Absent rather than disabled: a button that never does anything is a
      // worse answer than no button.
      expect(screen.queryByRole("button", { name: "Load older conversations" })).toBeNull();
    });

    it("offers the control when older conversations exist", async () => {
      stubHistory({ conversationPages: { "": { items: [conversation("c1", "Grace")], nextCursor: "cur-2" } } });
      renderInbox();

      expect(await screen.findByRole("button", { name: "Load older conversations" })).toBeDefined();
    });

    it("appends the older page, keeping the conversations already read", async () => {
      stubHistory({
        conversationPages: {
          "": { items: [conversation("c1", "Grace")], nextCursor: "cur-2" },
          "cur-2": { items: [conversation("c2", "Alan", "2026-08-10T10:00:00.000Z")], nextCursor: null },
        },
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: "Load older conversations" }));

      expect(await screen.findByRole("button", { name: /Alan/ })).toBeDefined();
      // The point of "append": the first page must survive the second.
      expect(screen.getByRole("button", { name: /Grace/ })).toBeDefined();
      // The history is exhausted, so the control retires.
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Load older conversations" })).toBeNull();
      });
    });

    it("sends the cursor the previous page returned", async () => {
      const fetchMock = stubHistory({
        conversationPages: {
          "": { items: [conversation("c1", "Grace")], nextCursor: "cur-2" },
          "cur-2": { items: [], nextCursor: null },
        },
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: "Load older conversations" }));

      await waitFor(() => {
        expect(listUrls(fetchMock).some((url) => url.includes("cursor=cur-2"))).toBe(true);
      });
    });

    it("asks for no cursor on the first page", async () => {
      const fetchMock = stubHistory();
      renderInbox();

      await screen.findByRole("button", { name: /Grace/ });

      /*
        An empty `?cursor=` is not the same as no cursor: the server's schema
        rejects one as malformed, so a first page that sent an empty key would
        400 rather than return the newest conversations.
      */
      expect(listUrls(fetchMock).every((url) => !url.includes("cursor="))).toBe(true);
    });

    it("does not add a conversation twice when it appears in both pages", async () => {
      /*
        Not hypothetical: the sort key is `lastMessageAt`, so a conversation
        that receives a message between two page reads moves and can be
        returned again in the later page.
      */
      stubHistory({
        conversationPages: {
          "": { items: [conversation("c1", "Grace")], nextCursor: "cur-2" },
          "cur-2": { items: [conversation("c1", "Grace"), conversation("c2", "Alan")], nextCursor: null },
        },
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: "Load older conversations" }));

      await screen.findByRole("button", { name: /Alan/ });
      expect(screen.getAllByRole("button", { name: /Grace/ })).toHaveLength(1);
    });

    it("keeps the conversations already read when the older page fails", async () => {
      stubHistory({
        conversationPages: { "": { items: [conversation("c1", "Grace")], nextCursor: "cur-2" } },
        failCursors: ["cur-2"],
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: "Load older conversations" }));

      expect(await screen.findByText("Could not load older conversations. Please try again.")).toBeDefined();
      // Losing a screen of history to a network blip would be far worse than
      // the message beside the button.
      expect(screen.getByRole("button", { name: /Grace/ })).toBeDefined();
    });
  });

  describe("a thread longer than one page", () => {
    it("loads the whole conversation, not just its first page", async () => {
      /*
        THE regression this suite exists for. Messages page oldest-first, so a
        client that read one page and stopped showed the START of a long
        exchange — the customer's most recent message, the one an agent is
        answering, was the part that was missing.
      */
      stubHistory({
        conversationPages: { "": { items: [conversation("c1", "Grace")], nextCursor: null } },
        messagePages: {
          "": { items: [message("m1", "c1", "the oldest message")], nextCursor: "m1" },
          m1: { items: [message("m2", "c1", "the middle message")], nextCursor: "m2" },
          m2: { items: [message("m3", "c1", "the newest message")], nextCursor: null },
        },
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: /Grace/ }));

      expect(await screen.findByText("the newest message")).toBeDefined();
      expect(screen.getByText("the oldest message")).toBeDefined();
      expect(screen.getByText("the middle message")).toBeDefined();
    });

    it("renders each message once when a page repeats one", async () => {
      stubHistory({
        conversationPages: { "": { items: [conversation("c1", "Grace")], nextCursor: null } },
        messagePages: {
          "": { items: [message("m1", "c1", "only once")], nextCursor: "m1" },
          m1: { items: [message("m1", "c1", "only once"), message("m2", "c1", "and then this")], nextCursor: null },
        },
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: /Grace/ }));

      await screen.findByText("and then this");
      expect(screen.getAllByText("only once")).toHaveLength(1);
    });

    it("offers no newer-messages control for a thread that loaded whole", async () => {
      stubHistory({
        conversationPages: { "": { items: [conversation("c1", "Grace")], nextCursor: null } },
        messagePages: { "": { items: [message("m1", "c1", "all of it")], nextCursor: null } },
      });
      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: /Grace/ }));

      await screen.findByText("all of it");
      expect(screen.queryByRole("button", { name: "Load newer messages" })).toBeNull();
    });
  });
});
