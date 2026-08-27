import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { transferOwnership } from "./ownershipApi";

/**
 * The Transfer Ownership block's state and effects, kept out of the component
 * (CONTRIBUTING.md: "No business logic in JSX").
 *
 * A separate hook from `useTeamMembers` rather than three more fields on it,
 * matching the server's own split: the roster is one resource behind
 * `member.manage`, ownership is another behind
 * `organization.transfer_ownership` (ADR-028 §1). The roster refetch and the
 * organization-context refresh are the CALLER's to run, because both belong to
 * state this hook does not own.
 */

/** What the transfer is doing right now. `confirming` is a UI phase, not a request. */
export type OwnershipTransferStatus = "idle" | "confirming" | "pending" | "done";

export interface UseOwnershipTransferOptions {
  organizationId: string;
  /**
   * Run after a transfer settles, successfully or not.
   *
   * The caller uses it to refetch the roster AND the organization context —
   * the second is what takes the previous owner's owner-only controls away,
   * because `OrganizationSwitcher` re-reads the server-confirmed role from
   * `GET /organizations/:id` (ADR-028 §16). Awaited, so nothing is announced
   * over a page still showing the old owner.
   *
   * `notice` is the success text, and it is handed UP rather than rendered
   * here for a reason this hook cannot solve on its own: a successful transfer
   * makes the reader an admin, the refreshed context unmounts the whole
   * Transfer Ownership block, and a notice rendered inside it would vanish in
   * the same tick it was set. The caller renders it somewhere that outlives
   * the block. `null` on a refused transfer, which stays inside this hook.
   */
  onTransferred: (notice: string | null) => Promise<void> | void;
}

export interface OwnershipTransfer {
  status: OwnershipTransferStatus;
  /** The membership id currently selected in the picker, or `""`. */
  selectedId: string;
  select: (membershipId: string) => void;
  /** Moves to the confirmation step. Ignored with nothing selected. */
  askToConfirm: () => void;
  /** Abandons the confirmation without sending anything. */
  cancel: () => void;
  /** Sends the transfer. Resolves `true` when ownership actually moved. */
  confirm: () => Promise<boolean>;
  error: string | null;
}

/**
 * What the reader is told after a successful transfer.
 *
 * Names what THEY are now rather than only what happened, because the change
 * to their own standing is the half people do not expect (ADR-028 §7).
 */
const SUCCESS_NOTICE = "Ownership transferred. You are now an admin in this organization.";

/**
 * The failures, in this client's own words.
 *
 * The server's message text is never rendered, matching how `useTeamMembers`
 * and `useAgentInbox` treat every other failure. Each message here names
 * something the reader can act on, because every refusal on this route is one
 * an owner can resolve — pick someone else, or reload and look again.
 */
const GENERIC_ERROR = "That did not work. Please try again.";
const SELF_TARGET_ERROR = "You already own this organization. Choose a different member.";
const TARGET_INVALID_ERROR =
  "That member cannot receive ownership. They need an active membership and an active, verified Serviqo account.";
const CONFLICT_ERROR = "Ownership changed while this was in flight. The team has been reloaded — check and try again.";
const FORBIDDEN_ERROR = "Only the organization owner can transfer ownership.";
const GONE_ERROR = "That member is no longer part of this organization.";
const RATE_LIMITED_ERROR = "Too many attempts. Please wait a few minutes and try again.";
const VALIDATION_ERROR = "Choose a member from the list, then try again.";

function messageFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return GENERIC_ERROR;

  switch (caught.code) {
    case "OWNERSHIP_TRANSFER_SELF_TARGET":
      return SELF_TARGET_ERROR;
    case "OWNERSHIP_TRANSFER_TARGET_INVALID":
      return TARGET_INVALID_ERROR;
    case "OWNERSHIP_TRANSFER_CONFLICT":
      return CONFLICT_ERROR;
    case "INSUFFICIENT_PERMISSION":
      /*
        Reachable without a bug: ownership may have moved in another tab or by
        another manager since this page loaded its role, in which case the
        server is right and this page is stale.
      */
      return FORBIDDEN_ERROR;
    case "TOO_MANY_REQUESTS":
      return RATE_LIMITED_ERROR;
    case "VALIDATION_ERROR":
      return VALIDATION_ERROR;
    case "NOT_FOUND":
      /*
        One code covering "no such membership", "another tenant's membership",
        and "the organization is no longer reachable" — the server refuses all
        three identically on purpose (ADR-028 §5), so this client says the one
        thing true of all of them rather than guessing which it was.
      */
      return GONE_ERROR;
    default:
      return GENERIC_ERROR;
  }
}

export function useOwnershipTransfer({
  organizationId,
  onTransferred,
}: UseOwnershipTransferOptions): OwnershipTransfer {
  const { authorizedFetch } = useAuth();

  const [status, setStatus] = useState<OwnershipTransferStatus>("idle");
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);

  /**
   * Guards against a response from a request this component no longer cares
   * about landing in state after unmount — the same shape `useTeamMembers`
   * uses, and it matters more here: the refresh this hook triggers can itself
   * change the role that unmounts the block.
   */
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const select = useCallback((membershipId: string) => {
    setSelectedId(membershipId);
    /*
      Changing the choice abandons any open confirmation. A confirmation dialog
      that stayed open while the selection moved underneath it would be a
      dialog naming one person and sending another — exactly the ambiguity a
      destructive action must not have.
    */
    setStatus("idle");
    setError(null);
  }, []);

  const askToConfirm = useCallback(() => {
    setSelectedId((current) => {
      if (current !== "") setStatus("confirming");
      return current;
    });
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    setStatus("idle");
  }, []);

  const confirm = useCallback(async (): Promise<boolean> => {
    if (selectedId === "") return false;

    setStatus("pending");
    setError(null);

    try {
      await transferOwnership(authorizedFetch, organizationId, selectedId);

      /*
        Refresh and announce in ONE call. The roster and the organization
        context are what the reader looks at next, and a success notice
        rendered over a page still showing the old owner reads as a lie — so
        the caller receives the text together with the instruction to refresh
        and renders it after both have settled.
      */
      await onTransferred(SUCCESS_NOTICE);

      if (!isMounted.current) return true;
      setStatus("done");
      setSelectedId("");
      return true;
    } catch (caught: unknown) {
      if (!isMounted.current) return false;

      /*
        A 401 that survived `authorizedFetch`'s one refresh and one replay is a
        sign-out already in progress; `ProtectedRoute` redirects, so there is
        nothing to show and nothing to say.
      */
      if (caught instanceof AuthApiError && caught.status === 401) return false;

      setStatus("idle");
      setError(messageFor(caught));

      /*
        A refused transfer may still mean the page is stale — a 409 conflict is
        exactly the case where ownership moved under us, and a 403 means it
        already has. Refreshing keeps the page honest about what the failure
        means, and it is what removes this block when the reader is no longer
        the owner.
      */
      await onTransferred(null);
      return false;
    }
  }, [authorizedFetch, onTransferred, organizationId, selectedId]);

  return { status, selectedId, select, askToConfirm, cancel, confirm, error };
}
