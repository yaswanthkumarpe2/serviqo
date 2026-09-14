import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { AgentInbox } from "./AgentInbox";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The agent inbox's own behaviour (ADR-025 §11), driven against a stubbed
 * API and an injected fake socket — no network, no real `socket.io-client`.
 *
 * The assertions that matter most here are the two that are easy to get
 * wrong and invisible when broken: a message must not be rendered twice when
 * it arrives both as a send response and as a broadcast, and a message for a
 * conversation that is not selected must become an unread indicator rather
 * than appearing in the open thread.
 */

/** An obvious sentinel — if it reaches the DOM, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";
const ORGANIZATION_ID = "org-acme";
const OTHER_ORGANIZATION_ID = "org-other";

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function conversation(
  id: string,
  name: string,
  lastMessageAt = "2026-08-20T10:00:00.000Z",
  /** ADR-026 §1: unassigned is the state a conversation starts in. */
  overrides: { status?: string; assignedTo?: { id: string; name: string | null } | null } = {},
) {
  return {
    id,
    status: "open",
    createdAt: "2026-08-20T09:00:00.000Z",
    lastMessageAt,
    customer: { id: `cust-${id}`, name, email: `${name.toLowerCase()}@example.com` },
    assignedTo: null,
    ...overrides,
  };
}

function message(id: string, conversationId: string, senderType: "customer" | "agent", body: string) {
  return { id, conversationId, senderType, body, createdAt: "2026-08-20T10:05:00.000Z" };
}

interface InboxStubOptions {
  /** How the conversation list answers. */
  list?: { status: number; body: unknown };
  /** Message history, keyed by conversation id. */
  history?: Record<string, unknown[]>;
  /** How a send answers. */
  send?: { status: number; body: unknown };
  /** Conversations reported for the OTHER organization, proving isolation on switch. */
  otherList?: unknown[];
}

function stubInbox(options: InboxStubOptions = {}) {
  const base = stubAuthFetch();

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    /*
      Path only. These stubs route the way the server does — on the path, with
      the query read separately — so a request that legitimately carries
      `?cursor=`/`?limit=` still reaches the handler that answers it instead of
      falling through to the auth fallback as an unrecognized URL.
    */
    const path = String(url).split("?")[0]!;
    const method = (init?.method ?? "GET").toUpperCase();

    const sendMatch = /\/api\/v1\/organizations\/([^/]+)\/conversations\/([^/]+)\/messages$/.exec(path);
    if (sendMatch && method === "POST") {
      const outcome = options.send ?? {
        status: 201,
        body: { success: true, data: message("m-sent", decodeURIComponent(sendMatch[2]!), "agent", "a reply") },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }

    if (sendMatch && method === "GET") {
      const conversationId = decodeURIComponent(sendMatch[2]!);
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          data: { messages: options.history?.[conversationId] ?? [], nextCursor: null },
        }),
      );
    }

    const listMatch = /\/api\/v1\/organizations\/([^/]+)\/conversations$/.exec(path);
    if (listMatch && method === "GET") {
      const organizationId = decodeURIComponent(listMatch[1]!);

      if (organizationId === OTHER_ORGANIZATION_ID) {
        return Promise.resolve(
          jsonResponse(200, { success: true, data: { conversations: options.otherList ?? [], nextCursor: null } }),
        );
      }

      const outcome = options.list ?? {
        status: 200,
        body: { success: true, data: { conversations: [conversation("c1", "Grace")], nextCursor: null } },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }

    return base(url, init) as Promise<Response>;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderInbox(organizationId = ORGANIZATION_ID) {
  const harness = createFakeInboxSocketHarness();
  const result = render(
    <AuthProvider initialSession={session}>
      <AgentInbox key={organizationId} organizationId={organizationId} socketFactory={harness.factory} />
    </AuthProvider>,
  );
  return { harness, ...result };
}

beforeEach(() => {
  stubAuthFetch();
});

describe("AgentInbox", () => {
  // ---- list states ----

  describe("conversation list states", () => {
    it("shows a loading state before the list arrives", () => {
      stubInbox();
      renderInbox();

      // Two live regions are present at this moment — the transport badge
      // and the list's own state — so this queries the one under test rather
      // than assuming there is only one.
      expect(screen.getByText("Loading conversations…")).toBeDefined();
    });

    it("renders the conversations with the customer each is with", async () => {
      stubInbox({
        list: {
          status: 200,
          body: {
            success: true,
            data: { conversations: [conversation("c1", "Grace"), conversation("c2", "Alan")], nextCursor: null },
          },
        },
      });
      renderInbox();

      expect(await screen.findByRole("button", { name: /Grace/ })).toBeDefined();
      expect(screen.getByRole("button", { name: /Alan/ })).toBeDefined();
    });

    it("shows an empty state rather than an error for a tenant with no conversations", async () => {
      stubInbox({ list: { status: 200, body: { success: true, data: { conversations: [], nextCursor: null } } } });
      renderInbox();

      expect(await screen.findByText(/No conversations yet/)).toBeDefined();
    });

    it("shows a forbidden state, with no retry offered, for a role without the permission", async () => {
      stubInbox({
        list: {
          status: 403,
          body: {
            success: false,
            error: { code: "INSUFFICIENT_PERMISSION", message: "You do not have permission to perform this action" },
          },
        },
      });
      renderInbox();

      const state = await screen.findByText(/Your role does not have access to conversations/);
      // A state, not an alert: it is not a failure and it will never succeed
      // on a retry (ADR-025 §11).
      expect(state).toBeDefined();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows an error state for a transport failure", async () => {
      stubAuthFetch();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (String(url).split("?")[0]!.endsWith("/conversations"))
            return Promise.reject(new TypeError("network down"));
          return Promise.resolve(jsonResponse(200, { success: true, data: {} }));
        }),
      );
      renderInbox();

      expect((await screen.findByRole("alert")).textContent).toMatch(/Could not load conversations/);
    });

    it("survives a response whose conversation list is missing", async () => {
      /*
        `unwrapEnvelope` proves the envelope's shape and nothing about what is
        inside it, so a body like this reaches the client. Rendering code that
        spread the result would throw during render and take the dashboard
        down; the boundary normalizes it to an empty list instead.
      */
      stubInbox({ list: { status: 200, body: { success: true, data: {} } } });
      renderInbox();

      expect(await screen.findByText(/No conversations yet/)).toBeDefined();
    });

    it("reports a refused tenant without claiming to know why", async () => {
      stubInbox({
        list: {
          status: 404,
          body: { success: false, error: { code: "NOT_FOUND", message: "Organization not found" } },
        },
      });
      renderInbox();

      expect((await screen.findByRole("alert")).textContent).toMatch(/no longer available to you/);
    });
  });

  // ---- selecting and reading a thread ----

  describe("selecting a conversation", () => {
    it("loads and renders the message history", async () => {
      stubInbox({
        history: {
          c1: [message("m1", "c1", "customer", "my order is late"), message("m2", "c1", "agent", "looking into it")],
        },
      });
      renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));

      expect(await screen.findByText("my order is late")).toBeDefined();
      expect(screen.getByText("looking into it")).toBeDefined();
    });

    it("attributes each message to its sender", async () => {
      stubInbox({
        history: { c1: [message("m1", "c1", "customer", "from them"), message("m2", "c1", "agent", "from us")] },
      });
      renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));

      const customerMessage = (await screen.findByText("from them")).closest("li")!;
      const agentMessage = screen.getByText("from us").closest("li")!;

      expect(within(customerMessage).getByText("Customer")).toBeDefined();
      // "Support", not "You": the reply may be a colleague's (ADR-040 §3).
      expect(within(agentMessage).getByText("Support")).toBeDefined();
    });

    it("shows an empty thread state for a conversation with no messages", async () => {
      stubInbox({ history: { c1: [] } });
      renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));

      expect(await screen.findByText(/No messages in this conversation yet/)).toBeDefined();
    });

    it("prompts for a selection before one is made", async () => {
      stubInbox();
      renderInbox();

      expect(await screen.findByText(/Select a conversation to read it/)).toBeDefined();
    });
  });

  // ---- sending ----

  describe("the composer", () => {
    it("sends a reply and renders it", async () => {
      const fetchMock = stubInbox({
        history: { c1: [] },
        send: {
          status: 201,
          body: { success: true, data: message("m-new", "c1", "agent", "we are on it") },
        },
      });
      renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      await userEvent.type(await screen.findByLabelText(/Reply to this conversation/), "we are on it");
      await userEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(await screen.findByText("we are on it")).toBeDefined();

      const sendCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      // The body carries `body` and nothing else — no senderType for the
      // client to assert (ADR-025 §6).
      expect(JSON.parse((sendCall![1] as RequestInit).body as string)).toEqual({ body: "we are on it" });
    });

    it("keeps the send button disabled for an empty draft", async () => {
      stubInbox({ history: { c1: [] } });
      renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));

      expect(await screen.findByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    });

    it("reports a failed send in its own words, never the server's", async () => {
      stubInbox({
        history: { c1: [] },
        send: {
          status: 429,
          body: {
            success: false,
            error: { code: "TOO_MANY_REQUESTS", message: "Too many requests. Please wait a few minutes and try again." },
          },
        },
      });
      renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      await userEvent.type(await screen.findByLabelText(/Reply to this conversation/), "hello");
      await userEvent.click(screen.getByRole("button", { name: "Send" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch("Message not sent. Please try again.");
      // The server's text describes Serviqo's defences and is not shown.
      expect(screen.queryByText(/Too many requests/)).toBeNull();
    });
  });

  // ---- real-time ----

  describe("real-time delivery", () => {
    it("opens the socket with the access token and organization in the handshake", async () => {
      stubInbox();
      const { harness } = renderInbox();

      await screen.findByRole("button", { name: /Grace/ });

      expect(harness.last().options.auth).toEqual({ token: ACCESS_TOKEN, organizationId: ORGANIZATION_ID });
      // Never a query string: this value is a credential (ADR-023 §3).
      expect(harness.last().origin).not.toContain(ACCESS_TOKEN);
    });

    it("appends an incoming customer message to the open thread", async () => {
      stubInbox({ history: { c1: [] } });
      const { harness } = renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      await screen.findByText(/No messages in this conversation yet/);

      harness.last().simulateConnect();
      harness.last().deliver(message("m-live", "c1", "customer", "are you there?"));

      expect(await screen.findByText("are you there?")).toBeDefined();
    });

    it("does not render a message twice when it arrives as both a send response and a broadcast", async () => {
      stubInbox({
        history: { c1: [] },
        send: { status: 201, body: { success: true, data: message("m-dup", "c1", "agent", "exactly once") } },
      });
      const { harness } = renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      harness.last().simulateConnect();

      await userEvent.type(await screen.findByLabelText(/Reply to this conversation/), "exactly once");
      await userEvent.click(screen.getByRole("button", { name: "Send" }));

      await screen.findByText("exactly once");

      // The same persisted message, arriving a second time over the socket —
      // suppressed by id at the single append point (ADR-024 §4, ADR-025 §8).
      harness.last().deliver(message("m-dup", "c1", "agent", "exactly once"));

      await waitFor(() => {
        expect(screen.getAllByText("exactly once")).toHaveLength(1);
      });
    });

    it("does not render a message twice when the same broadcast arrives twice", async () => {
      stubInbox({ history: { c1: [] } });
      const { harness } = renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      await screen.findByText(/No messages in this conversation yet/);

      harness.last().simulateConnect();
      harness.last().deliver(message("m-live", "c1", "customer", "only once please"));
      harness.last().deliver(message("m-live", "c1", "customer", "only once please"));

      await waitFor(() => {
        expect(screen.getAllByText("only once please")).toHaveLength(1);
      });
    });

    it("shows an unread indicator for a message in an unselected conversation", async () => {
      stubInbox({
        list: {
          status: 200,
          body: {
            success: true,
            data: { conversations: [conversation("c1", "Grace"), conversation("c2", "Alan")], nextCursor: null },
          },
        },
        history: { c1: [], c2: [] },
      });
      const { harness } = renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      harness.last().simulateConnect();

      harness.last().deliver(message("m-other", "c2", "customer", "meant for Alan's thread"));

      expect(await screen.findByLabelText("1 new messages")).toBeDefined();
      // And it did NOT land in the open thread.
      expect(screen.queryByText("meant for Alan's thread")).toBeNull();
    });

    it("clears the unread indicator when that conversation is selected", async () => {
      stubInbox({
        list: {
          status: 200,
          body: {
            success: true,
            data: { conversations: [conversation("c1", "Grace"), conversation("c2", "Alan")], nextCursor: null },
          },
        },
        history: { c1: [], c2: [message("m-other", "c2", "customer", "meant for Alan's thread")] },
      });
      const { harness } = renderInbox();

      await userEvent.click(await screen.findByRole("button", { name: /Grace/ }));
      harness.last().simulateConnect();
      harness.last().deliver(message("m-other", "c2", "customer", "meant for Alan's thread"));

      await screen.findByLabelText("1 new messages");

      await userEvent.click(screen.getByRole("button", { name: /Alan/ }));

      await waitFor(() => {
        expect(screen.queryByLabelText("1 new messages")).toBeNull();
      });
    });

    it("reports a reconnecting transport without hiding the conversation", async () => {
      stubInbox();
      const { harness } = renderInbox();

      await screen.findByRole("button", { name: /Grace/ });
      harness.last().simulateConnect();
      harness.last().simulateDisconnect();

      expect(await screen.findByText("Reconnecting…")).toBeDefined();
      expect(screen.getByRole("button", { name: /Grace/ })).toBeDefined();
    });

    it("stops retrying a refused handshake and says live updates are unavailable", async () => {
      stubInbox();
      const { harness } = renderInbox();

      await screen.findByRole("button", { name: /Grace/ });
      harness.last().simulateConnectError("Authentication required");

      expect(await screen.findByText("Live updates unavailable")).toBeDefined();
      expect(harness.last().disconnectCalls).toBeGreaterThan(0);
    });

    it("closes the socket when the inbox unmounts", async () => {
      stubInbox();
      const { harness, unmount } = renderInbox();

      await screen.findByRole("button", { name: /Grace/ });
      unmount();

      expect(harness.last().disconnectCalls).toBeGreaterThan(0);
      expect(harness.last().removeAllListenersCalls).toBeGreaterThan(0);
    });
  });

  // ---- organization isolation ----

  describe("organization isolation", () => {
    it("discards the previous tenant's conversations and socket when the key changes", async () => {
      stubInbox({ otherList: [conversation("c9", "Someone Else")] });

      const harness = createFakeInboxSocketHarness();
      const { rerender } = render(
        <AuthProvider initialSession={session}>
          <AgentInbox key={ORGANIZATION_ID} organizationId={ORGANIZATION_ID} socketFactory={harness.factory} />
        </AuthProvider>,
      );

      await screen.findByRole("button", { name: /Grace/ });
      const firstSocket = harness.last();

      rerender(
        <AuthProvider initialSession={session}>
          <AgentInbox
            key={OTHER_ORGANIZATION_ID}
            organizationId={OTHER_ORGANIZATION_ID}
            socketFactory={harness.factory}
          />
        </AuthProvider>,
      );

      // The previous tenant's rows are gone, not filtered out of view.
      await screen.findByRole("button", { name: /Someone Else/ });
      expect(screen.queryByRole("button", { name: /Grace/ })).toBeNull();

      // And its socket was torn down rather than left listening (ADR-025 §11).
      expect(firstSocket.disconnectCalls).toBeGreaterThan(0);
      expect(harness.last().options.auth).toEqual({
        token: ACCESS_TOKEN,
        organizationId: OTHER_ORGANIZATION_ID,
      });
    });

    it("requests conversations only from the organization it was given", async () => {
      const fetchMock = stubInbox();
      renderInbox();

      await screen.findByRole("button", { name: /Grace/ });

      const inboxCalls = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("/conversations"));

      expect(inboxCalls.length).toBeGreaterThan(0);
      for (const url of inboxCalls) {
        expect(url).toContain(`/organizations/${ORGANIZATION_ID}/conversations`);
      }
    });
  });
});
