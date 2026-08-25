import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { TeamManagement } from "./TeamManagement";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Coverage for the Team Management section (ADR-027 §16).
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - The management controls are gated on the SERVER-CONFIRMED role, and a
 *   reader without `member.manage` is offered none of them.
 * - `403` renders its own state, not a retryable error — a supervisor who will
 *   never hold `member.manage` must not be told to try again.
 * - Removal CONFIRMS, and the confirmation names the person.
 * - The owner's row and the reader's own row offer no controls at all,
 *   mirroring the two structural refusals the server makes (§7).
 * - Every mutation refetches, because the roster is deliberately not live
 *   (§15).
 */

/** An obvious sentinel — if it reaches the DOM, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";
const ORGANIZATION_ID = "org-acme";
const MEMBERS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/members`;

const session: Session = {
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
  accessToken: ACCESS_TOKEN,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const OWNER_ROW = {
  id: "m-owner",
  role: "owner",
  status: "active",
  createdAt: "2026-08-01T09:00:00.000Z",
  user: { id: CURRENT_USER.id, name: CURRENT_USER.name, email: CURRENT_USER.email },
};

const AGENT_ROW = {
  id: "m-agent",
  role: "agent",
  status: "active",
  createdAt: "2026-08-02T09:00:00.000Z",
  user: { id: "u2", name: "Grace Hopper", email: "grace@example.com" },
};

const SUSPENDED_ROW = {
  id: "m-suspended",
  role: "supervisor",
  status: "suspended",
  createdAt: "2026-08-03T09:00:00.000Z",
  user: { id: "u3", name: "Katherine Johnson", email: "katherine@example.com" },
};

interface StubOutcomes {
  list?: { status: number; body: unknown };
  /** Successive list answers, for asserting the refetch after a mutation. */
  listSequence?: { status: number; body: unknown }[];
  add?: { status: number; body: unknown };
  role?: { status: number; body: unknown };
  remove?: { status: number; body: unknown };
}

function roster(members: unknown[]) {
  return { success: true, data: { members } };
}

function failure(code: string, message = "refused") {
  return { success: false, error: { code, message } };
}

/** Routes member calls on top of the shared auth stub, matching WidgetInstallation.test.tsx's pattern. */
function stubMembers(outcomes: StubOutcomes = {}) {
  const base = stubAuthFetch();
  let listIndex = 0;

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (path.includes(MEMBERS_PATH) && method === "DELETE") {
      const outcome = outcomes.remove ?? {
        status: 200,
        body: { success: true, data: { member: AGENT_ROW, releasedConversations: 0 } },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.includes(`${MEMBERS_PATH}/`) && path.endsWith("/role") && method === "PATCH") {
      const outcome = outcomes.role ?? {
        status: 200,
        body: { success: true, data: { ...AGENT_ROW, role: "supervisor" } },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.endsWith(MEMBERS_PATH) && method === "POST") {
      const outcome = outcomes.add ?? {
        status: 201,
        body: { success: true, data: { ...AGENT_ROW, id: "m-new", user: { id: "u9", name: "New Person", email: "new@example.com" } } },
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.endsWith(MEMBERS_PATH) && method === "GET") {
      const sequence = outcomes.listSequence;
      const outcome = sequence
        ? (sequence[Math.min(listIndex++, sequence.length - 1)] ?? { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) })
        : (outcomes.list ?? { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) });
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }

    return base(url, init) as Promise<Response>;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderTeam(role: string | null = "owner", currentUserId: string | null = CURRENT_USER.id) {
  return render(
    <AuthProvider initialSession={session}>
      <TeamManagement organizationId={ORGANIZATION_ID} role={role} currentUserId={currentUserId} />
    </AuthProvider>,
  );
}

/** The list row for one member, found by the name it renders. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement;
}

beforeEach(() => {
  stubAuthFetch();
});

describe("TeamManagement", () => {
  describe("loading, ready, and empty", () => {
    it("shows a loading state before the roster arrives", () => {
      stubMembers();
      renderTeam();

      expect(screen.getByRole("status").textContent).toMatch(/loading the team/i);
    });

    it("renders each member's name, email, and role", async () => {
      stubMembers();
      renderTeam();

      expect(await screen.findByText("Grace Hopper")).toBeTruthy();
      expect(screen.getByText("grace@example.com")).toBeTruthy();
      expect(screen.getByText(CURRENT_USER.name)).toBeTruthy();
    });

    it("marks the reader's own row", async () => {
      stubMembers();
      renderTeam();

      await screen.findByText("Grace Hopper");
      expect(within(rowFor(CURRENT_USER.name)).getByText(/\(you\)/i)).toBeTruthy();
    });

    it("explains a suspended membership rather than hiding it", async () => {
      stubMembers({ list: { status: 200, body: roster([OWNER_ROW, SUSPENDED_ROW]) } });
      renderTeam();

      expect(await screen.findByText("Katherine Johnson")).toBeTruthy();
      expect(screen.getByText(/access revoked/i)).toBeTruthy();
    });

    it("renders a membership whose account no longer resolves, so it can be cleaned up", async () => {
      stubMembers({
        list: { status: 200, body: roster([OWNER_ROW, { ...AGENT_ROW, user: null }]) },
      });
      renderTeam();

      expect(await screen.findByText(/unknown account/i)).toBeTruthy();
    });

    it("says so when the roster is empty rather than showing a bare list", async () => {
      stubMembers({ list: { status: 200, body: roster([]) } });
      renderTeam();

      expect(await screen.findByText(/nobody is in this organization yet/i)).toBeTruthy();
    });

    it("survives a well-formed envelope with no members list", async () => {
      stubMembers({ list: { status: 200, body: { success: true, data: {} } } });
      renderTeam();

      expect(await screen.findByText(/nobody is in this organization yet/i)).toBeTruthy();
    });
  });

  describe("error and forbidden states", () => {
    it("renders a 403 as its own non-retryable state", async () => {
      stubMembers({ list: { status: 403, body: failure("INSUFFICIENT_PERMISSION") } });
      renderTeam("agent");

      expect(await screen.findByText(/your role cannot see this organization/i)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    });

    it("renders a transport failure as a retryable error", async () => {
      stubMembers({ list: { status: 500, body: failure("INTERNAL_ERROR") } });
      renderTeam();

      expect((await screen.findByRole("alert")).textContent).toMatch(/could not load the team/i);
      expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    });

    it("refetches when the retry control is pressed", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers({
        listSequence: [
          { status: 500, body: failure("INTERNAL_ERROR") },
          { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) },
        ],
      });
      renderTeam();

      await user.click(await screen.findByRole("button", { name: /try again/i }));

      expect(await screen.findByText("Grace Hopper")).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(MEMBERS_PATH) && (init as RequestInit | undefined)?.method === undefined)).toHaveLength(2);
    });

    it("shows nothing at all for a 401, which is a sign-out already in progress", async () => {
      stubMembers({ list: { status: 401, body: failure("INVALID_ACCESS_TOKEN") } });
      renderTeam();

      // It never leaves "loading", because a 401 is not this section's to report.
      await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/loading the team/i));
    });
  });

  describe("permission-aware controls", () => {
    it("offers the add form and row controls to an owner", async () => {
      stubMembers();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      expect(screen.getByRole("button", { name: /add member/i })).toBeTruthy();
      expect(within(rowFor("Grace Hopper")).getByRole("button", { name: /remove/i })).toBeTruthy();
    });

    it("offers the same to an admin", async () => {
      stubMembers();
      renderTeam("admin");

      await screen.findByText("Grace Hopper");
      expect(screen.getByRole("button", { name: /add member/i })).toBeTruthy();
    });

    it("offers a supervisor the roster and NO controls", async () => {
      stubMembers();
      renderTeam("supervisor", "u9");

      await screen.findByText("Grace Hopper");
      expect(screen.queryByRole("button", { name: /add member/i })).toBeNull();
      expect(within(rowFor("Grace Hopper")).queryByRole("button", { name: /remove/i })).toBeNull();
      // The role is still shown — knowing who does what is what member.read is for.
      expect(within(rowFor("Grace Hopper")).getByText("agent")).toBeTruthy();
    });

    it("offers no controls while the role is unconfirmed", async () => {
      stubMembers();
      renderTeam(null, "u9");

      await screen.findByText("Grace Hopper");
      expect(screen.queryByRole("button", { name: /add member/i })).toBeNull();
    });

    it("offers no controls on the OWNER's row, mirroring the server's owner protection", async () => {
      stubMembers();
      renderTeam("admin", "u9");

      await screen.findByText("Grace Hopper");
      const ownerRow = rowFor(CURRENT_USER.name);
      expect(within(ownerRow).queryByRole("button", { name: /remove/i })).toBeNull();
      expect(within(ownerRow).queryByRole("combobox")).toBeNull();
      expect(within(ownerRow).getByText("owner")).toBeTruthy();
    });

    it("offers no controls on the reader's OWN row", async () => {
      stubMembers({
        list: { status: 200, body: roster([OWNER_ROW, { ...AGENT_ROW, user: { ...AGENT_ROW.user, id: "u-self" } }]) },
      });
      renderTeam("admin", "u-self");

      await screen.findByText("Grace Hopper");
      expect(within(rowFor("Grace Hopper")).queryByRole("button", { name: /remove/i })).toBeNull();
    });

    it("never offers owner as a role a control can set", async () => {
      stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      const select = within(rowFor("Grace Hopper")).getByRole("combobox") as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual(["admin", "supervisor", "agent"]);
    });
  });

  describe("adding a member", () => {
    it("sends the email and role, and nothing else", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      await user.type(screen.getByLabelText(/email address/i), "new@example.com");
      await user.selectOptions(screen.getByLabelText(/^role$/i), "supervisor");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      await waitFor(() => {
        const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
        expect(post).toBeDefined();
        expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
          email: "new@example.com",
          role: "supervisor",
        });
      });
    });

    it("confirms the addition using the name the SERVER resolved", async () => {
      const user = userEvent.setup();
      stubMembers();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      await user.type(screen.getByLabelText(/email address/i), "new@example.com");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      expect(await screen.findByText(/new person was added as agent/i)).toBeTruthy();
    });

    it("clears the field on success and refetches the roster", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      const field = screen.getByLabelText(/email address/i) as HTMLInputElement;
      await user.type(field, "new@example.com");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      await waitFor(() => expect(field.value).toBe(""));
      const lists = fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith(MEMBERS_PATH) && (init as RequestInit | undefined)?.method === undefined,
      );
      expect(lists.length).toBeGreaterThanOrEqual(2);
    });

    it("keeps a refused address on screen for correction", async () => {
      const user = userEvent.setup();
      stubMembers({ add: { status: 422, body: failure("MEMBER_NOT_INVITABLE") } });
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      const field = screen.getByLabelText(/email address/i) as HTMLInputElement;
      await user.type(field, "ghost@example.com");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/needs a verified serviqo account/i);
      expect(field.value).toBe("ghost@example.com");
    });

    it("states the reason a duplicate was refused", async () => {
      const user = userEvent.setup();
      stubMembers({ add: { status: 409, body: failure("MEMBER_ALREADY_EXISTS") } });
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      await user.type(screen.getByLabelText(/email address/i), "grace@example.com");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/already a member/i);
    });

    it("states the reason when the invite budget is exhausted", async () => {
      const user = userEvent.setup();
      stubMembers({ add: { status: 429, body: failure("TOO_MANY_REQUESTS") } });
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      await user.type(screen.getByLabelText(/email address/i), "new@example.com");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/too many attempts/i);
    });

    it("never renders the server's own message text", async () => {
      const user = userEvent.setup();
      stubMembers({
        add: { status: 500, body: failure("INTERNAL_ERROR", "INTERNAL DETAIL FROM THE SERVER") },
      });
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      await user.type(screen.getByLabelText(/email address/i), "new@example.com");
      await user.click(screen.getByRole("button", { name: /add member/i }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/that did not work/i);
      expect(screen.queryByText(/INTERNAL DETAIL FROM THE SERVER/)).toBeNull();
    });

    it("does not submit an empty address", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      const submit = screen.getByRole("button", { name: /add member/i }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);

      await user.click(submit);
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    });
  });

  describe("changing a role", () => {
    it("sends the chosen role to the membership's own path", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.selectOptions(within(rowFor("Grace Hopper")).getByRole("combobox"), "supervisor");

      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
        expect(patch).toBeDefined();
        expect(String(patch![0])).toBe(`${MEMBERS_PATH}/m-agent/role`);
        expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ role: "supervisor" });
      });
    });

    it("confirms the change with the role the server reported", async () => {
      const user = userEvent.setup();
      stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.selectOptions(within(rowFor("Grace Hopper")).getByRole("combobox"), "supervisor");

      expect(await screen.findByText(/grace hopper is now supervisor/i)).toBeTruthy();
    });

    it("states the reason the owner is protected", async () => {
      const user = userEvent.setup();
      stubMembers({ role: { status: 409, body: failure("ORGANIZATION_OWNER_PROTECTED") } });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.selectOptions(within(rowFor("Grace Hopper")).getByRole("combobox"), "admin");

      expect((await screen.findByRole("alert")).textContent).toMatch(/owner cannot be changed or removed/i);
    });

    it("states the reason self-modification is refused", async () => {
      const user = userEvent.setup();
      stubMembers({ role: { status: 409, body: failure("MEMBER_SELF_MODIFICATION") } });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.selectOptions(within(rowFor("Grace Hopper")).getByRole("combobox"), "admin");

      expect((await screen.findByRole("alert")).textContent).toMatch(/your own membership/i);
    });

    it("says the member is gone when the server answers 404", async () => {
      const user = userEvent.setup();
      stubMembers({ role: { status: 404, body: failure("NOT_FOUND") } });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.selectOptions(within(rowFor("Grace Hopper")).getByRole("combobox"), "admin");

      expect((await screen.findByRole("alert")).textContent).toMatch(/no longer part of this organization/i);
    });

    it("refetches the roster after a change, because it is not live", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.selectOptions(within(rowFor("Grace Hopper")).getByRole("combobox"), "supervisor");

      await waitFor(() => {
        const lists = fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith(MEMBERS_PATH) && (init as RequestInit | undefined)?.method === undefined,
        );
        expect(lists.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe("removing a member", () => {
    it("confirms before removing, and the confirmation names the person", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));

      expect(screen.getByText(/remove grace hopper from this organization\?/i)).toBeTruthy();
      // Nothing has been sent yet.
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(
        false,
      );
    });

    it("sends the delete only after the confirmation is accepted", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /yes, remove/i }));

      await waitFor(() => {
        const del = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
        expect(del).toBeDefined();
        expect(String(del![0])).toBe(`${MEMBERS_PATH}/m-agent`);
      });
    });

    it("cancels without sending anything", async () => {
      const user = userEvent.setup();
      const fetchMock = stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(screen.queryByText(/remove grace hopper from this organization\?/i)).toBeNull();
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(
        false,
      );
    });

    it("states how many conversations returned to the unassigned queue", async () => {
      const user = userEvent.setup();
      stubMembers({
        remove: { status: 200, body: { success: true, data: { member: AGENT_ROW, releasedConversations: 3 } } },
      });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /yes, remove/i }));

      expect(await screen.findByText(/3 conversations returned to the unassigned queue/i)).toBeTruthy();
    });

    it("says nothing about conversations when none were released", async () => {
      const user = userEvent.setup();
      stubMembers();
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /yes, remove/i }));

      expect(await screen.findByText(/grace hopper was removed\./i)).toBeTruthy();
      expect(screen.queryByText(/unassigned queue/i)).toBeNull();
    });

    it("drops the row after the refetch", async () => {
      const user = userEvent.setup();
      stubMembers({
        listSequence: [
          { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) },
          { status: 200, body: roster([OWNER_ROW]) },
        ],
      });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /yes, remove/i }));

      await waitFor(() => expect(screen.queryByText("Grace Hopper")).toBeNull());
    });

    it("states the reason the owner cannot be removed", async () => {
      const user = userEvent.setup();
      stubMembers({ remove: { status: 409, body: failure("ORGANIZATION_OWNER_PROTECTED") } });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /yes, remove/i }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/owner cannot be changed or removed/i);
    });

    it("states the reason a role without member.manage was refused", async () => {
      const user = userEvent.setup();
      stubMembers({ remove: { status: 403, body: failure("INSUFFICIENT_PERMISSION") } });
      renderTeam("owner", "u9");

      await screen.findByText("Grace Hopper");
      await user.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));
      await user.click(screen.getByRole("button", { name: /yes, remove/i }));

      expect((await screen.findByRole("alert")).textContent).toMatch(/your role cannot manage/i);
    });
  });

  describe("organization scoping", () => {
    it("reads only the organization it was given", async () => {
      const fetchMock = stubMembers();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      const memberCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/members"));
      expect(memberCalls.length).toBeGreaterThan(0);
      for (const [url] of memberCalls) {
        expect(String(url)).toContain(`/organizations/${ORGANIZATION_ID}/members`);
      }
    });

    it("never renders the access token", async () => {
      stubMembers();
      const { container } = renderTeam("owner");

      await screen.findByText("Grace Hopper");
      expect(container.innerHTML).not.toContain(ACCESS_TOKEN);
    });
  });
});
