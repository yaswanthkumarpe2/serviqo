import { Button } from "@/components/ui/Button";
import { eligibleForOwnership } from "./ownershipApi";
import { useOwnershipTransfer } from "./useOwnershipTransfer";

import type { OrganizationMember } from "./membersApi";

/**
 * Transfer Ownership (ADR-028 §16) — the dashboard's only owner-only control.
 *
 * Rendered by `TeamManagement` and only when `canTransferOwnership(role)` is
 * true of the SERVER-CONFIRMED role, which `OrganizationSwitcher` took from
 * `GET /organizations/:id`. That gate is a UX AFFORDANCE AND NEVER A BOUNDARY:
 * the server proves `organization.transfer_ownership` on every request from the
 * `Membership` document it reads on that request, so this block un-hidden in a
 * debugger still receives a 403. Hiding it only avoids offering the reader a
 * refusal.
 *
 * Nothing about the reader's standing is stored, remembered across a reload, or
 * inferred client-side, matching `OrganizationSwitcher`'s own rule: "a UI that
 * remembered 'I am an owner' is a UI that can be edited into one."
 */

interface TransferOwnershipProps {
  organizationId: string;
  /** The roster the Team section already fetched — no second request (ADR-028 §16). */
  members: OrganizationMember[];
  /**
   * Refetches the roster AND the organization context, and renders `notice`
   * somewhere that OUTLIVES this block.
   *
   * The context refetch is what makes this block disappear for the person who
   * just gave ownership away — which is also why the success notice cannot be
   * rendered here: it would unmount in the same tick it was set, leaving the
   * reader with a page that silently changed under them (ADR-028 §16).
   *
   * `notice` is `null` when the transfer was refused; the refusal is shown
   * here, because a refusal leaves the reader an owner and this block on
   * screen.
   */
  onTransferred: (notice: string | null) => Promise<void> | void;
}

export function TransferOwnership({ organizationId, members, onTransferred }: TransferOwnershipProps) {
  const transfer = useOwnershipTransfer({ organizationId, onTransferred });

  /*
    Filtered from the roster already on screen, so the picker costs no extra
    request and discloses nothing `member.read` did not already return. The
    current owner is not in this list — which is how "you cannot select
    yourself" is enforced here, by absence rather than by a disabled row the
    reader has to be told about.
  */
  const eligible = eligibleForOwnership(members);

  const selected = eligible.find((member) => member.id === transfer.selectedId) ?? null;
  const isPending = transfer.status === "pending";

  return (
    <section className="team__transfer" aria-labelledby="team-transfer-heading">
      <h3 className="team__addHeading" id="team-transfer-heading">
        Transfer ownership
      </h3>

      {/*
        Says what the action DOES, in words, before it is taken — rather than
        calling itself "irreversible" and leaving the reader to work out what
        changes. The second sentence is the half people are surprised by, so it
        is stated first-person and plainly (ADR-028 §7, §16).
      */}
      <p className="team__hint team__hint--tight">
        The member you choose becomes the owner of this organization, with full control including the
        ability to transfer it again. <strong>You become an admin</strong> — you keep every other
        permission you have now, but you will no longer be able to transfer ownership. Only the new
        owner can give it back.
      </p>

      {eligible.length === 0 ? (
        <p className="team__state">
          There is nobody to transfer ownership to yet. Add an active member first.
        </p>
      ) : transfer.status === "confirming" && selected !== null ? (
        /*
          The confirmation NAMES the person, following the removal control's
          pattern (ADR-027 §16): "are you sure?" about nothing in particular is
          a dialog people dismiss without reading.
        */
        <div className="team__confirm team__confirm--block" role="alertdialog" aria-label="Confirm ownership transfer">
          <p className="team__confirmText">
            Make <strong>{selected.user?.name ?? "this member"}</strong> the owner of this
            organization? You will become an admin.
          </p>
          <div className="team__confirmActions">
            <Button size="sm" disabled={isPending} onClick={() => void transfer.confirm()}>
              Yes, transfer ownership
            </Button>
            <button type="button" className="team__cancel" disabled={isPending} onClick={transfer.cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="team__addRow">
          <label className="team__srOnly" htmlFor="team-transfer-target">
            New owner
          </label>
          <select
            className="team__roleSelect team__transferSelect"
            id="team-transfer-target"
            value={transfer.selectedId}
            disabled={isPending}
            onChange={(event) => transfer.select(event.target.value)}
          >
            <option value="">Choose a member…</option>
            {eligible.map((member) => (
              <option key={member.id} value={member.id}>
                {/*
                  Name and role only. The roster row beside this one already
                  shows the address to the same reader, and repeating it in an
                  option label puts it somewhere no layout controls.
                */}
                {member.user?.name ?? "Unknown account"} ({member.role})
              </option>
            ))}
          </select>

          <Button
            variant="secondary"
            size="sm"
            disabled={isPending || transfer.selectedId === ""}
            onClick={transfer.askToConfirm}
          >
            {isPending ? "Transferring…" : "Transfer ownership"}
          </Button>
        </div>
      )}

      {isPending && (
        <p className="team__pending" role="status">
          Transferring ownership…
        </p>
      )}

      {transfer.error !== null && (
        <p className="team__error" role="alert">
          {transfer.error}
        </p>
      )}
    </section>
  );
}
