import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { AgentInbox } from "./AgentInbox";
import { createFakeInboxSocketHarness } from "./testing/fakeInboxSocket";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The inbox's ownership and lifecycle controls (ADR-026 §13), driven against a
 * stubbed API and an injected fake socket — no network, no real
 * `socket.io-client`.
 *
 * The assertions that matter most here are the ones that are easy to get wrong
 * and invisible when broken: a conversation another agent holds must offer NO
 * control rather than a button that always fails (§4), a closed conversation
 * must replace the composer rather than accept a message the server will
 * refuse (§6), and a colleague's action arriving over the socket must re-render
 * the row without a refetch (§10).
 */

const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";
const ORGANIZATION_ID = "org-acme";

/** The signed-in agent — `CURRENT_USER.id`, which the server compares `assignedTo` against. */
const ME = CURRENT_USER.id;
const COLLEAGUE = "u-colleague";

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

interface ConversationOverrides {
  status?: "open" | "closed";
  assignedTo?: { id: string; name: string | null } | null;
}

function conversation(id: string, name: string, overrides: ConversationOverrides = {}) {
  return {
    id,
    status: "open",
    createdAt: "2026-08-20T09:00:00.000Z",
    lastMessageAt: "2026-08-20T10:00:00.000Z",
    customer: { id: `cust-${id}`, name, email: `${name.toLowerCase()}@example.com` },
    assignedTo: null,
    ...overrides,
  };
}

interface StubOptions {
  /** The conversation the list reports. */
  row?: ReturnType<typeof conversation>;
  /** What `PATCH .../assignment` answers. */
  assignment?: { status: number; body: unknown };
  /** What `PATCH .../status` answers. */
  status?: { status: number; body: unknown };
}

/** Records every request the inbox makes, so a test can assert the exact call. */
interface StubResult {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: { path: string; method: string; body: unknown }[];
}

function stubInbox(options: StubOptions = {}): StubResult {
  const base = stubAuthFetch();
  const row = options.row ?? conversation("c1", "Grace");
  const calls: StubResult["calls"] = [];

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (method !== "GET") calls.push({ path, method, body });

    if (/\/assignment$/.test(path) && method === "PATCH") {
      const action = (body as { action?: string } | undefined)?.action;
      const outcome = options.assignment ?? {
        status: 200,
        body: {
          success: true,
          data: { ...row, assignedTo: action === "claim" ? { id: ME, name: "Ada Lovelace" } : null },
        },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }

    if (/\/status$/.test(path) && method === "PATCH") {
      const next = (body as { status?: string } | undefined)?.status;
      const outcome = options.status ?? {
        status: 200,
        body: { success: true, data: { ...row, status: next } },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }

    if (/\/messages$/.test(path)) {
      return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
    }

    if (/\/conversations$/.test(path) && method === "GET") {
      return Promise.resolve(jsonResponse(200, { success: true, data: { conversations: [row], nextCursor: null } }));
    }

    return base(url, init) as Promise<Response>;
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function renderInbox() {
  const harness = createFakeInboxSocketHarness();
  const result = render(
    <AuthProvider initialSession={session}>
      <AgentInbox key={ORGANIZATION_ID} organizationId={ORGANIZATION_ID} socketFactory={harness.factory} />
    </AuthProvider>,
  );
  return { harness, ...result };
}

/** Opens the one conversation the stub reports. */
async function selectConversation(user: ReturnType<typeof userEvent.setup>) {
  const row = await screen.findByRole("button", { name: /Grace/ });
  await user.click(row);
  return row;
}

beforeEach(() => {
  stubAuthFetch();
});

describe("AgentInbox assignment and status", () => {
  // ---- reading the assignment ----

  describe("assignment display", () => {
    it("shows an unassigned conversation as unassigned", async () => {
      stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      expect(await screen.findAllByText("Unassigned")).not.toHaveLength(0);
    });

    it("names the reader's own assignment rather than showing their user id", async () => {
      stubInbox({ row: conversation("c1", "Grace", { assignedTo: { id: ME, name: "Ada Lovelace" } }) });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      expect(await screen.findAllByText("Assigned to you")).not.toHaveLength(0);
      // A bare user id is useless to a reader and is an internal identifier
      // (ADR-026 §13).
      expect(screen.queryByText(new RegExp(ME))).toBeNull();
    });

    it("shows a colleague's name when the server disclosed it", async () => {
      stubInbox({
        row: conversation("c1", "Grace", { assignedTo: { id: COLLEAGUE, name: "Katherine Johnson" } }),
      });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      expect(await screen.findAllByText("Assigned to Katherine Johnson")).not.toHaveLength(0);
    });

    it("says 'another agent' when the server withheld the name", async () => {
      stubInbox({ row: conversation("c1", "Grace", { assignedTo: { id: COLLEAGUE, name: null } }) });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      /*
        The reader's role lacks `member.read`, so the server sent the id
        without a name (ADR-026 §11). The UI never invents one and never falls
        back to the id.
      */
      expect(await screen.findAllByText("Assigned to another agent")).not.toHaveLength(0);
      expect(screen.queryByText(new RegExp(COLLEAGUE))).toBeNull();
    });

    it("survives a conversation row that arrives without an assignedTo field", async () => {
      const row = conversation("c1", "Grace") as Record<string, unknown>;
      delete row.assignedTo;
      stubInbox({ row: row as ReturnType<typeof conversation> });

      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      // A render-time crash would take the whole dashboard down; an absent
      // field reads as unassigned instead.
      expect(await screen.findAllByText("Unassigned")).not.toHaveLength(0);
    });
  });

  // ---- claiming ----

  describe("claiming", () => {
    it("offers a claim control for an unassigned conversation and sends action: claim", async () => {
      const stub = stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/assignment"))).toBe(true));

      const call = stub.calls.find((c) => c.path.endsWith("/assignment"));
      expect(call).toBeDefined();
      expect(call!.method).toBe("PATCH");
      expect(call!.body).toEqual({ action: "claim" });
    });

    it("never sends a user id in the assignment body", async () => {
      const stub = stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));
      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/assignment"))).toBe(true));

      /*
        The subject of the verb is the authenticated caller, resolved
        server-side (ADR-026 §2). Sending a user id would be this client
        claiming an authority it does not have — and the server would strip it
        anyway.
      */
      const body = stub.calls.find((c) => c.path.endsWith("/assignment"))!.body as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["action"]);
    });

    it("shows the new assignment after a successful claim, with no refetch", async () => {
      const stub = stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      expect(await screen.findAllByText("Assigned to you")).not.toHaveLength(0);
      // The response is the same projection the list returns, so the row is
      // updated from it rather than by re-reading the list (ADR-026 §2).
      const listReads = stub.fetchMock.mock.calls.filter((call: unknown[]) => {
        const [url, init] = call as [string, RequestInit | undefined];
        return /\/conversations$/.test(String(url)) && (init?.method ?? "GET").toUpperCase() === "GET";
      });
      expect(listReads).toHaveLength(1);
    });

    it("swaps the claim control for a release control once claimed", async () => {
      stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      expect(await screen.findByRole("button", { name: "Release" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    });

    it("offers NO assignment control for a conversation another agent holds", async () => {
      stubInbox({ row: conversation("c1", "Grace", { assignedTo: { id: COLLEAGUE, name: null } }) });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await screen.findAllByText("Assigned to another agent");

      /*
        Taking a conversation from a colleague is refused server-side for
        every role (ADR-026 §4), and a button that always fails is worse than
        an absent one (§13).
      */
      expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
    });

    it("reports a conflict in its own words rather than the server's", async () => {
      stubInbox({
        assignment: {
          status: 409,
          body: {
            success: false,
            error: {
              code: "CONVERSATION_ALREADY_ASSIGNED",
              message: "SERVER_TEXT_THAT_MUST_NOT_RENDER",
            },
          },
        },
      });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      expect((await screen.findByRole("alert")).textContent).toBe("Another agent is handling this conversation.");
      expect(screen.queryByText(/SERVER_TEXT_THAT_MUST_NOT_RENDER/)).toBeNull();
    });

    it("reports a forbidden claim without offering a retry that would fail forever", async () => {
      stubInbox({
        assignment: {
          status: 403,
          body: { success: false, error: { code: "INSUFFICIENT_PERMISSION", message: "nope" } },
        },
      });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      expect((await screen.findByRole("alert")).textContent).toBe("Your role cannot change this conversation.");
    });

    it("reports a transport failure generically", async () => {
      const base = stubAuthFetch();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          const path = String(url);
          const method = (init?.method ?? "GET").toUpperCase();

          if (/\/assignment$/.test(path) && method === "PATCH") return Promise.reject(new TypeError("offline"));
          if (/\/messages$/.test(path)) {
            return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
          }
          if (/\/conversations$/.test(path) && method === "GET") {
            return Promise.resolve(
              jsonResponse(200, {
                success: true,
                data: { conversations: [conversation("c1", "Grace")], nextCursor: null },
              }),
            );
          }
          return base(url, init) as Promise<Response>;
        }),
      );

      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      expect((await screen.findByRole("alert")).textContent).toBe("That did not work. Please try again.");
    });
  });

  // ---- releasing ----

  describe("releasing", () => {
    it("sends action: release and clears the assignment", async () => {
      const stub = stubInbox({ row: conversation("c1", "Grace", { assignedTo: { id: ME, name: "Ada Lovelace" } }) });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Release" }));

      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/assignment"))).toBe(true));
      expect(stub.calls.find((c) => c.path.endsWith("/assignment"))!.body).toEqual({ action: "release" });
      expect(await screen.findAllByText("Unassigned")).not.toHaveLength(0);
    });
  });

  // ---- status ----

  describe("closing and reopening", () => {
    it("closes a conversation and replaces the composer", async () => {
      const stub = stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      expect(screen.getByRole("textbox", { name: /Reply to this conversation/ })).toBeTruthy();

      await user.click(await screen.findByRole("button", { name: "Close" }));

      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/status"))).toBe(true));
      expect(stub.calls.find((c) => c.path.endsWith("/status"))!.body).toEqual({ status: "closed" });

      /*
        The server refuses a send into a closed conversation (ADR-026 §6), so
        offering the box would be inviting a message that cannot be delivered.
      */
      expect(await screen.findByText("This conversation is closed. Reopen it to reply.")).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: /Reply to this conversation/ })).toBeNull();
    });

    it("offers a reopen control for a closed conversation and sends status: open", async () => {
      const stub = stubInbox({ row: conversation("c1", "Grace", { status: "closed" }) });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
      await user.click(await screen.findByRole("button", { name: "Reopen" }));

      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/status"))).toBe(true));
      expect(stub.calls.find((c) => c.path.endsWith("/status"))!.body).toEqual({ status: "open" });
    });

    it("restores the composer after a reopen", async () => {
      stubInbox({ row: conversation("c1", "Grace", { status: "closed" }) });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Reopen" }));

      expect(await screen.findByRole("textbox", { name: /Reply to this conversation/ })).toBeTruthy();
    });

    it("marks a closed conversation in the list as well as the thread", async () => {
      stubInbox({ row: conversation("c1", "Grace", { status: "closed" }) });
      renderInbox();

      const row = await screen.findByRole("button", { name: /Grace/ });
      expect(row.textContent).toContain("Closed");
    });

    it("states the reopen conflict, because it is a refusal an agent can act on", async () => {
      stubInbox({
        row: conversation("c1", "Grace", { status: "closed" }),
        status: {
          status: 409,
          body: {
            success: false,
            error: { code: "CONVERSATION_REOPEN_CONFLICT", message: "SERVER_TEXT_THAT_MUST_NOT_RENDER" },
          },
        },
      });
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Reopen" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        "This customer already has a newer open conversation.",
      );
      expect(screen.queryByText(/SERVER_TEXT_THAT_MUST_NOT_RENDER/)).toBeNull();
    });

    it("uses a different endpoint for status than for assignment", async () => {
      const stub = stubInbox();
      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));
      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/assignment"))).toBe(true));
      await user.click(await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/status"))).toBe(true));

      /*
        Two routes, because the two are gated by different permissions
        server-side and `requirePermission` takes one per route
        (ADR-026 §2). A client that posted both fields to one endpoint would
        be programming against a surface that does not exist.
      */
      const paths = stub.calls.map((c) => c.path);
      expect(paths.some((p) => p.endsWith("/assignment"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/status"))).toBe(true);
    });
  });

  // ---- pending states ----

  describe("pending states", () => {
    it("disables the controls while a claim is in flight", async () => {
      let settle: ((value: Response) => void) | null = null;
      const base = stubAuthFetch();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          const path = String(url);
          const method = (init?.method ?? "GET").toUpperCase();

          if (/\/assignment$/.test(path) && method === "PATCH") {
            return new Promise<Response>((resolve) => {
              settle = resolve;
            });
          }
          if (/\/messages$/.test(path)) {
            return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
          }
          if (/\/conversations$/.test(path) && method === "GET") {
            return Promise.resolve(
              jsonResponse(200, {
                success: true,
                data: { conversations: [conversation("c1", "Grace")], nextCursor: null },
              }),
            );
          }
          return base(url, init) as Promise<Response>;
        }),
      );

      const user = userEvent.setup();
      renderInbox();
      await selectConversation(user);

      await user.click(await screen.findByRole("button", { name: "Claim" }));

      const claiming = (await screen.findByRole("button", { name: "Claiming…" })) as HTMLButtonElement;
      expect(claiming.disabled).toBe(true);
      // Each action has its OWN pending state, so a slow claim must not be the
      // reason a close cannot be started — but while one is in flight the
      // others are held, because they act on the same conversation.
      expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);

      settle!(
        jsonResponse(200, {
          success: true,
          data: conversation("c1", "Grace", { assignedTo: { id: ME, name: "Ada Lovelace" } }),
        }),
      );

      expect(((await screen.findByRole("button", { name: "Release" })) as HTMLButtonElement).disabled).toBe(false);
    });

    it("clears a previous refusal when another conversation is selected", async () => {
      const base = stubAuthFetch();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          const path = String(url);
          const method = (init?.method ?? "GET").toUpperCase();

          if (/\/assignment$/.test(path) && method === "PATCH") {
            return Promise.resolve(
              jsonResponse(409, {
                success: false,
                error: { code: "CONVERSATION_ALREADY_ASSIGNED", message: "taken" },
              }),
            );
          }
          if (/\/messages$/.test(path)) {
            return Promise.resolve(jsonResponse(200, { success: true, data: { messages: [], nextCursor: null } }));
          }
          if (/\/conversations$/.test(path) && method === "GET") {
            return Promise.resolve(
              jsonResponse(200, {
                success: true,
                data: {
                  conversations: [conversation("c1", "Grace"), conversation("c2", "Hedy")],
                  nextCursor: null,
                },
              }),
            );
          }
          return base(url, init) as Promise<Response>;
        }),
      );

      const user = userEvent.setup();
      renderInbox();

      await user.click(await screen.findByRole("button", { name: /Grace/ }));
      await user.click(await screen.findByRole("button", { name: "Claim" }));
      await screen.findByRole("alert");

      await user.click(await screen.findByRole("button", { name: /Hedy/ }));

      // A refusal about the previous conversation must not sit under the new
      // one's controls, where it would read as a statement about it.
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
  });

  // ---- real-time ----

  describe("live updates from other agents", () => {
    it("re-renders the row when a colleague claims the conversation", async () => {
      stubInbox();
      const user = userEvent.setup();
      const { harness } = renderInbox();
      await selectConversation(user);

      expect(await screen.findAllByText("Unassigned")).not.toHaveLength(0);

      harness.last().deliverConversationUpdate({
        id: "c1",
        status: "open",
        lastMessageAt: "2026-08-20T10:05:00.000Z",
        assignedTo: { id: COLLEAGUE, name: null },
      });

      // No refetch: the broadcast is merged into the row already held
      // (ADR-026 §13).
      expect(await screen.findAllByText("Assigned to another agent")).not.toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    });

    it("removes the composer when another agent closes the conversation", async () => {
      stubInbox();
      const user = userEvent.setup();
      const { harness } = renderInbox();
      await selectConversation(user);

      expect(screen.getByRole("textbox", { name: /Reply to this conversation/ })).toBeTruthy();

      harness.last().deliverConversationUpdate({
        id: "c1",
        status: "closed",
        lastMessageAt: "2026-08-20T10:05:00.000Z",
        assignedTo: null,
      });

      expect(await screen.findByText("This conversation is closed. Reopen it to reply.")).toBeTruthy();
    });

    it("restores the claim control when a colleague releases the conversation", async () => {
      stubInbox({ row: conversation("c1", "Grace", { assignedTo: { id: COLLEAGUE, name: null } }) });
      const user = userEvent.setup();
      const { harness } = renderInbox();
      await selectConversation(user);

      expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();

      harness.last().deliverConversationUpdate({
        id: "c1",
        status: "open",
        lastMessageAt: "2026-08-20T10:05:00.000Z",
        assignedTo: null,
      });

      expect(await screen.findByRole("button", { name: "Claim" })).toBeTruthy();
    });

    it("keeps a colleague's name across an unrelated status change", async () => {
      stubInbox({
        row: conversation("c1", "Grace", { assignedTo: { id: COLLEAGUE, name: "Katherine Johnson" } }),
      });
      const user = userEvent.setup();
      const { harness } = renderInbox();
      await selectConversation(user);

      await screen.findAllByText("Assigned to Katherine Johnson");

      /*
        The broadcast carries no name, because it has no reader to run the
        `member.read` check against (ADR-026 §11). Replacing the row's
        assignee wholesale would blink the colleague's name out of the UI on
        an unrelated close.
      */
      harness.last().deliverConversationUpdate({
        id: "c1",
        status: "closed",
        lastMessageAt: "2026-08-20T10:05:00.000Z",
        assignedTo: { id: COLLEAGUE, name: null },
      });

      expect(await screen.findByText("This conversation is closed. Reopen it to reply.")).toBeTruthy();
      expect(screen.getAllByText("Assigned to Katherine Johnson")).not.toHaveLength(0);
    });

    it("ignores an update for a conversation the list has never seen", async () => {
      stubInbox();
      const user = userEvent.setup();
      const { harness } = renderInbox();
      await selectConversation(user);

      harness.last().deliverConversationUpdate({
        id: "c-unknown",
        status: "closed",
        lastMessageAt: "2026-08-20T10:05:00.000Z",
        assignedTo: null,
      });

      // The next fetch brings it in; rows must not appear under a reader's
      // cursor (ADR-025 §13, applied to a second event).
      await waitFor(() => expect(screen.getAllByRole("button", { name: /Grace/ })).toHaveLength(1));
      expect(screen.queryByText("This conversation is closed. Reopen it to reply.")).toBeNull();
    });

    it("ignores a malformed conversation:updated payload", async () => {
      stubInbox();
      const user = userEvent.setup();
      const { harness } = renderInbox();
      await selectConversation(user);

      for (const malformed of [null, "c1", { id: "c1" }, { id: "c1", status: "archived" }]) {
        harness.last().deliverConversationUpdate(malformed);
      }

      /*
        `status` decides whether the composer or the closed notice renders, so
        a value from the network is checked against the two it may be rather
        than trusted to be one of them.
      */
      expect(await screen.findAllByText("Unassigned")).not.toHaveLength(0);
      expect(screen.getByRole("textbox", { name: /Reply to this conversation/ })).toBeTruthy();
    });

    it("listens for conversation:updated on the socket it opens", async () => {
      stubInbox();
      const { harness } = renderInbox();

      await waitFor(() => expect(harness.sockets).toHaveLength(1));
      expect(harness.last().listenedEvents).toContain("conversation:updated");
    });
  });
});
