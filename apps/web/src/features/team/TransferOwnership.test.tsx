import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "@/features/auth/AuthProvider";
import { CURRENT_USER, stubAuthFetch } from "@/features/auth/testing/stubAuthFetch";
import { TeamManagement } from "./TeamManagement";

import type { Session } from "@/features/auth/AuthContext";

/**
 * Coverage for the Transfer Ownership block (ADR-028 §16), driven through
 * `TeamManagement` rather than in isolation — because the thing under test is
 * partly WHETHER IT RENDERS AT ALL, which is `TeamManagement`'s decision, and
 * partly what happens to the surrounding page afterwards.
 *
 * The assertions that matter most and are invisible when broken:
 *
 * - Only `owner` is offered the block. `admin` holds every management
 *   permission and is offered nothing here — the first time those two roles
 *   diverge in this UI (ADR-028 §2).
 * - The picker cannot offer the current owner, a suspended member, an invited
 *   one, or a membership with no account.
 * - Nothing is sent until an explicit confirmation that NAMES the person.
 * - The request body is exactly `{ membershipId }` — no `organizationId`, no
 *   `currentOwnerId`, no `role`. A client that sent one would be pretending to
 *   an authority it does not have (ADR-028 §4).
 * - Success refetches the roster AND signals that the organization context is
 *   stale, which is what takes the previous owner's owner-only controls away.
 * - Every server refusal maps to this client's own words; the server's message
 *   text is never rendered.
 */

/** An obvious sentinel — if it reaches the DOM, the test fails. */
const ACCESS_TOKEN = "SEEDED_ACCESS_TOKEN_DO_NOT_RENDER";
const ORGANIZATION_ID = "org-acme";
const MEMBERS_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/members`;
const OWNERSHIP_PATH = `/api/v1/organizations/${ORGANIZATION_ID}/ownership`;

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

const ADMIN_ROW = {
  id: "m-admin",
  role: "admin",
  status: "active",
  createdAt: "2026-08-03T09:00:00.000Z",
  user: { id: "u3", name: "Katherine Johnson", email: "katherine@example.com" },
};

const SUSPENDED_ROW = {
  id: "m-suspended",
  role: "supervisor",
  status: "suspended",
  createdAt: "2026-08-04T09:00:00.000Z",
  user: { id: "u4", name: "Mary Jackson", email: "mary@example.com" },
};

const INVITED_ROW = {
  id: "m-invited",
  role: "agent",
  status: "invited",
  createdAt: "2026-08-05T09:00:00.000Z",
  user: { id: "u5", name: "Dorothy Vaughan", email: "dorothy@example.com" },
};

/** A membership whose account no longer resolves — real, and not an owner candidate. */
const ORPHAN_ROW = {
  id: "m-orphan",
  role: "agent",
  status: "active",
  createdAt: "2026-08-06T09:00:00.000Z",
  user: null,
};

function roster(members: unknown[]) {
  return { success: true, data: { members } };
}

function failure(code: string, message = "the server's own words, which must not be rendered") {
  return { success: false, error: { code, message } };
}

const TRANSFER_OK = {
  success: true,
  data: { previousOwner: { id: "m-owner", role: "admin" }, newOwner: { id: "m-agent", role: "owner" } },
};

interface StubOutcomes {
  list?: { status: number; body: unknown };
  /** Successive list answers, for asserting the refetch after the transfer. */
  listSequence?: { status: number; body: unknown }[];
  transfer?: { status: number; body: unknown };
}

function stubOwnership(outcomes: StubOutcomes = {}) {
  const base = stubAuthFetch();
  let listIndex = 0;

  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (path.endsWith(OWNERSHIP_PATH) && method === "POST") {
      const outcome = outcomes.transfer ?? { status: 200, body: TRANSFER_OK };
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }
    if (path.endsWith(MEMBERS_PATH) && method === "GET") {
      const sequence = outcomes.listSequence;
      const outcome = sequence
        ? (sequence[Math.min(listIndex++, sequence.length - 1)] ?? {
            status: 200,
            body: roster([OWNER_ROW, AGENT_ROW]),
          })
        : (outcomes.list ?? { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) });
      return Promise.resolve(jsonResponse(outcome.status, outcome.body));
    }

    return base(url, init) as Promise<Response>;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderTeam(role: string | null = "owner", onOrganizationContextStale = vi.fn()) {
  const result = render(
    <AuthProvider initialSession={session}>
      <TeamManagement
        organizationId={ORGANIZATION_ID}
        role={role}
        currentUserId={CURRENT_USER.id}
        onOrganizationContextStale={onOrganizationContextStale}
      />
    </AuthProvider>,
  );
  return { ...result, onOrganizationContextStale };
}

const transferSection = () => screen.getByRole("region", { name: /transfer ownership/i });
const queryTransferSection = () => screen.queryByRole("region", { name: /transfer ownership/i });

/** The bodies of every POST to the ownership route. */
function transferBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith(OWNERSHIP_PATH) && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
}

beforeEach(() => {
  stubAuthFetch();
});

describe("TransferOwnership", () => {
  // ---- who sees it (ADR-028 §16) ----

  describe("permission visibility", () => {
    it("shows the block to the owner", async () => {
      stubOwnership();
      renderTeam("owner");

      await screen.findByText("Grace Hopper");
      expect(transferSection()).toBeTruthy();
    });

    /*
      THE assertion of this slice's UI half. `admin` holds `member.manage` and
      sees every other control on this page, and holds nothing here — the first
      place the two roles diverge (ADR-028 §2).
    */
    it("hides the block from an admin who can otherwise manage members", async () => {
      stubOwnership();
      renderTeam("admin");

      await screen.findByText("Grace Hopper");
      expect(queryTransferSection()).toBeNull();
      // …while the add-member form, which needs `member.manage`, is present.
      expect(screen.getByRole("heading", { name: /add a member/i })).toBeTruthy();
    });

    it.each([["supervisor"], ["agent"], [null]])("hides the block from %s", async (role) => {
      stubOwnership();
      renderTeam(role as string | null);

      await screen.findByText("Grace Hopper");
      expect(queryTransferSection()).toBeNull();
    });

    /*
      A control that appeared while the role was still unconfirmed and then
      vanished is worse than one that appears a moment late — and this one is
      destructive.
    */
    it("hides the block while the role is still unconfirmed", () => {
      stubOwnership();
      renderTeam(null);

      expect(queryTransferSection()).toBeNull();
    });
  });

  // ---- who it will offer (ADR-028 §6, §16) ----

  describe("eligible members", () => {
    it("offers an active non-owner", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      expect(screen.getByRole("option", { name: /Grace Hopper \(agent\)/ })).toBeTruthy();
    });

    it("never offers the current owner", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      const select = screen.getByLabelText(/new owner/i) as HTMLSelectElement;
      const values = Array.from(select.options).map((option) => option.value);
      expect(values).not.toContain(OWNER_ROW.id);
      expect(values).toEqual(["", AGENT_ROW.id]);
    });

    /*
      An eligible member is included in each roster on purpose, so the picker
      exists and the assertion is "this row is not among the options" rather
      than "there is no picker" — which would pass for the wrong reason.
    */
    it.each([
      ["a suspended member", SUSPENDED_ROW, "Mary Jackson"],
      ["an invited member", INVITED_ROW, "Dorothy Vaughan"],
      ["a membership whose account no longer resolves", ORPHAN_ROW, "Unknown account"],
    ])("never offers %s", async (_label, row, name) => {
      stubOwnership({ list: { status: 200, body: roster([OWNER_ROW, AGENT_ROW, row]) } });
      renderTeam();

      await screen.findByText(name);
      const select = screen.getByLabelText(/new owner/i) as HTMLSelectElement;
      const values = Array.from(select.options).map((option) => option.value);
      expect(values).not.toContain(row.id);
      // The eligible one is there, so the absence above means something.
      expect(values).toContain(AGENT_ROW.id);
    });

    it("says so when there is nobody eligible, instead of an empty picker", async () => {
      stubOwnership({ list: { status: 200, body: roster([OWNER_ROW, SUSPENDED_ROW]) } });
      renderTeam();

      await screen.findByText("Mary Jackson");
      expect(screen.getByText(/nobody to transfer ownership to/i)).toBeTruthy();
      expect(screen.queryByLabelText(/new owner/i)).toBeNull();
    });

    /*
      §16: the picker discloses nothing beyond the roster already on screen, and
      deliberately not the address — an option label is somewhere no layout
      controls.
    */
    it("does not put email addresses in the picker", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      const select = screen.getByLabelText(/new owner/i) as HTMLSelectElement;
      expect(select.textContent).not.toContain("grace@example.com");
    });
  });

  // ---- the confirmation flow ----

  describe("confirmation", () => {
    it("explains what the transfer does, before anything is chosen", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      const section = transferSection();
      expect(section.textContent).toMatch(/becomes the owner/i);
      expect(section.textContent).toMatch(/you become an admin/i);
    });

    it("keeps the transfer button disabled until a member is chosen", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      const button = screen.getByRole("button", { name: /^transfer ownership$/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it("asks for confirmation and names the person, without sending anything", async () => {
      const fetchMock = stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));

      const dialog = screen.getByRole("alertdialog", { name: /confirm ownership transfer/i });
      expect(dialog.textContent).toContain("Grace Hopper");
      expect(dialog.textContent).toMatch(/you will become an admin/i);
      expect(transferBodies(fetchMock)).toHaveLength(0);
    });

    it("sends nothing when the confirmation is cancelled", async () => {
      const fetchMock = stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(transferBodies(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      // And the picker is back, with the choice intact.
      expect((screen.getByLabelText(/new owner/i) as HTMLSelectElement).value).toBe(AGENT_ROW.id);
    });

    /*
      A confirmation naming one person while the selection moved to another is
      exactly the ambiguity a destructive action must not have — and it is
      impossible here BY CONSTRUCTION rather than by a handler: the picker is
      replaced by the confirmation, so there is no control to change the choice
      with while a dialog naming someone is open.
    */
    it("removes the picker while the confirmation is open, so the choice cannot move under it", async () => {
      stubOwnership({ list: { status: 200, body: roster([OWNER_ROW, AGENT_ROW, ADMIN_ROW]) } });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));

      expect(screen.getByRole("alertdialog").textContent).toContain("Grace Hopper");
      expect(screen.queryByLabelText(/new owner/i)).toBeNull();
    });

    /* And after cancelling, changing the choice clears the previous state. */
    it("lets the choice change again once the confirmation is cancelled", async () => {
      stubOwnership({ list: { status: 200, body: roster([OWNER_ROW, AGENT_ROW, ADMIN_ROW]) } });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), ADMIN_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));

      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Katherine Johnson");
      expect(dialog.textContent).not.toContain("Grace Hopper");
    });
  });

  // ---- the request (ADR-028 §4) ----

  describe("the request it sends", () => {
    it("posts to the ownership route with exactly { membershipId }", async () => {
      const fetchMock = stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      await waitFor(() => expect(transferBodies(fetchMock)).toHaveLength(1));
      const body = transferBodies(fetchMock)[0]!;
      expect(Object.keys(body)).toEqual(["membershipId"]);
      expect(body.membershipId).toBe(AGENT_ROW.id);
    });

    it("never sends an organizationId, currentOwnerId, or role", async () => {
      const fetchMock = stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      await waitFor(() => expect(transferBodies(fetchMock)).toHaveLength(1));
      const body = transferBodies(fetchMock)[0]!;
      expect(body).not.toHaveProperty("organizationId");
      expect(body).not.toHaveProperty("currentOwnerId");
      expect(body).not.toHaveProperty("userId");
      expect(body).not.toHaveProperty("role");
    });

    it("never renders the access token", async () => {
      stubOwnership();
      const { container } = renderTeam();

      await screen.findByText("Grace Hopper");
      expect(container.innerHTML).not.toContain(ACCESS_TOKEN);
    });
  });

  // ---- after the transfer (ADR-028 §16) ----

  describe("post-transfer state", () => {
    it("shows a success notice saying what the reader is now", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      expect(await screen.findByText(/ownership transferred/i)).toBeTruthy();
      expect(screen.getByText(/you are now an admin/i)).toBeTruthy();
    });

    /*
      The refetch is what makes the roster show the new owner. It is deliberate
      rather than a local patch: the server sorts by role rank, so a transfer
      reorders the whole list (ADR-027 §14).
    */
    it("refetches the roster, and the new owner appears at the top", async () => {
      stubOwnership({
        listSequence: [
          { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) },
          {
            status: 200,
            body: roster([
              { ...AGENT_ROW, role: "owner" },
              { ...OWNER_ROW, role: "admin" },
            ]),
          },
        ],
      });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      await screen.findByText(/ownership transferred/i);
      const rows = screen.getAllByRole("listitem");
      expect(rows[0]!.textContent).toContain("Grace Hopper");
      expect(rows[1]!.textContent).toContain(CURRENT_USER.name);
    });

    /*
      THE signal that takes the owner-only controls away. This component cannot
      remove itself — its `role` prop comes from the organization context — so
      it asks the dashboard to re-read that context from the server.
    */
    it("signals that the organization context is stale", async () => {
      stubOwnership();
      const { onOrganizationContextStale } = renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      await waitFor(() => expect(onOrganizationContextStale).toHaveBeenCalled());
    });

    /*
      What the reader sees once that context comes back. The block is gone, and
      the management controls an admin still holds are not — because the
      previous owner became an admin and not an agent (ADR-028 §7).
    */
    it("stops rendering the block once the confirmed role is admin", async () => {
      stubOwnership();
      const { rerender } = renderTeam();

      await screen.findByText("Grace Hopper");
      expect(transferSection()).toBeTruthy();

      rerender(
        <AuthProvider initialSession={session}>
          <TeamManagement organizationId={ORGANIZATION_ID} role="admin" currentUserId={CURRENT_USER.id} />
        </AuthProvider>,
      );

      expect(queryTransferSection()).toBeNull();
      expect(screen.getByRole("heading", { name: /add a member/i })).toBeTruthy();
    });

    /* And the new owner, whose context comes back as `owner`, gains it. */
    it("renders the block for a reader whose confirmed role became owner", async () => {
      stubOwnership();
      const { rerender } = renderTeam("agent");

      await screen.findByText("Grace Hopper");
      expect(queryTransferSection()).toBeNull();

      rerender(
        <AuthProvider initialSession={session}>
          <TeamManagement organizationId={ORGANIZATION_ID} role="owner" currentUserId={CURRENT_USER.id} />
        </AuthProvider>,
      );

      expect(transferSection()).toBeTruthy();
    });

    /*
      THE REGRESSION THIS SLICE'S BROWSER VERIFICATION FOUND.

      A successful transfer makes the reader an admin, the refreshed
      organization context unmounts the whole Transfer Ownership block, and a
      notice rendered inside that block vanished in the same tick it was set —
      so the page changed under the reader and said nothing about why. The
      notice therefore lives in `TeamManagement`, which survives.

      This wrapper reproduces the REAL sequence rather than a rerender the test
      chooses: the callback the component fires is what changes the role, so a
      notice that cannot outlive the block fails here.
    */
    it("keeps the success notice after the block removes itself", async () => {
      stubOwnership({
        listSequence: [
          { status: 200, body: roster([OWNER_ROW, AGENT_ROW]) },
          { status: 200, body: roster([{ ...AGENT_ROW, role: "owner" }, { ...OWNER_ROW, role: "admin" }]) },
        ],
      });

      function DashboardLike() {
        // Starts as the owner and becomes an admin exactly when the component
        // says the organization context is stale — which is what the server
        // will report on the refetch.
        const [role, setRole] = useState("owner");
        return (
          <TeamManagement
            organizationId={ORGANIZATION_ID}
            role={role}
            currentUserId={CURRENT_USER.id}
            onOrganizationContextStale={() => setRole("admin")}
          />
        );
      }

      render(
        <AuthProvider initialSession={session}>
          <DashboardLike />
        </AuthProvider>,
      );

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      // The block is gone, because the reader is no longer the owner…
      await waitFor(() => expect(queryTransferSection()).toBeNull());
      // …and the confirmation is still on screen, saying why.
      expect(screen.getByText(/ownership transferred/i)).toBeTruthy();
      expect(screen.getByText(/you are now an admin/i)).toBeTruthy();
      // And the roster behind it shows the new owner.
      expect(screen.getAllByRole("listitem")[0]!.textContent).toContain("Grace Hopper");
    });

    /* A refusal leaves the reader an owner, so its message belongs in the block. */
    it("keeps a refusal inside the block, where the reader still is", async () => {
      stubOwnership({ transfer: { status: 409, body: failure("OWNERSHIP_TRANSFER_TARGET_INVALID") } });
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      const alert = await screen.findByRole("alert");
      expect(transferSection().contains(alert)).toBe(true);
      expect(screen.queryByText(/ownership transferred/i)).toBeNull();
    });

    it("clears the selection after a successful transfer", async () => {
      stubOwnership();
      renderTeam();

      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));

      await screen.findByText(/ownership transferred/i);
      expect((screen.getByLabelText(/new owner/i) as HTMLSelectElement).value).toBe("");
    });
  });

  // ---- refusals, in this client's own words ----

  describe("errors", () => {
    async function attemptTransfer() {
      await screen.findByText("Grace Hopper");
      await userEvent.selectOptions(screen.getByLabelText(/new owner/i), AGENT_ROW.id);
      await userEvent.click(screen.getByRole("button", { name: /^transfer ownership$/i }));
      await userEvent.click(screen.getByRole("button", { name: /yes, transfer ownership/i }));
    }

    it.each([
      ["OWNERSHIP_TRANSFER_SELF_TARGET", 409, /you already own this organization/i],
      ["OWNERSHIP_TRANSFER_TARGET_INVALID", 409, /cannot receive ownership/i],
      ["OWNERSHIP_TRANSFER_CONFLICT", 409, /ownership changed/i],
      ["INSUFFICIENT_PERMISSION", 403, /only the organization owner/i],
      ["NOT_FOUND", 404, /no longer part of this organization/i],
      ["TOO_MANY_REQUESTS", 429, /too many attempts/i],
      ["VALIDATION_ERROR", 400, /choose a member from the list/i],
    ])("renders its own words for %s", async (code, status, expected) => {
      stubOwnership({ transfer: { status, body: failure(code) } });
      renderTeam();

      await attemptTransfer();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(expected);
    });

    it("never renders the server's message text", async () => {
      stubOwnership({
        transfer: { status: 409, body: failure("OWNERSHIP_TRANSFER_CONFLICT", "RAW_SERVER_TEXT_XYZ") },
      });
      const { container } = renderTeam();

      await attemptTransfer();

      await screen.findByRole("alert");
      expect(container.innerHTML).not.toContain("RAW_SERVER_TEXT_XYZ");
    });

    it("falls back to a generic message for an unrecognized code", async () => {
      stubOwnership({ transfer: { status: 500, body: failure("SOMETHING_NEW") } });
      renderTeam();

      await attemptTransfer();

      expect((await screen.findByRole("alert")).textContent).toMatch(/that did not work/i);
    });

    /*
      A refused transfer may still mean the page is stale — a conflict is
      exactly the case where ownership moved under us — so the refusal path
      refreshes too.
    */
    it("refreshes the page even when the transfer is refused", async () => {
      stubOwnership({ transfer: { status: 409, body: failure("OWNERSHIP_TRANSFER_CONFLICT") } });
      const { onOrganizationContextStale } = renderTeam();

      await attemptTransfer();

      await screen.findByRole("alert");
      expect(onOrganizationContextStale).toHaveBeenCalled();
    });

    it("returns to the picker after a refusal, so the reader can choose again", async () => {
      stubOwnership({ transfer: { status: 409, body: failure("OWNERSHIP_TRANSFER_TARGET_INVALID") } });
      renderTeam();

      await attemptTransfer();

      await screen.findByRole("alert");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByLabelText(/new owner/i)).toBeTruthy();
    });

    /*
      A 401 is a sign-out already in progress; `ProtectedRoute` redirects, so
      there is nothing to show and nothing to say.
    */
    it("says nothing for a 401", async () => {
      stubOwnership({ transfer: { status: 401, body: failure("INVALID_ACCESS_TOKEN") } });
      renderTeam();

      await attemptTransfer();

      await waitFor(() => expect(screen.queryByRole("button", { name: /yes, transfer/i })).toBeNull());
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
