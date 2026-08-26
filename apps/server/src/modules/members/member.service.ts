import {
  MemberAlreadyExistsError,
  MemberNotFoundError,
  MemberNotInvitableError,
  MemberSelfModificationError,
  MemberStatusTransitionError,
  OrganizationOwnerProtectedError,
} from "../../lib/errors";
import { logger } from "../../lib/logger";
import { failureType } from "../auth/authLogging";
import { conversationRepository } from "../conversations/conversation.repository";
import { conversationEvents, toConversationUpdatedEvent } from "../conversations/conversationEvents";
import { membershipRepository } from "../memberships/membership.repository";
import { membershipEvents } from "../memberships/membershipEvents";
import { can } from "../memberships/permissions";
import { normalizeEmail } from "../users/user.model";
import { userRepository } from "../users/user.repository";
import { sortMembers, toMemberResponse } from "./member.responses";

import type { AuthLogger } from "../auth/authLogging";
import type { MembershipDocument, MembershipRole, MembershipStatus } from "../memberships/membership.model";
import type { MemberResponse } from "./member.responses";
import type { AddMemberInput } from "./member.validation";

/**
 * Team management (ADR-027) — the slice that gives `member.read` and
 * `member.manage` something to guard.
 *
 * Every method takes `organizationId` from the CALLER, which took it from
 * `req.organizationContext`, which `requireOrganization` built from the path
 * after proving an active membership in an active organization (ADR-017 §2).
 * No method here re-checks the caller's own standing, and that is deliberate:
 * a second copy of that gate is a second thing that can disagree with the
 * first.
 *
 * `AuthLogger` and `failureType` are imported from the auth module rather than
 * duplicated, following the precedent `organizationOnboarding.service.ts`,
 * `widgetSession.service.ts`, and `conversation.service.ts` each recorded —
 * per ADR-016 §9 the pair moves to `lib/` in a slice with a reason to make
 * that move, and this is not one.
 */

/** MongoDB's duplicate-key error code — index A rejecting a second membership for one person. */
const DUPLICATE_KEY_ERROR = 11000;

/** One message for every unreachable membership (ADR-027 §9). */
const MEMBER_NOT_FOUND_MESSAGE = "Member not found";

/**
 * ONE message for "no such account", "not active", and "not verified"
 * (ADR-027 §5). Stated as a policy rather than as an answer about the
 * submitted address.
 */
const MEMBER_NOT_INVITABLE_MESSAGE =
  "That email cannot be added. The person needs a verified Serviqo account before they can join an organization.";

const MEMBER_ALREADY_EXISTS_MESSAGE = "That person is already a member of this organization";

/** Says what to do next, because "conflict" does not, and the resolution is a real one. */
const OWNER_PROTECTED_MESSAGE =
  "The organization owner cannot be changed or removed. Transfer ownership first.";

const SELF_MODIFICATION_MESSAGE = "You cannot change or remove your own membership";

/**
 * Names both legal transitions, because "conflict" alone leaves a manager
 * unable to tell a stale page from a mistake (ADR-029 §6).
 */
const STATUS_TRANSITION_MESSAGE =
  "That member's status cannot change that way. Only an active member can be suspended, and only a suspended member can be reactivated.";

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR;
}

/**
 * Why a member operation was refused. Reaches the log and NEVER a response
 * body (ADR-027 §13) — the same split ADR-015 §6 and ADR-017 §6 established
 * for authentication and tenancy refusals, applied a third time.
 */
type RefusalReason =
  | "unknown_or_unverified_user"
  | "already_a_member"
  | "owner_protected"
  | "self_modification"
  | "invalid_transition"
  | "membership_not_found";

/** Who is acting. Both fields come from the server, never from request input (ADR-027 §4). */
export interface MemberActor {
  /** `req.principal.userId` — the verified subject of the access token. */
  userId: string;
}

export interface MemberService {
  /**
   * The organization's roster (ADR-027 §14).
   *
   * Behind `member.read`, which the caller's route proved. Takes no filter and
   * no pagination: a tenant's staff list is bounded by how many people a
   * company employs, and a cursor over a list that fits on one screen is
   * machinery with no reader.
   */
  listMembers(organizationId: string, actor: MemberActor, log?: AuthLogger): Promise<MemberResponse[]>;

  /**
   * Adds an existing verified Serviqo account to the organization
   * (ADR-027 §3, §5, §8).
   *
   * Writes `status: "active"` and `invitedByUserId: actor.userId` as literals.
   * Raises `MemberNotInvitableError` for an account that does not exist or may
   * not be served, and `MemberAlreadyExistsError` for a person who already has
   * a membership here in any status.
   */
  addMember(
    organizationId: string,
    input: AddMemberInput,
    actor: MemberActor,
    log?: AuthLogger,
  ): Promise<MemberResponse>;

  /**
   * Changes one member's role (ADR-027 §7, §10, §11).
   *
   * Refuses the owner membership and the caller's own. Releases the target's
   * conversation assignments when the new role would not hold
   * `conversation.assign`.
   */
  changeRole(
    organizationId: string,
    membershipId: string,
    role: MembershipRole,
    actor: MemberActor,
    log?: AuthLogger,
  ): Promise<MemberResponse>;

  /**
   * Suspends or reactivates one membership (ADR-029 §6, §8, §10).
   *
   * Refuses the owner membership, the caller's own, and every transition that
   * is not `active → suspended` or `suspended → active` — including both
   * no-ops and anything involving `invited`.
   *
   * Suspension releases the member's conversations and closes their live agent
   * sockets. Reactivation restores access and deliberately nothing else.
   */
  changeStatus(
    organizationId: string,
    membershipId: string,
    status: MembershipStatus,
    actor: MemberActor,
    log?: AuthLogger,
  ): Promise<{ member: MemberResponse; releasedConversations: number }>;

  /**
   * Removes a member from the organization and releases their conversations
   * (ADR-027 §7, §10).
   *
   * Refuses the owner membership and the caller's own. The membership is
   * deleted FIRST — access revocation is the security-relevant half and must
   * not wait on bookkeeping.
   */
  removeMember(
    organizationId: string,
    membershipId: string,
    actor: MemberActor,
    log?: AuthLogger,
  ): Promise<{ removed: MemberResponse; releasedConversations: number }>;
}

export function createMemberService(): MemberService {
  /**
   * Records a refusal and returns the error to throw.
   *
   * Returns rather than throws, so a call site reads `throw refuse(...)` and
   * the control flow stays visible where the decision is — the shape
   * `conversation.service.ts`'s `refusalForFailedAssignment` uses.
   *
   * The `reason` is the one place the distinctions exist. No email and no name
   * is ever passed here: `reason` and ids are the complete field set
   * (ADR-027 §13).
   */
  function refuse(
    log: AuthLogger,
    event: string,
    reason: RefusalReason,
    context: Record<string, unknown>,
    error: Error,
  ): Error {
    log.info({ event, reason, ...context }, "Member operation refused");
    return error;
  }

  /**
   * The tenant-scoped membership lookup every write starts from
   * (ADR-027 §9).
   *
   * Two keys in one query, so a membership under another organization is not
   * located rather than being located and refused — the 404 is produced by the
   * query missing, and no branch in this file compares tenants.
   */
  async function requireMembership(
    organizationId: string,
    membershipId: string,
    actorUserId: string,
    event: string,
    log: AuthLogger,
  ): Promise<MembershipDocument> {
    const membership = await membershipRepository.findByIdForOrganization(membershipId, organizationId);

    if (membership === null) {
      throw refuse(
        log,
        event,
        "membership_not_found",
        { organizationId, actorUserId, membershipId },
        new MemberNotFoundError(MEMBER_NOT_FOUND_MESSAGE),
      );
    }

    return membership;
  }

  /**
   * The two structural refusals every member WRITE shares (ADR-027 §7).
   *
   * Order matters only for which message a request that trips both receives,
   * and owner-protection is checked first because it is the invariant — the
   * self-modification rule is about the caller's own footing, while this one is
   * about whether the tenant survives the request.
   *
   * Neither is a role COMPARISON of the kind ADR-002 §7–19 forbids. The first
   * reads the target's stored role against one literal to protect a database
   * invariant; the second compares two user ids. Neither asks "is the caller
   * senior enough", which is the question a second RBAC system would ask.
   */
  function assertWriteable(
    membership: MembershipDocument,
    actorUserId: string,
    organizationId: string,
    event: string,
    log: AuthLogger,
  ): void {
    const context = {
      organizationId,
      actorUserId,
      membershipId: membership._id.toString(),
      targetUserId: membership.userId.toString(),
    };

    if (membership.role === "owner") {
      throw refuse(
        log,
        event,
        "owner_protected",
        context,
        new OrganizationOwnerProtectedError(OWNER_PROTECTED_MESSAGE),
      );
    }

    if (membership.userId.toString() === actorUserId) {
      throw refuse(
        log,
        event,
        "self_modification",
        context,
        new MemberSelfModificationError(SELF_MODIFICATION_MESSAGE),
      );
    }
  }

  /**
   * Releases every conversation this person holds in this tenant, and
   * announces each one (ADR-027 §10).
   *
   * BEST-EFFORT AND NEVER THROWS. The membership write it follows has already
   * succeeded and the caller's outcome must not change because bookkeeping did
   * not — the posture ADR-022 §10 set for follow-up writes and
   * `login.service.ts` set for `clearLoginFailures`.
   *
   * `conversationEvents.publish` is the seam ADR-025 §2 built and ADR-026 §9
   * reused: `createSocketServer`'s existing subscriber turns each event into a
   * `conversation:updated` in the tenant's inbox room, so every connected
   * agent's list re-renders the row as unassigned with no new event type, no
   * new room, and no new subscriber. This file does not import `socket.io` and
   * does not know one exists.
   *
   * The failure line carries a failure TYPE rather than the error object,
   * matching `organizationOnboarding.service.ts`'s compensation logging.
   */
  async function releaseAssignments(
    organizationId: string,
    targetUserId: string,
    log: AuthLogger,
  ): Promise<number> {
    try {
      const released = await conversationRepository.releaseAllForUser(organizationId, targetUserId);

      for (const conversation of released) {
        conversationEvents.publish(toConversationUpdatedEvent(organizationId, conversation));
      }

      return released.length;
    } catch (err) {
      log.error(
        {
          event: "member.assignment_cleanup_failed",
          organizationId,
          targetUserId,
          failureType: failureType(err),
        },
        "A member's conversation assignments could not be released",
      );
      return 0;
    }
  }

  /**
   * Announces that this person's staff access to this tenant has ended
   * (ADR-029 §9).
   *
   * The ONLY subscriber today is `createSocketServer`, which closes that
   * person's agent sockets. It exists because both membership gates run once —
   * `requireOrganization` per request and `socketAuthentication` per handshake
   * — while the Socket.IO fan-out performs zero membership lookups per event.
   * Without this, a revoked member's already-open socket keeps receiving the
   * tenant's `message:new` and `conversation:updated` traffic until it happens
   * to close.
   *
   * Called from BOTH revocation paths — suspension and removal — because they
   * produce the identical state. ADR-027 §10's removal shipped the same hole
   * and did not name it; one subscriber, two writers, and the older gap closes
   * with the newer one.
   *
   * NOT called on reactivation: the member simply connects again, and a
   * "reconnect now" push would be a client instruction, which this seam is not.
   *
   * `publish` is best-effort and never throws, like both sibling seams — the
   * membership write is already durable, so nothing here may fail it.
   */
  function announceRevocation(
    organizationId: string,
    targetUserId: string,
    reason: "suspended" | "removed",
  ): void {
    membershipEvents.publish({ organizationId, userId: targetUserId, reason });
  }

  /** Batches the roster's `User` lookups into one query — never one per row (ADR-027 §14). */
  async function projectMembers(memberships: MembershipDocument[]): Promise<MemberResponse[]> {
    const users = await userRepository.findByIds(memberships.map((membership) => membership.userId));

    return sortMembers(
      memberships.map((membership) => toMemberResponse(membership, users.get(membership.userId.toString()) ?? null)),
    );
  }

  return {
    async listMembers(
      organizationId: string,
      actor: MemberActor,
      log: AuthLogger = logger,
    ): Promise<MemberResponse[]> {
      const memberships = await membershipRepository.listForOrganization(organizationId);
      const members = await projectMembers(memberships);

      /*
        The COUNT is logged and the roster is not — the same decision
        `currentUser.service.ts` makes about `/me`'s membership list, for the
        same reason: how many people work here is operationally useful, while
        their names and addresses in every page load would put roster data in
        the log on every dashboard mount (ADR-016 §9, ADR-027 §13).
      */
      log.info(
        { event: "member.listed", organizationId, actorUserId: actor.userId, count: members.length },
        "Organization roster read",
      );

      return members;
    },

    async addMember(
      organizationId: string,
      input: AddMemberInput,
      actor: MemberActor,
      log: AuthLogger = logger,
    ): Promise<MemberResponse> {
      /*
        Normalized here rather than in the schema, through the one function
        that owns the rule (`user.model.ts`): Mongoose's schema-level
        `lowercase`/`trim` transform assigned values and NOT query filters, so
        the lookup below would otherwise miss on a capitalized address and
        create a second membership for one person.
      */
      const email = normalizeEmail(input.email);

      const user = await userRepository.findByEmail(email);

      /*
        The identical three-part gate `currentUser.service.ts`,
        `refresh.service.ts`, and `organizationOnboarding.service.ts` apply to
        the CALLER, applied here to the TARGET: exists, active, verified. Four
        services, one definition of who Serviqo still serves.

        All three collapse into one refusal with one message (ADR-027 §5). The
        submitted email is deliberately absent from the log line — that field
        is the enumeration channel the `memberInvite` rate limit class exists
        to bound, and a log is read by people who did not pass `member.manage`.
      */
      if (user === null || user.status !== "active" || user.emailVerifiedAt === null) {
        throw refuse(
          log,
          "member.add_refused",
          "unknown_or_unverified_user",
          { organizationId, actorUserId: actor.userId },
          new MemberNotInvitableError(MEMBER_NOT_INVITABLE_MESSAGE),
        );
      }

      const targetUserId = user._id.toString();

      /*
        The fast path. NOT the authority — index A is (ADR-027 §8), and the
        catch below is what makes two concurrent adds of the same person answer
        409 rather than 500. The same pre-check-plus-catch shape
        `registration.service.ts` established for email and
        `organizationOnboarding.service.ts` reuses for slugs.

        Any status counts as "already a member": re-adding a suspended person
        would be a reinstatement dressed as an add.
      */
      const existing = await membershipRepository.findByUserAndOrganization(targetUserId, organizationId);
      if (existing !== null) {
        throw refuse(
          log,
          "member.add_refused",
          "already_a_member",
          { organizationId, actorUserId: actor.userId, targetUserId, membershipId: existing._id.toString() },
          new MemberAlreadyExistsError(MEMBER_ALREADY_EXISTS_MESSAGE),
        );
      }

      let membership: MembershipDocument;
      try {
        membership = await membershipRepository.create({
          userId: targetUserId,
          organizationId,
          role: input.role,
          /*
            Literals, not request input (ADR-022 §5, ADR-027 §3). `status` is
            `active` because this slice ships direct add and cannot deliver an
            acceptance; `invitedByUserId` is the verified caller, so the roster
            records who added whom from the first day rather than from the day
            emailed invitations ship.
          */
          status: "active",
          invitedByUserId: actor.userId,
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        // Lost the race: a concurrent request created this membership between
        // the pre-check and the write. Index A is the authority and it just
        // spoke.
        throw refuse(
          log,
          "member.add_refused",
          "already_a_member",
          { organizationId, actorUserId: actor.userId, targetUserId },
          new MemberAlreadyExistsError(MEMBER_ALREADY_EXISTS_MESSAGE),
        );
      }

      log.info(
        {
          event: "member.added",
          organizationId,
          actorUserId: actor.userId,
          membershipId: membership._id.toString(),
          targetUserId,
          role: membership.role,
        },
        "Member added to organization",
      );

      return toMemberResponse(membership, user);
    },

    async changeRole(
      organizationId: string,
      membershipId: string,
      role: MembershipRole,
      actor: MemberActor,
      log: AuthLogger = logger,
    ): Promise<MemberResponse> {
      const membership = await requireMembership(
        organizationId,
        membershipId,
        actor.userId,
        "member.role_change_refused",
        log,
      );

      assertWriteable(membership, actor.userId, organizationId, "member.role_change_refused", log);

      const previousRole = membership.role;
      const targetUserId = membership.userId.toString();

      const updated = await membershipRepository.updateRoleForOrganization(membershipId, organizationId, role);

      /*
        Removed between the read and the write. The same opaque refusal every
        unreachable membership produces, rather than a distinct "it vanished"
        branch a client could learn to distinguish.
      */
      if (updated === null) {
        throw refuse(
          log,
          "member.role_change_refused",
          "membership_not_found",
          { organizationId, actorUserId: actor.userId, membershipId },
          new MemberNotFoundError(MEMBER_NOT_FOUND_MESSAGE),
        );
      }

      /*
        ADR-027 §10's forward-looking half. Under today's catalogue every role
        holds `conversation.assign`, so this releases nothing — and it is
        written anyway, derived from `can()` rather than from a hardcoded role
        list, so a future read-only role does not silently keep holding
        conversations it can no longer release.

        Reached only when the predicate says so, which is why the integration
        suite asserts the COMPLEMENT: a role change under the current catalogue
        leaves assignments intact. That makes the premise itself covered, and
        it fails loudly if the table changes.
      */
      let releasedConversations = 0;
      if (!can(role, "conversation.assign")) {
        releasedConversations = await releaseAssignments(organizationId, targetUserId, log);
      }

      log.info(
        {
          event: "member.role_changed",
          organizationId,
          actorUserId: actor.userId,
          membershipId,
          targetUserId,
          previousRole,
          role: updated.role,
          releasedConversations,
        },
        "Member role changed",
      );

      /*
        The `User` is re-read rather than carried from `requireMembership`,
        which loaded only the membership. One lookup for one row is not the
        N+1 the list path avoids.
      */
      const user = await userRepository.findById(targetUserId);

      return toMemberResponse(updated, user);
    },

    async changeStatus(
      organizationId: string,
      membershipId: string,
      status: MembershipStatus,
      actor: MemberActor,
      log: AuthLogger = logger,
    ): Promise<{ member: MemberResponse; releasedConversations: number }> {
      const membership = await requireMembership(
        organizationId,
        membershipId,
        actor.userId,
        "member.status_change_refused",
        log,
      );

      /*
        The two structural refusals every member WRITE shares (ADR-027 §7),
        reused unchanged. Owner-protection carries the weight here: a SUSPENDED
        OWNER is a fourth route to ADR-016 §3's unrecoverable tenant — an owner
        who cannot sign in, with nobody able to administer the organization and
        nobody able to transfer it out, because ADR-028 §2 gives
        `organization.transfer_ownership` to `owner` alone.

        The repository filter carries `role: { $ne: "owner" }` as well. That is
        a backstop rather than a duplicate: this branch produces the actionable
        error, and the filter makes the WRITE unable to land on an owner
        document even if a future branch reached it wrongly (ADR-029 §7).
      */
      assertWriteable(membership, actor.userId, organizationId, "member.status_change_refused", log);

      const previousStatus = membership.status;
      const targetUserId = membership.userId.toString();

      const context = {
        organizationId,
        actorUserId: actor.userId,
        membershipId,
        targetUserId,
        previousStatus,
        status,
      };

      /*
        THE TRANSITION TABLE (ADR-029 §6). Exactly two transitions exist:

          active    → suspended   ✅
          suspended → active      ✅

        Everything else is refused, INCLUDING BOTH NO-OPS. `PATCH` invites an
        idempotent reading and `conversationRepository.setStatus` takes the
        opposite position for conversations — the difference is that a
        membership's status is an access-control decision, and answering `200`
        for a revocation that had already happened (or had not) is how a
        manager on a stale page comes to believe they acted when they did not.

        An `invited` membership lands here too, and cannot be resolved in
        either direction by a manager: they can neither accept an invitation on
        someone's behalf nor suspend access that was never granted
        (ADR-027 §3).
      */
      const isSuspending = previousStatus === "active" && status === "suspended";
      const isReactivating = previousStatus === "suspended" && status === "active";

      if (!isSuspending && !isReactivating) {
        throw refuse(
          log,
          "member.status_change_refused",
          "invalid_transition",
          context,
          new MemberStatusTransitionError(STATUS_TRANSITION_MESSAGE),
        );
      }

      const updated = await membershipRepository.updateStatusForOrganization(
        membershipId,
        organizationId,
        previousStatus,
        status,
      );

      /*
        `status: previousStatus` is in the filter, so `null` means a concurrent
        request already made this transition — two managers suspending the same
        person, where MongoDB's per-document atomicity lets exactly one win.
        The loser is refused with the same message a stale page would get,
        because from the caller's side those are the same situation.

        It also covers the membership being removed between the read and the
        write, and the owner backstop matching. All three are answered
        identically on purpose: the service already proved which of them it was
        before calling, so a `null` here is a lost race rather than a
        diagnosis (ADR-029 §6).
      */
      if (updated === null) {
        throw refuse(
          log,
          "member.status_change_refused",
          "invalid_transition",
          context,
          new MemberStatusTransitionError(STATUS_TRANSITION_MESSAGE),
        );
      }

      let releasedConversations = 0;

      if (isSuspending) {
        /*
          Revocation first, bookkeeping second — the ordering `removeMember`
          established and for the identical reason (ADR-027 §10).
        */
        announceRevocation(organizationId, targetUserId, "suspended");

        /*
          UNCONDITIONAL, not derived from `can()` (ADR-029 §10).

          `changeRole` above and ADR-028 §13 both gate their release on
          `can(newRole, "conversation.assign")`, because a role change takes
          away ONE PERMISSION. Suspension takes away THE WHOLE TENANT: a
          suspended member fails `requireOrganization` before any permission is
          consulted, so no role they still nominally hold can matter. Applying
          the `can()` predicate here would be applying a test whose premise
          does not hold — and under today's catalogue it would release nothing,
          stranding conversations on someone locked out, which is exactly
          ADR-026 §15's hole reopened.
        */
        releasedConversations = await releaseAssignments(organizationId, targetUserId, log);
      }

      /*
        Reactivation restores ACCESS AND NOTHING ELSE (ADR-029 §10). The
        conversations released on suspension went back to the unassigned queue
        and colleagues may have claimed them since; silently re-assigning would
        take live work off other people's desks without anyone asking. There is
        also no record of the prior assignment to restore from, and adding one
        would be building a suspension-history feature inside a status route.
      */

      log.info(
        { event: "member.status_changed", ...context, role: updated.role, releasedConversations },
        isSuspending ? "Member suspended" : "Member reactivated",
      );

      /*
        The `User` is re-read rather than carried from `requireMembership`,
        which loaded only the membership — one lookup for one row is not the
        N+1 the list path avoids. The same shape `changeRole` uses.
      */
      const user = await userRepository.findById(targetUserId);

      return { member: toMemberResponse(updated, user), releasedConversations };
    },

    async removeMember(
      organizationId: string,
      membershipId: string,
      actor: MemberActor,
      log: AuthLogger = logger,
    ): Promise<{ removed: MemberResponse; releasedConversations: number }> {
      const membership = await requireMembership(
        organizationId,
        membershipId,
        actor.userId,
        "member.remove_refused",
        log,
      );

      assertWriteable(membership, actor.userId, organizationId, "member.remove_refused", log);

      const targetUserId = membership.userId.toString();

      /*
        Read BEFORE the delete, because the projection needs a name and an
        address the removed row can no longer be joined to afterwards.
      */
      const user = await userRepository.findById(targetUserId);

      /*
        THE REVOCATION, and it happens FIRST (ADR-027 §10).

        Access revocation is the security-relevant half and must not be delayed
        behind bookkeeping. The partial state this ordering can produce — a
        membership removed while some conversations are still assigned to that
        person — is exactly the state that existed before this slice and is
        inert: they can no longer reach the tenant. The inverse ordering's
        partial state, assignments cleared while the person still has access,
        is the one that reads as a bug to everyone looking at it.
      */
      const removed = await membershipRepository.deleteForOrganization(membershipId, organizationId);

      if (removed === null) {
        throw refuse(
          log,
          "member.remove_refused",
          "membership_not_found",
          { organizationId, actorUserId: actor.userId, membershipId },
          new MemberNotFoundError(MEMBER_NOT_FOUND_MESSAGE),
        );
      }

      /*
        The live socket, closed (ADR-029 §9). BEFORE the assignment cleanup,
        for the same reason the delete comes before it: cutting the channel is
        the security-relevant half, and bookkeeping must not delay it.
      */
      announceRevocation(organizationId, targetUserId, "removed");

      // ADR-026 §15's carried-forward limitation, closed.
      const releasedConversations = await releaseAssignments(organizationId, targetUserId, log);

      log.info(
        {
          event: "member.removed",
          organizationId,
          actorUserId: actor.userId,
          membershipId,
          targetUserId,
          role: removed.role,
          releasedConversations,
        },
        "Member removed from organization",
      );

      return { removed: toMemberResponse(removed, user), releasedConversations };
    },
  };
}
