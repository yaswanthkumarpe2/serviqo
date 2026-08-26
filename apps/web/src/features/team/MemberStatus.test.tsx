import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { TeamManagement } from "./TeamManagement";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Coverage for the Suspend / Reactivate controls (ADR-029 §14), driven through
 * `TeamManagement` because whether they render at all is that component's
 * decision.
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - The owner row is NEVER offered Suspend, and neither is the reader's own —
 *   the two structural refusals the server makes, mirrored so a manager is not
 *   offered a button whose only outcome is a 409.
 * - A reader without `member.manage` is offered nothing.
 * - Suspension CONFIRMS and names the person; reactivation deliberately does
 *   not, because it restores access rather than taking it away.
 * - The request body is exactly `{ status }` — no membershipId, no
 *   organizationId, no role (ADR-029 §4).
 * - Every control is disabled while a mutation is in flight, and the roster is
 *   refetched afterwards.
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

const ACTIVE_AGENT = {
  id: "m-agent",
  role: "agent",
  status: "active",
  createdAt: "2026-08-02T09:00:00.000Z",
  user: { id: "u2", name: "Grace Hopper", email: "grace@example.com" },
};

const SUSPENDED_AGENT = {
  id: "m-suspended",
  role: "agent",
  status: "suspended",
  createdAt: "2026-08-03T09:00:00.000Z",
  user: { id: "u3", name: "Katherine Johnson", email: "katherine@example.com" },
};

const INVITED_AGENT = {
  id: "m-invited",
  role: "agent",
  status: "invited",
  createdAt: "2026-08-04T09:00:00.000Z",
  user: { id: "u4", name: "Dorothy Vaughan", email: "dorothy@example.com" },
};

function roster(members: unknown[]) {
  return { success: true, data: { members } };
}

function failure(code: string, message = "the server's own words, which must not be rendered") {
  return { success: false, error: { code, message } };
}

function statusOk(member: unknown, releasedConversations = 0) {
  return { success: true, data: { member, releasedConversations } };
}

interface StubOutcomes {
  list?: { status: number; body: unknown };
  listSequence?: { status: number; body: unknown }[];
  status?: { status: number; body: unknown };
}

function stubStatus(outcomes: StubOutcomes = {}) {
  const base = stubAuthFetch();
  let listIndex = 0;

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (path.includes(MEMBERS_PATH) && path.endsWith("/status") && method === "PATCH") {
      const outcome = outcomes.status ?? {
        status: 200,
        body: statusOk({ ...ACTIVE_AGENT, status: "suspended" }),
      };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.endsWith(MEMBERS_PATH) && method === "GET") {
      const sequence = outcomes.listSequence;
      const outcome = sequence
        ? (sequence[Math.min(listIndex++, sequence.length - 1)] ?? {
            status: 200,
            body: roster([OWNER_ROW, ACTIVE_AGENT]),
          })
        : (outcomes.list ?? { status: 200, body: roster([OWNER_ROW, ACTIVE_AGENT]) });
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

/** The bodies of every PATCH to a status route. */
function statusBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/status") && init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
}

function statusUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/status"));
}

beforeEach(() => {
  stubAuthFetch();
});

describe("member status controls", () => {
  // ---- which rows get which control ----

  describe("visibility", () => {
    it("offers Suspend for an active member", async () => {
      stubStatus();
      renderTeam();

      await screen.findByText("Grace Hopper");
      expect(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i })).toBeTruthy();
    });

    it("offers Reactivate for a suspended member", async () => {
      stubStatus({ list: { status: 200, body: roster([OWNER_ROW, SUSPENDED_AGENT]) } });
      renderTeam();

      await screen.findByText("Katherine Johnson");
      const row = rowFor("Katherine Johnson");
      expect(within(row).getByRole("button", { name: /^reactivate$/i })).toBeTruthy();
      expect(within(row).queryByRole("button", { name: /^suspend$/i })).toBeNull();
    });

    /*
      A SUSPENDED OWNER is a fourth route to an unrecoverable tenant, and the
      server refuses it — so the button is never offered (ADR-029 §7, §14).
    */
    it("never offers Suspend for the owner", async () => {
      stubStatus({
        list: {
          status: 200,
          body: roster([
            { ...OWNER_ROW, user: { id: "u9", name: "Other Owner", email: "owner@example.com" } },
            ACTIVE_AGENT,
          ]),
        },
      });
      renderTeam("admin");

      await screen.findByText("Other Owner");
      const ownerRow = rowFor("Other Owner");
      expect(within(ownerRow).queryByRole("button", { name: /suspend/i })).toBeNull();
      expect(within(ownerRow).queryByRole("button", { name: /reactivate/i })).toBeNull();
    });

    it("never offers Suspend on the reader's own row", async () => {
      stubStatus();
      renderTeam();

      await screen.findByText("Grace Hopper");
      const ownRow = rowFor(CURRENT_USER.name);
      expect(within(ownRow).queryByRole("button", { name: /suspend/i })).toBeNull();
    });

    /*
      An `invited` membership gets neither direction: a manager can neither
      accept an invitation on someone's behalf nor suspend access that was
      never granted (ADR-029 §14).
    */
    it("offers neither control for an invited member", async () => {
      stubStatus({ list: { status: 200, body: roster([OWNER_ROW, INVITED_AGENT]) } });
      renderTeam();

      await screen.findByText("Dorothy Vaughan");
      const row = rowFor("Dorothy Vaughan");
      expect(within(row).queryByRole("button", { name: /suspend/i })).toBeNull();
      expect(within(row).queryByRole("button", { name: /reactivate/i })).toBeNull();
      // The row still explains itself.
      expect(row.textContent).toMatch(/has not accepted yet/i);
    });

    it.each([["supervisor"], ["agent"], [null]])("offers nothing to %s", async (role) => {
      stubStatus();
      renderTeam(role as string | null);

      await screen.findByText("Grace Hopper");
      expect(screen.queryByRole("button", { name: /^suspend$/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^reactivate$/i })).toBeNull();
    });

    it("renders the suspended state in words", async () => {
      stubStatus({ list: { status: 200, body: roster([OWNER_ROW, SUSPENDED_AGENT]) } });
      renderTeam();

      await screen.findByText("Katherine Johnson");
      expect(rowFor("Katherine Johnson").textContent).toMatch(/access revoked/i);
    });
  });

  // ---- confirmation (ADR-029 §14) ----

  describe("confirmation", () => {
    it("asks before suspending, and names the person and the consequence", async () => {
      const fetchMock = stubStatus();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));

      const dialog = screen.getByRole("alertdialog", { name: /confirm suspension/i });
      expect(dialog.textContent).toContain("Grace Hopper");
      expect(dialog.textContent).toMatch(/lose access to this organization immediately/i);
      expect(dialog.textContent).toMatch(/unassigned queue/i);
      expect(statusBodies(fetchMock)).toHaveLength(0);
    });

    it("sends nothing when the suspension is cancelled", async () => {
      const fetchMock = stubStatus();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(statusBodies(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    /*
      REACTIVATION DOES NOT CONFIRM (ADR-029 §14). It restores access rather
      than taking it away, and a confirmation on every safe action is how
      people learn to click through the unsafe ones.
    */
    it("reactivates without a confirmation step", async () => {
      const fetchMock = stubStatus({
        list: { status: 200, body: roster([OWNER_ROW, SUSPENDED_AGENT]) },
        status: { status: 200, body: statusOk({ ...SUSPENDED_AGENT, status: "active" }) },
      });
      renderTeam();

      await screen.findByText("Katherine Johnson");
      await userEvent.click(within(rowFor("Katherine Johnson")).getByRole("button", { name: /^reactivate$/i }));

      await waitFor(() => expect(statusBodies(fetchMock)).toHaveLength(1));
      expect(statusBodies(fetchMock)[0]).toEqual({ status: "active" });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    /* One question open at a time, so no dialog can be misread as the other. */
    it("closes the removal confirmation when a suspension is asked", async () => {
      stubStatus();
      renderTeam();

      await screen.findByText("Grace Hopper");
      const row = rowFor("Grace Hopper");
      await userEvent.click(within(row).getByRole("button", { name: /^remove$/i }));
      expect(screen.getByRole("alertdialog", { name: /confirm removal/i })).toBeTruthy();

      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));

      expect(screen.queryByRole("alertdialog", { name: /confirm removal/i })).toBeNull();
      expect(screen.getByRole("alertdialog", { name: /confirm suspension/i })).toBeTruthy();
    });

    it("closes the suspension confirmation when a removal is asked", async () => {
      stubStatus();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^remove$/i }));

      expect(screen.queryByRole("alertdialog", { name: /confirm suspension/i })).toBeNull();
      expect(screen.getByRole("alertdialog", { name: /confirm removal/i })).toBeTruthy();
    });
  });

  // ---- the request (ADR-029 §4) ----

  describe("the request it sends", () => {
    async function suspendGrace() {
      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, suspend/i }));
    }

    it("PATCHes the status route for the row's membership", async () => {
      const fetchMock = stubStatus();
      renderTeam();

      await suspendGrace();

      await waitFor(() => expect(statusUrls(fetchMock)).toHaveLength(1));
      expect(statusUrls(fetchMock)[0]).toBe(`${MEMBERS_PATH}/${ACTIVE_AGENT.id}/status`);
    });

    it("sends exactly { status } and nothing else", async () => {
      const fetchMock = stubStatus();
      renderTeam();

      await suspendGrace();

      await waitFor(() => expect(statusBodies(fetchMock)).toHaveLength(1));
      const body = statusBodies(fetchMock)[0]!;
      expect(Object.keys(body)).toEqual(["status"]);
      expect(body.status).toBe("suspended");
      expect(body).not.toHaveProperty("membershipId");
      expect(body).not.toHaveProperty("organizationId");
      expect(body).not.toHaveProperty("userId");
      expect(body).not.toHaveProperty("role");
    });

    it("never renders the access token", async () => {
      stubStatus();
      const { container } = renderTeam();

      await screen.findByText("Grace Hopper");
      expect(container.innerHTML).not.toContain(ACCESS_TOKEN);
    });
  });

  // ---- pending and post-action state ----

  describe("pending and result states", () => {
    it("disables every control while the request is in flight", async () => {
      let release: (value: Response) => void = () => undefined;
      const base = stubAuthFetch();
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/status") && init?.method === "PATCH") {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        if (path.endsWith(MEMBERS_PATH)) {
          return Promise.resolve(jsonResponse(200, roster([OWNER_ROW, ACTIVE_AGENT])));
        }
        return base(url, init) as Promise<Response>;
      });
      vi.stubGlobal("fetch", fetchMock);

      renderTeam();
      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, suspend/i }));

      await waitFor(() => {
        const remove = within(rowFor("Grace Hopper")).getByRole("button", { name: /remov/i }) as HTMLButtonElement;
        expect(remove.disabled).toBe(true);
      });
      const roleSelect = within(rowFor("Grace Hopper")).getByRole("combobox") as HTMLSelectElement;
      expect(roleSelect.disabled).toBe(true);

      release(jsonResponse(200, statusOk({ ...ACTIVE_AGENT, status: "suspended" })));
      await waitFor(() => expect(screen.getByText(/was suspended/i)).toBeTruthy());
    });

    it("refetches the roster and shows the new status", async () => {
      stubStatus({
        listSequence: [
          { status: 200, body: roster([OWNER_ROW, ACTIVE_AGENT]) },
          { status: 200, body: roster([OWNER_ROW, { ...ACTIVE_AGENT, status: "suspended" }]) },
        ],
      });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, suspend/i }));

      await waitFor(() =>
        expect(within(rowFor("Grace Hopper")).getByRole("button", { name: /^reactivate$/i })).toBeTruthy(),
      );
      expect(rowFor("Grace Hopper").textContent).toMatch(/access revoked/i);
    });

    it("states the suspension and the released conversations", async () => {
      stubStatus({ status: { status: 200, body: statusOk({ ...ACTIVE_AGENT, status: "suspended" }, 3) } });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, suspend/i }));

      const notice = await screen.findByText(/was suspended/i);
      expect(notice.textContent).toContain("Grace Hopper");
      expect(notice.textContent).toMatch(/3 conversations returned to the unassigned queue/i);
    });

    it("says nothing about conversations when none were released", async () => {
      stubStatus({ status: { status: 200, body: statusOk({ ...ACTIVE_AGENT, status: "suspended" }, 0) } });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, suspend/i }));

      const notice = await screen.findByText(/was suspended/i);
      expect(notice.textContent).toMatch(/can no longer sign in/i);
      expect(notice.textContent).not.toMatch(/queue/i);
    });

    it("states a reactivation in its own words", async () => {
      stubStatus({
        list: { status: 200, body: roster([OWNER_ROW, SUSPENDED_AGENT]) },
        status: { status: 200, body: statusOk({ ...SUSPENDED_AGENT, status: "active" }) },
      });
      renderTeam();

      await screen.findByText("Katherine Johnson");
      await userEvent.click(within(rowFor("Katherine Johnson")).getByRole("button", { name: /^reactivate$/i }));

      const notice = await screen.findByText(/was reactivated/i);
      expect(notice.textContent).toContain("Katherine Johnson");
      expect(notice.textContent).toMatch(/can sign in again/i);
    });
  });

  // ---- refusals, in this client's own words ----

  describe("errors", () => {
    async function attemptSuspend() {
      await screen.findByText("Grace Hopper");
      await userEvent.click(within(rowFor("Grace Hopper")).getByRole("button", { name: /^suspend$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, suspend/i }));
    }

    it.each([
      ["MEMBER_STATUS_TRANSITION_INVALID", 409, /status has already changed/i],
      ["ORGANIZATION_OWNER_PROTECTED", 409, /owner cannot be changed or removed/i],
      ["MEMBER_SELF_MODIFICATION", 409, /your own membership/i],
      ["INSUFFICIENT_PERMISSION", 403, /cannot manage this organization/i],
      ["NOT_FOUND", 404, /no longer part of this organization/i],
      ["TOO_MANY_REQUESTS", 429, /too many attempts/i],
    ])("renders its own words for %s", async (code, status, expected) => {
      stubStatus({ status: { status, body: failure(code) } });
      renderTeam();

      await attemptSuspend();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(expected);
    });

    it("never renders the server's message text", async () => {
      stubStatus({
        status: { status: 409, body: failure("MEMBER_STATUS_TRANSITION_INVALID", "RAW_SERVER_TEXT_XYZ") },
      });
      const { container } = renderTeam();

      await attemptSuspend();

      await screen.findByRole("alert");
      expect(container.innerHTML).not.toContain("RAW_SERVER_TEXT_XYZ");
    });

    /*
      A refused mutation may still mean the roster moved under us — a stale
      page is exactly what a transition conflict means — so the hook refetches
      on the failure path too (ADR-027 §15's rule, unchanged).
    */
    it("refetches the roster after a refusal", async () => {
      const fetchMock = stubStatus({
        status: { status: 409, body: failure("MEMBER_STATUS_TRANSITION_INVALID") },
      });
      renderTeam();

      await attemptSuspend();
      await screen.findByRole("alert");

      const listCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith(MEMBERS_PATH) && (init?.method ?? "GET") === "GET",
      );
      expect(listCalls.length).toBeGreaterThan(1);
    });

    it("closes the confirmation after a refusal, so the row is usable again", async () => {
      stubStatus({ status: { status: 409, body: failure("MEMBER_STATUS_TRANSITION_INVALID") } });
      renderTeam();

      await attemptSuspend();

      await screen.findByRole("alert");
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });
});
