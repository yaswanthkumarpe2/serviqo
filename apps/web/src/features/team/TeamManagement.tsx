import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { canManageMembers } from "./memberPermissions";
import { useTeamMembers } from "./useTeamMembers";

import type { AssignableRole, OrganizationMember } from "./membersApi";
import type { FormEvent } from "react";

import "./TeamManagement.css";

/**
 * Team Management (ADR-027 §16) — the dashboard's view of `member.read` and
 * `member.manage`.
 *
 * Mount this with `key={organizationId}` from the caller so switching the
 * active organization remounts it fresh rather than reconciling one tenant's
 * roster into a component that just finished rendering another's. Filtering by
 * `organizationId` in an effect would be the "rely only on frontend filtering"
 * CONTRIBUTING.md forbids.
 *
 * The management controls are gated on `canManageMembers(role)` — a UX
 * affordance and NOT a boundary. The server re-proves the permission on every
 * request from the `Membership` document it reads on that request, so a
 * control un-hidden in a debugger still receives a 403; hiding it only avoids
 * offering the reader a refusal.
 *
 * The `role` passed in is the SERVER-CONFIRMED one, which
 * `OrganizationSwitcher` took from `GET /organizations/:id`. Nothing about the
 * caller's standing is read from storage or remembered across a reload.
 */

interface TeamManagementProps {
  organizationId: string;
  /** The server-confirmed role in this organization, or `null` while unconfirmed. */
  role: string | null;
  /** The signed-in user's own id, so their own row can be marked and its controls withheld. */
  currentUserId: string | null;
}

/** The roles a control may offer. `owner` is absent because no request may set it (ADR-027 §6). */
const ASSIGNABLE_ROLES: AssignableRole[] = ["admin", "supervisor", "agent"];

/** What each status means to a manager, since a non-active member cannot get in at all. */
const STATUS_HINT: Record<string, string> = {
  invited: "Has not accepted yet — cannot sign in to this organization",
  suspended: "Access revoked — cannot sign in to this organization",
};

export function TeamManagement({ organizationId, role, currentUserId }: TeamManagementProps) {
  const team = useTeamMembers({ organizationId });
  const mayManage = canManageMembers(role);

  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<AssignableRole>("agent");

  /**
   * Which membership the manager is being asked to confirm removing, or
   * `null`. One value rather than a boolean per row: two confirmations open at
   * once is a state the UI would have to decide the meaning of, and removal is
   * exactly the action that must not be ambiguous (ADR-027 §16).
   */
  const [confirmingRemovalOf, setConfirmingRemovalOf] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) return;

    // The field is cleared only on success, so a refused address stays on
    // screen for the manager to correct rather than having to be retyped.
    if (await team.add(trimmed, newRole)) setEmail("");
  }

  async function handleRemove(membershipId: string) {
    setConfirmingRemovalOf(null);
    await team.remove(membershipId);
  }

  /** Whether any mutation is in flight — every control is disabled while one is. */
  const isBusy = team.pendingAction !== null;

  function isPending(kind: "add" | "role" | "remove", membershipId: string | null): boolean {
    return team.pendingAction?.kind === kind && team.pendingAction.membershipId === membershipId;
  }

  /**
   * Whether this row's controls may be shown at all.
   *
   * Mirrors the two structural refusals the server makes (ADR-027 §7), so a
   * manager is not offered a button whose only outcome is a 409: the owner
   * cannot be changed or removed by anyone, and nobody can act on their own
   * membership. The server enforces both regardless — this only keeps the page
   * honest about what it offers.
   */
  function isActionable(member: OrganizationMember): boolean {
    if (member.role === "owner") return false;
    return member.user?.id !== currentUserId;
  }

  function renderRow(member: OrganizationMember) {
    const isSelf = member.user?.id === currentUserId;
    const actionable = mayManage && isActionable(member);

    return (
      <li className="team__row" key={member.id}>
        <div className="team__who">
          <span className="team__name">
            {/*
              A membership whose account no longer resolves renders as an
              unresolved row rather than being dropped: it is still real and
              still removable, and hiding it would hide the thing a manager
              needs to clean up.
            */}
            {member.user?.name ?? "Unknown account"}
            {isSelf && <span className="team__you"> (you)</span>}
          </span>
          <span className="team__email">{member.user?.email ?? "—"}</span>
          {member.status !== "active" && (
            <span className="team__statusHint">{STATUS_HINT[member.status] ?? member.status}</span>
          )}
        </div>

        <div className="team__controls">
          {actionable ? (
            <>
              <label className="team__srOnly" htmlFor={`role-${member.id}`}>
                Role for {member.user?.name ?? "this member"}
              </label>
              <select
                className="team__roleSelect"
                id={`role-${member.id}`}
                value={member.role}
                disabled={isBusy}
                onChange={(event) => void team.changeRole(member.id, event.target.value as AssignableRole)}
              >
                {ASSIGNABLE_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>

              {isPending("role", member.id) && (
                <span className="team__pending" role="status">
                  Saving…
                </span>
              )}

              {confirmingRemovalOf === member.id ? (
                /*
                  Removal is irreversible from this surface — re-adding needs
                  the address again, and it silently unassigns that person's
                  conversations — so it confirms, and the confirmation NAMES
                  the person rather than asking "are you sure?" about nothing
                  in particular (ADR-027 §16).
                */
                <span className="team__confirm" role="alertdialog" aria-label="Confirm removal">
                  <span className="team__confirmText">
                    Remove {member.user?.name ?? "this member"} from this organization?
                  </span>
                  <Button
                    size="sm"
                    disabled={isBusy}
                    onClick={() => void handleRemove(member.id)}
                  >
                    Yes, remove
                  </Button>
                  <button
                    type="button"
                    className="team__cancel"
                    disabled={isBusy}
                    onClick={() => setConfirmingRemovalOf(null)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => setConfirmingRemovalOf(member.id)}
                >
                  {isPending("remove", member.id) ? "Removing…" : "Remove"}
                </Button>
              )}
            </>
          ) : (
            // Read-only: the role is still shown, because knowing who does
            // what is what `member.read` is for.
            <span className="badge badge--neutral team__roleBadge">{member.role}</span>
          )}
        </div>
      </li>
    );
  }

  return (
    <section className="team card pad" aria-labelledby="team-heading">
      <h2 className="h3" id="team-heading">
        Team
      </h2>
      <p className="team__hint">Who works in this organization, and what they can do.</p>

      <div className="team__body" aria-busy={team.status === "loading"}>
        {team.status === "loading" && (
          <p className="team__state" role="status">
            Loading the team…
          </p>
        )}

        {/*
          Its own state rather than an error, because it will never succeed on
          a retry — a role without `member.read` will not gain it by trying
          again (ADR-027 §16).
        */}
        {team.status === "forbidden" && (
          <p className="team__state team__state--forbidden">
            Your role cannot see this organization&rsquo;s team.
          </p>
        )}

        {team.status === "error" && (
          <div className="team__state team__state--error" role="alert">
            <span>{team.error}</span>
            <Button variant="secondary" size="sm" onClick={() => void team.reload()}>
              Try again
            </Button>
          </div>
        )}

        {team.status === "ready" && (
          <>
            {team.members.length === 0 ? (
              <p className="team__state">Nobody is in this organization yet.</p>
            ) : (
              <ul className="team__list">{team.members.map(renderRow)}</ul>
            )}

            {team.actionNotice !== null && (
              <p className="team__notice" role="status">
                {team.actionNotice}
              </p>
            )}

            {team.actionError !== null && (
              <p className="team__error" role="alert">
                {team.actionError}
              </p>
            )}

            {mayManage && (
              <form className="team__add" onSubmit={(event) => void handleAdd(event)}>
                <h3 className="team__addHeading">Add a member</h3>
                <p className="team__hint team__hint--tight">
                  They need a verified Serviqo account already. Adding them gives them access to this
                  organization immediately.
                </p>

                <div className="team__addRow">
                  <label className="team__srOnly" htmlFor="team-add-email">
                    Email address
                  </label>
                  <input
                    className="team__input"
                    id="team-add-email"
                    type="email"
                    autoComplete="off"
                    placeholder="colleague@example.com"
                    value={email}
                    disabled={isBusy}
                    onChange={(event) => setEmail(event.target.value)}
                  />

                  <label className="team__srOnly" htmlFor="team-add-role">
                    Role
                  </label>
                  <select
                    className="team__roleSelect"
                    id="team-add-role"
                    value={newRole}
                    disabled={isBusy}
                    onChange={(event) => setNewRole(event.target.value as AssignableRole)}
                  >
                    {ASSIGNABLE_ROLES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>

                  <Button type="submit" size="sm" disabled={isBusy || email.trim().length === 0}>
                    {isPending("add", null) ? "Adding…" : "Add member"}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}
