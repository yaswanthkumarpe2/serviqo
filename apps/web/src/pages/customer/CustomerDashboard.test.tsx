import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { stubAuthFetch, stubMembership } from "@/features/auth/testing/stubAuthFetch";
import { AppRoutes } from "@/routes/AppRoutes";

import type { Session } from "@/features/auth/AuthContext";

/**
 * The customer's chat (ADR-034 §6).
 *
 * Rendered through `AppRoutes` rather than by mounting the page, because the
 * routing is half the subject: which of the three surfaces a person lands on is
 * decided by their account's kind, and mounting the page directly would skip
 * the guard that decides.
 */

const session: Session = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", kind: "customer" },
  accessToken: "header.payload.signature",
};

const MESSAGES = [
  {
    id: "m1",
    conversationId: "conv-1",
    senderType: "customer",
    body: "My order never arrived.",
    createdAt: "2026-09-12T10:00:00.000Z",
  },
  {
    id: "m2",
    conversationId: "conv-1",
    senderType: "agent",
    body: "Sorry about that — let me check.",
    createdAt: "2026-09-12T10:01:00.000Z",
  },
];

function renderAt(path: string, initialSession: Session | null = session) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialSession={initialSession}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubAuthFetch();
});

afterEach(() => {
  // The chat polls on an interval; a test that left one running would keep
  // firing requests into the next test's stub.
  vi.useRealTimers();
});

describe("the customer dashboard", () => {
  it("greets the customer and offers a chat", async () => {
    stubAuthFetch();

    renderAt("/dashboard");

    expect(await screen.findByRole("heading", { name: "Hi Ada" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Chat with support" })).toBeDefined();
  });

  /*
    A customer is not staff. None of the agent workspace's surfaces may appear
    here, and this is the assertion that fails if somebody reuses the wrong
    shell for this page.
  */
  it("shows no organization, inbox, team or widget controls", async () => {
    stubAuthFetch();

    const { container } = renderAt("/dashboard");
    await screen.findByRole("heading", { name: "Hi Ada" });

    /*
      Checked as CONTROLS rather than as words: the page's own copy says "the
      support team will reply", and banning the word would make the assertion
      about prose instead of about what a customer can reach.
    */
    expect(screen.queryByRole("tab", { name: "My Chats" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Inbox" })).toBeNull();
    expect(screen.queryByText(/widget key|install the widget|organization/i)).toBeNull();
    expect(container.querySelector(".ws__nav")).toBeNull();
  });

  it("renders the real history the server returned", async () => {
    stubAuthFetch({ myMessages: MESSAGES });

    renderAt("/dashboard");

    expect(await screen.findByText("My order never arrived.")).toBeDefined();
    expect(screen.getByText("Sorry about that — let me check.")).toBeDefined();
  });

  it("tells the two sides of the conversation apart", async () => {
    stubAuthFetch({ myMessages: MESSAGES });

    const { container } = renderAt("/dashboard");
    await screen.findByText("My order never arrived.");

    expect(container.querySelectorAll(".cx__message--mine")).toHaveLength(1);
    expect(container.querySelectorAll(".cx__message--theirs")).toHaveLength(1);
  });

  it("says so when there are no messages yet", async () => {
    stubAuthFetch();

    renderAt("/dashboard");

    expect(await screen.findByText("No messages yet")).toBeDefined();
  });

  /*
    No organization exists on this deployment, so there is nobody to talk to.
    Said plainly rather than as an error: it is not the reader's fault and
    retrying cannot change it.
  */
  it("says support is not set up when no organization exists", async () => {
    stubAuthFetch({ myConversationId: null });

    renderAt("/dashboard");

    expect(await screen.findByText(/support isn.t set up yet/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });

  it("sends a message and shows what the server stored", async () => {
    const fetchMock = stubAuthFetch();

    renderAt("/dashboard");
    await screen.findByRole("heading", { name: "Hi Ada" });

    const input = await screen.findByLabelText("Your message");
    await userEvent.type(input, "Is anyone there?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, init]) => String(url).includes("/messages") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posts.length).toBe(1);
      expect(String((posts[0]![1] as RequestInit).body)).toContain("Is anyone there?");
    });
  });

  /*
    `senderType` is the server's to assign — a client that sent one could make
    its own message claim to be support's.
  */
  it("sends only the body, never a sender", async () => {
    const fetchMock = stubAuthFetch();

    renderAt("/dashboard");
    await screen.findByRole("heading", { name: "Hi Ada" });

    await userEvent.type(await screen.findByLabelText("Your message"), "Hello");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes("/messages") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ body: "Hello" });
    });
  });

  it("will not send an empty message", async () => {
    stubAuthFetch();

    renderAt("/dashboard");
    await screen.findByRole("heading", { name: "Hi Ada" });

    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the organization to nobody and the token to nobody", async () => {
    const { container } = (stubAuthFetch({ myMessages: MESSAGES }), renderAt("/dashboard"));
    await screen.findByText("My order never arrived.");

    expect(container.textContent).not.toContain(session.accessToken);
  });

  it("addresses no tenant in any request it makes", async () => {
    const fetchMock = stubAuthFetch({ myMessages: MESSAGES });

    renderAt("/dashboard");
    await screen.findByText("My order never arrived.");

    /*
      The addressing guarantee, asserted from the client (ADR-034 §5): a
      customer names no organization, so no request from this page can reach
      across a tenant boundary even by accident.
    */
    const chatCalls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/conversations"));
    expect(chatCalls.length).toBeGreaterThan(0);
    for (const url of chatCalls) {
      expect(url).toContain("/api/v1/me/");
      expect(url).not.toContain("/organizations/");
    }
  });
});

/**
 * An admin is neither a customer nor an agent (ADR-035 §4).
 *
 * The separation the product asked for: one account must not hold two staff
 * surfaces, and "who answers conversations here" must have one answer.
 */
describe("a platform admin's surfaces", () => {
  const adminSession: Session = {
    user: { id: "u1", name: "Yaswanth Kumar", email: "admin@example.com", kind: "admin" },
    accessToken: "header.payload.signature",
  };

  it("is refused the agent workspace and sent to the console", async () => {
    stubAuthFetch({ currentUser: { kind: "admin", platformRole: "admin" } });

    renderAt("/agent", adminSession);

    expect(await screen.findByRole("heading", { name: "Everything, everywhere" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: /welcome back/i })).toBeNull();
  });

  it("is refused the customer chat and sent to the console", async () => {
    stubAuthFetch({ currentUser: { kind: "admin", platformRole: "admin" } });

    renderAt("/dashboard", adminSession);

    expect(await screen.findByRole("heading", { name: "Everything, everywhere" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: /^Hi / })).toBeNull();
  });

  /*
    The console carries what the admin loses by not being an agent: the roster
    and the conversations, read through the tenant they own (ADR-035 §5).
  */
  it("can reach chats and team from inside the console", async () => {
    stubAuthFetch({
      currentUser: { kind: "admin", platformRole: "admin" },
      memberships: [stubMembership("org-acme", "Acme")],
    });

    renderAt("/control", adminSession);
    await screen.findByRole("heading", { name: "Everything, everywhere" });

    expect(screen.getByRole("tab", { name: "Chats" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Team" })).toBeDefined();

    await userEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeDefined();
  });
});

describe("the agent sign-in page", () => {
  it("renders at /agent/login for an anonymous visitor", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/agent/login", null);

    expect(await screen.findByRole("heading", { name: "Agent sign-in" })).toBeDefined();
  });

  /*
    An agent account exists only because an admin created one. Offering
    self-registration here would send them to the customer front door and give
    them the wrong kind of account under their invitation's address.
  */
  it("offers no way to create an account", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/agent/login", null);
    await screen.findByRole("heading", { name: "Agent sign-in" });

    expect(screen.queryByText(/create one/i)).toBeNull();
  });

  it("tells a first-time agent to verify before signing in", async () => {
    stubAuthFetch({ refresh: 401 });

    renderAt("/agent/login", null);

    expect(await screen.findByText(/enter the code from your invitation email/i)).toBeDefined();
  });

  it("sends an agent who is already signed in to their workspace", async () => {
    stubAuthFetch({ currentUser: { kind: "agent" } });

    renderAt("/agent/login");

    expect(await screen.findByRole("heading", { name: "Welcome back, Ada" })).toBeDefined();
  });
});
