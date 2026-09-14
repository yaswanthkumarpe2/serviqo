import { useCallback, useEffect, useRef, useState } from "react";

import { AuthApiError } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { addMember, changeMemberRole, changeMemberStatus, fetchMembers, removeMember } from "./membersApi";

import type { AssignableRole, OrganizationMember, SettableStatus } from "./membersApi";

/**
 * All of the Team Management section's state and effects, kept out of the
 * component (CONTRIBUTING.md: "No business logic in JSX").
 *
 * The whole hook is scoped to ONE organization, and the component that uses it
 * is mounted with a `key` of that organization's id (ADR-027 §16) — so
 * switching tenants discards this state entirely rather than reconciling one
 * tenant's roster into a hook that just finished holding another's. That is
 * what makes the isolation structural instead of a filter someone has to
 * remember.
 */

/** The roster's load state. `forbidden` is separate because it is not retryable. */
export type TeamStatus = "loading" | "ready" | "error" | "forbidden";

/** Which mutation is in flight, or `null`. One value, because they are mutually exclusive per row. */
export type TeamActionKind = "add" | "role" | "status" | "remove";

export interface UseTeamMembersOptions {
  organizationId: string;
}

export interface TeamMembers {
  status: TeamStatus;
  error: string | null;
  members: OrganizationMember[];

  /** Refetches the roster. Used by the retry control and after every mutation. */
  reload: () => Promise<void>;

  /** Which mutation is in flight, and on which membership (`null` for the add form). */
  pendingAction: { kind: TeamActionKind; membershipId: string | null } | null;
  /** The last mutation failure, in this client's own words. */
  actionError: string | null;
  /** A short confirmation of the last successful mutation, or `null`. */
  actionNotice: string | null;

  /** `name` invites someone who has no account yet (ADR-039 §4). */
  add: (email: string, role: AssignableRole, name?: string) => Promise<boolean>;
  changeRole: (membershipId: string, role: AssignableRole) => Promise<boolean>;
  /** Suspends or reactivates one member (ADR-029 §1). */
  changeStatus: (membershipId: string, status: SettableStatus) => Promise<boolean>;
  remove: (membershipId: string) => Promise<boolean>;
}

const GENERIC_LIST_ERROR = "Could not load the team. Please try again.";

/**
 * The mutation failures, in this client's own words.
 *
 * The server's text is never shown, matching how `useAgentInbox` treats its
 * own failures. The three that name a cause are the three a manager can act
 * on: the person is already here, the address has no account, or the target is
 * protected. Every other refusal is generic, because "try again" is the only
 * true thing to say about it.
 */
const GENERIC_ACTION_ERROR = "That did not work. Please try again.";
const ALREADY_MEMBER_ERROR = "That person is already a member of this organization.";
const NOT_INVITABLE_ERROR =
  "That email cannot be added. The person needs a verified Serviqo account — to invite someone new, enter their name as well.";
const OWNER_PROTECTED_ERROR = "The organization owner cannot be changed or removed.";
const SELF_MODIFICATION_ERROR = "You cannot change or remove your own membership.";
/*
  Names both legal transitions, because the reader's page may simply be stale —
  a colleague may have suspended or reactivated the same person since it loaded
  (ADR-029 §6).
*/
const STATUS_TRANSITION_ERROR =
  "That member's status has already changed. Only an active member can be suspended, and only a suspended one can be reactivated.";
const FORBIDDEN_ERROR = "Your role cannot manage this organization's members.";
const GONE_ERROR = "That member is no longer part of this organization.";
const RATE_LIMITED_ERROR = "Too many attempts. Please wait a few minutes and try again.";
const VALIDATION_ERROR = "Check the email address and role, then try again.";

/** Maps a mutation failure to what the manager is told. */
function actionMessageFor(caught: unknown): string {
  if (!(caught instanceof AuthApiError)) return GENERIC_ACTION_ERROR;

  switch (caught.code) {
    case "MEMBER_ALREADY_EXISTS":
      return ALREADY_MEMBER_ERROR;
    case "MEMBER_NOT_INVITABLE":
      return NOT_INVITABLE_ERROR;
    case "ORGANIZATION_OWNER_PROTECTED":
      return OWNER_PROTECTED_ERROR;
    case "MEMBER_SELF_MODIFICATION":
      return SELF_MODIFICATION_ERROR;
    case "MEMBER_STATUS_TRANSITION_INVALID":
      return STATUS_TRANSITION_ERROR;
    case "INSUFFICIENT_PERMISSION":
      return FORBIDDEN_ERROR;
    case "TOO_MANY_REQUESTS":
      return RATE_LIMITED_ERROR;
    case "VALIDATION_ERROR":
      return VALIDATION_ERROR;
    case "NOT_FOUND":
      /*
        One code covering "no such membership", "another tenant's membership",
        and "the organization is no longer reachable" — the server refuses all
        three identically on purpose (ADR-027 §9), so this client says the one
        thing true of all of them rather than guessing which it was.
      */
      return GONE_ERROR;
    default:
      return GENERIC_ACTION_ERROR;
  }
}

export function useTeamMembers({ organizationId }: UseTeamMembersOptions): TeamMembers {
  const { authorizedFetch } = useAuth();

  const [status, setStatus] = useState<TeamStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);

  const [pendingAction, setPendingAction] = useState<TeamMembers["pendingAction"]>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  /**
   * Guards against a response from a request this component no longer cares
   * about landing in state after unmount. A ref rather than state: it is
   * bookkeeping, not something the UI renders.
   */
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const roster = await fetchMembers(authorizedFetch, organizationId);
      if (!isMounted.current) return;
      setMembers(roster);
      setStatus("ready");
      setError(null);
    } catch (caught: unknown) {
      if (!isMounted.current) return;

      /*
        A 401 that survived `authorizedFetch`'s one refresh and one replay is a
        sign-out already in progress; `ProtectedRoute` redirects, so there is
        nothing to show and nothing to say.
      */
      if (caught instanceof AuthApiError && caught.status === 401) return;

      /*
        403 is its own state, not an error, because it will never succeed on a
        retry — offering "Please try again" to a supervisor who will never hold
        `member.manage` is a UI lying about what is wrong (ADR-027 §16).
      */
      if (caught instanceof AuthApiError && caught.status === 403) {
        setStatus("forbidden");
        setError(null);
        return;
      }

      setStatus("error");
      setError(GENERIC_LIST_ERROR);
    }
  }, [authorizedFetch, organizationId]);

  /**
   * Guards the one load per organization.
   *
   * StrictMode mounts, unmounts, and remounts in development, and `reload`'s
   * identity changes whenever the provider's `authorizedFetch` does — which a
   * token refresh inside this very call would cause. Without this, a
   * successful refresh would re-run the effect that triggered it.
   *
   * The same shape `useAgentInbox` uses for its own initial load, and it keeps
   * the effect body free of a synchronous state transition: every `setState`
   * below happens after an `await`, in response to a settled request.
   */
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (loadedFor.current === organizationId) return;
    loadedFor.current = organizationId;

    void reload();
  }, [reload, organizationId]);

  /**
   * Runs one mutation, then REFETCHES the roster (ADR-027 §15).
   *
   * The refetch is deliberate rather than lazy. A mutation response describes
   * one row, and a role change can reorder the whole list — the server sorts
   * by role rank — so patching the row locally would leave the page in an
   * order the server does not agree with. There is also no roster event to
   * keep the page live (§15 declines one), so a fetch is what makes a second
   * manager's concurrent change visible.
   */
  const run = useCallback(
    async (
      kind: TeamActionKind,
      membershipId: string | null,
      operation: () => Promise<string>,
    ): Promise<boolean> => {
      setPendingAction({ kind, membershipId });
      setActionError(null);
      setActionNotice(null);

      try {
        const notice = await operation();
        await reload();
        if (!isMounted.current) return true;
        setActionNotice(notice);
        return true;
      } catch (caught: unknown) {
        if (!isMounted.current) return false;
        if (caught instanceof AuthApiError && caught.status === 401) return false;

        setActionError(actionMessageFor(caught));

        /*
          A refused mutation may still mean the roster moved under us — a 409
          for "already a member" is exactly the case where someone else just
          added them. Refetching keeps the page honest about what the failure
          means.
        */
        await reload();
        return false;
      } finally {
        if (isMounted.current) setPendingAction(null);
      }
    },
    [reload],
  );

  const add = useCallback(
    (email: string, role: AssignableRole, name?: string) =>
      run("add", null, async () => {
        const member = await addMember(authorizedFetch, organizationId, email, role, name);
        /*
          The NAME the server resolved, not the email the manager typed. The
          server proved which account that address belongs to; echoing the
          submitted string back would confirm nothing.
        */
        return `${member.user?.name ?? "That person"} was added as ${role}.`;
      }),
    [authorizedFetch, organizationId, run],
  );

  const changeRole = useCallback(
    (membershipId: string, role: AssignableRole) =>
      run("role", membershipId, async () => {
        const member = await changeMemberRole(authorizedFetch, organizationId, membershipId, role);
        return `${member.user?.name ?? "That member"} is now ${member.role}.`;
      }),
    [authorizedFetch, organizationId, run],
  );

  const changeStatus = useCallback(
    (membershipId: string, status: SettableStatus) =>
      run("status", membershipId, async () => {
        const { member, releasedConversations } = await changeMemberStatus(
          authorizedFetch,
          organizationId,
          membershipId,
          status,
        );
        const who = member.user?.name ?? "That member";

        if (status === "active") return `${who} was reactivated and can sign in again.`;

        /*
          The release count is stated for the reason removal states it
          (ADR-029 §10): conversations that person was handling are now
          unassigned and back in the queue, and a manager who did not expect
          that should find out here rather than from the inbox.
        */
        return releasedConversations === 0
          ? `${who} was suspended and can no longer sign in to this organization.`
          : `${who} was suspended. ${releasedConversations} conversation${
              releasedConversations === 1 ? "" : "s"
            } returned to the unassigned queue.`;
      }),
    [authorizedFetch, organizationId, run],
  );

  const remove = useCallback(
    (membershipId: string) =>
      run("remove", membershipId, async () => {
        const { member, releasedConversations } = await removeMember(authorizedFetch, organizationId, membershipId);
        const who = member.user?.name ?? "That member";

        /*
          The release count is stated because it is the invisible consequence
          of the action (ADR-027 §10): conversations that person was handling
          are now unassigned and back in the queue, and a manager who did not
          expect that should find out here rather than from the inbox.
        */
        return releasedConversations === 0
          ? `${who} was removed.`
          : `${who} was removed. ${releasedConversations} conversation${
              releasedConversations === 1 ? "" : "s"
            } returned to the unassigned queue.`;
      }),
    [authorizedFetch, organizationId, run],
  );

  return {
    status,
    error,
    members,
    reload,
    pendingAction,
    actionError,
    actionNotice,
    add,
    changeRole,
    changeStatus,
    remove,
  };
}
