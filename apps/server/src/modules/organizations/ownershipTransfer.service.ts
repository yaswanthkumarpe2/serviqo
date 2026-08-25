import {
  MemberNotFoundError,
  OwnershipTransferConflictError,
  OwnershipTransferSelfTargetError,
  OwnershipTransferTargetInvalidError,
} from "../../lib/errors";
import { logger } from "../../lib/logger";
import { failureType } from "../auth/authLogging";
import { conversationRepository } from "../conversations/conversation.repository";
import { conversationEvents, toConversationUpdatedEvent } from "../conversations/conversationEvents";
import { membershipRepository } from "../memberships/membership.repository";
import { can } from "../memberships/permissions";
import { userRepository } from "../users/user.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { MembershipDocument, MembershipRole } from "../memberships/membership.model";

/**
 * Organization ownership transfer (ADR-028) — the slice that closes ADR-027
 * §7a's deferral and gives `organization.transfer_ownership` the one route it
 * guards.
 *
 * This service does exactly one thing that nothing else in the codebase does:
 * it changes two documents that must agree, in a database this project
 * deliberately runs without transactions (ADR-016 §3). It does NOT invent a
 * transaction abstraction. It uses the pattern ADR-016 §4 already established
 * — ordered writes, each guarded by a filter that IS the precondition, with
 * compensation when the second does not land — and ADR-028 §10 states the
 * residual window in full rather than implying there is none.
 *
 * Read `transferOwnership` below alongside ADR-028 §8. The comments there
 * carry the invariant; the code is short precisely because the guards live in
 * the queries.
 *
 * `organizationId` comes from the CALLER, which took it from
 * `req.organizationContext`, which `requireOrganization` built from the path
 * after proving an active membership in an active organization (ADR-017 §2).
 * Nothing here re-checks the caller's own standing and nothing here compares a
 * role to decide whether they may act — `requirePermission(
 * "organization.transfer_ownership")` on the route is the entire authorization
 * decision (ADR-002 §7–19). A second copy of either gate is a second thing
 * that can disagree with the first.
 *
 * `AuthLogger` and `failureType` are imported from the auth module rather than
 * duplicated, following the precedent `organizationOnboarding.service.ts`,
 * `member.service.ts`, and `conversation.service.ts` each recorded.
 */

/**
 * What the outgoing owner becomes (ADR-028 §7).
 *
 * ONE constant, in ONE place, read rather than computed. `ROLE_PERMISSIONS`
 * describes `admin` as "Everything the owner can do except what ownership
 * itself confers", and as of ADR-028 §2 that is literally the difference —
 * `owner` is `admin` plus `organization.transfer_ownership`. So this is the
 * transition that changes exactly one capability: the one being transferred.
 *
 * Deliberately NOT derived by a "largest remaining permission set"
 * computation. That would be clever, would silently re-target if the catalogue
 * changed, and would make "what happens to me if I transfer?" a thing you
 * compute rather than read — which is the question the dashboard has to answer
 * in words before anyone clicks (ADR-028 §16).
 *
 * Anything lower would be a second, unasked-for action: `supervisor` and
 * `agent` hold neither `member.manage` nor `organization.manage`, so demoting
 * to either would silently strip the outgoing owner of the ability to correct
 * a mistake. A transfer that also locks the transferrer out is two decisions
 * wearing one button.
 */
const PREVIOUS_OWNER_ROLE: MembershipRole = "admin";

/** ADR-027's one message for every unreachable membership, reused unchanged (ADR-028 §5). */
const MEMBER_NOT_FOUND_MESSAGE = "Member not found";

/** Says the half the caller can act on: they are the owner, so they must pick someone else. */
const SELF_TARGET_MESSAGE =
  "You already own this organization. Choose a different member to transfer ownership to.";

/**
 * ONE message for "the membership is not active" and for "the account is not
 * active or not verified" (ADR-028 §6).
 *
 * Both mean the same thing to the caller and have the same remedy, and
 * splitting them would let one distinguish a suspended membership from a
 * suspended account for no benefit they can act on.
 */
const TARGET_INVALID_MESSAGE =
  "That member cannot receive ownership. They need an active membership and an active, verified Serviqo account.";

/** Names what to do next, because "conflict" does not and the resolution is a real one. */
const CONFLICT_MESSAGE =
  "Ownership changed while this request was in flight. Reload the team and try again.";

/**
 * Why a transfer was refused. Reaches the log and NEVER a response body
 * (ADR-028 §12) — the split ADR-015 §6, ADR-017 §6, and ADR-027 §13 each
 * established, applied a fourth time.
 */
type RefusalReason =
  | "membership_not_found"
  | "self_target"
  | "membership_not_active"
  | "user_not_eligible"
  | "ownership_changed";

/**
 * Who is acting. BOTH fields come from the server and neither can be named by
 * the request (ADR-028 §4).
 *
 * `membershipId` is the acting owner's OWN membership — the document
 * `requireOrganization` loaded on this request — and it is what the demote is
 * aimed at. A `currentOwnerId` in a request body would be the client choosing
 * whose ownership to end; there is no such field, and the schema strips one if
 * sent.
 */
export interface OwnershipTransferActor {
  /** `req.principal.userId` — the verified subject of the access token. */
  userId: string;
  /** `req.organizationContext.membershipId` — read from the database on this request. */
  membershipId: string;
}

/**
 * What the caller is told (ADR-028 §15).
 *
 * Two membership ids and two roles. No name, no email, no user id, no
 * organization echo, and no permission list — ADR-017 §10 already refused the
 * last of those, "because a client that branches on it would be a client
 * authorizing itself". The client refetches the roster and the organization
 * context regardless, so anything richer here would be data with no reader.
 */
export interface OwnershipTransferResult {
  previousOwner: { id: string; role: MembershipRole };
  newOwner: { id: string; role: MembershipRole };
}

export interface OwnershipTransferService {
  /**
   * Hands the organization to another active member (ADR-028 §6, §8).
   *
   * Refuses before any write for every reason in §6, and refuses with
   * `OwnershipTransferConflictError` when a concurrent transfer won the demote
   * or the promotion could not land — in which case the demote is compensated
   * and the organization is exactly as it was.
   */
  transferOwnership(
    organizationId: string,
    targetMembershipId: string,
    actor: OwnershipTransferActor,
    log?: AuthLogger,
  ): Promise<OwnershipTransferResult>;
}

export function createOwnershipTransferService(): OwnershipTransferService {
  /**
   * Records a refusal and returns the error to throw.
   *
   * Returns rather than throws, so a call site reads `throw refuse(...)` and
   * the control flow stays visible where the decision is — the shape
   * `member.service.ts` and `conversation.service.ts` both use.
   *
   * The `reason` is the one place the distinctions exist. No name, no email,
   * and no token is ever passed here: ids, roles, and counts are the complete
   * field set (ADR-028 §12).
   */
  function refuse(
    log: AuthLogger,
    reason: RefusalReason,
    context: Record<string, unknown>,
    error: Error,
  ): Error {
    log.info(
      { event: "organization.ownership_transfer_refused", reason, ...context },
      "Ownership transfer refused",
    );
    return error;
  }

  /**
   * Undoes the demote (ADR-028 §8d).
   *
   * NEVER THROWS. It runs on a path that is already failing, and turning a
   * compensation fault into a different error would hide which of the two
   * things went wrong. The caller answers `409` either way; what changes is
   * which line an operator reads afterwards.
   *
   * A `null` return means the restore matched nothing — ADR-028 §10's window
   * has been entered and NOT closed, and the organization currently has no
   * owner. That is the one line in this slice worth alerting on, and it
   * carries a failure TYPE rather than an error object, matching
   * `organizationOnboarding.service.ts`'s own compensation logging: a Mongo
   * error's text can quote the offending document.
   */
  async function compensate(
    organizationId: string,
    actor: OwnershipTransferActor,
    log: AuthLogger,
  ): Promise<void> {
    const context = {
      organizationId,
      actorUserId: actor.userId,
      previousOwnerMembershipId: actor.membershipId,
    };

    try {
      const restored = await membershipRepository.restoreOwner(
        actor.membershipId,
        organizationId,
        PREVIOUS_OWNER_ROLE,
      );

      if (restored === null) {
        log.error(
          { event: "organization.ownership_transfer_compensation_failed", ...context, reason: "no_document_matched" },
          "Ownership transfer could not be rolled back — the organization may have no owner",
        );
        return;
      }

      log.info(
        { event: "organization.ownership_transfer_compensated", ...context },
        "Ownership transfer rolled back; the previous owner was restored",
      );
    } catch (err) {
      log.error(
        {
          event: "organization.ownership_transfer_compensation_failed",
          ...context,
          failureType: failureType(err),
        },
        "Ownership transfer could not be rolled back — the organization may have no owner",
      );
    }
  }

  /**
   * Releases the outgoing owner's conversation assignments IF their new role
   * cannot hold them (ADR-028 §13, ADR-027 §10).
   *
   * BEST-EFFORT AND NEVER THROWS, for the reason `member.service.ts` gives:
   * the membership writes it follows have already succeeded and the caller's
   * outcome must not change because bookkeeping did not.
   *
   * Under today's catalogue `admin` holds `conversation.assign`, so the guard
   * is false and this releases nothing. It is written anyway, derived from
   * `can()` rather than from a hardcoded role list, so a future read-only role
   * does not silently keep holding conversations it can no longer release. The
   * integration suite asserts the COMPLEMENT — that a transfer leaves both
   * parties' assignments intact — which covers the premise and fails loudly if
   * the table changes.
   *
   * The incoming owner needs no equivalent: `owner` holds every permission any
   * role holds, so promotion can only widen what they may do.
   *
   * `conversationEvents.publish` is the seam ADR-025 §2 built and ADR-026 §9
   * and ADR-027 §10 each reused: `createSocketServer`'s existing subscriber
   * turns each event into a `conversation:updated` in the tenant's INBOX room,
   * which no customer is ever in (ADR-026 §10). This file does not import
   * `socket.io` and does not know one exists.
   */
  async function releaseAssignmentsIfNeeded(
    organizationId: string,
    previousOwnerUserId: string,
    log: AuthLogger,
  ): Promise<number> {
    if (can(PREVIOUS_OWNER_ROLE, "conversation.assign")) return 0;

    /* c8 ignore start -- unreachable while `admin` holds conversation.assign (ADR-028 §13). */
    try {
      const released = await conversationRepository.releaseAllForUser(organizationId, previousOwnerUserId);

      for (const conversation of released) {
        conversationEvents.publish(toConversationUpdatedEvent(organizationId, conversation));
      }

      return released.length;
    } catch (err) {
      log.error(
        {
          event: "organization.ownership_transfer_cleanup_failed",
          organizationId,
          previousOwnerUserId,
          failureType: failureType(err),
        },
        "The previous owner's conversation assignments could not be released",
      );
      return 0;
    }
    /* c8 ignore stop */
  }

  return {
    async transferOwnership(
      organizationId: string,
      targetMembershipId: string,
      actor: OwnershipTransferActor,
      log: AuthLogger = logger,
    ): Promise<OwnershipTransferResult> {
      /* Ids only. No email, no name — the complete field set (ADR-028 §12). */
      const context = {
        organizationId,
        actorUserId: actor.userId,
        previousOwnerMembershipId: actor.membershipId,
      };

      /*
        ---- Gate 1: the target must be reachable INSIDE this tenant (§5) ----

        Two keys in one indexed query, the organization half server-derived. A
        membership under another organization returns `null` IDENTICALLY to one
        that does not exist, so the 404 below is produced by the query missing
        rather than by a branch comparing tenants. No line in this file reads
        `target.organizationId`, because no document from another tenant is
        ever in hand.
      */
      const target = await membershipRepository.findByIdForOrganization(targetMembershipId, organizationId);

      if (target === null) {
        throw refuse(
          log,
          "membership_not_found",
          { ...context, newOwnerMembershipId: targetMembershipId },
          new MemberNotFoundError(MEMBER_NOT_FOUND_MESSAGE),
        );
      }

      const targetContext = {
        ...context,
        newOwnerMembershipId: target._id.toString(),
        newOwnerUserId: target.userId.toString(),
      };

      /*
        ---- Gate 2: not the caller's own membership (§6.2) ----

        "Transfer to yourself" and "transfer to the current owner" are ONE
        condition, not two: index B allows at most one owner and
        `organization.transfer_ownership` is held only by `owner`, so the only
        membership here whose role is `owner` is the caller's own.

        Compared by MEMBERSHIP id against `req.organizationContext.membershipId`
        — a value the server read from the database on this request. The
        `userId` comparison below it is not redundant: index A guarantees one
        membership per user per organization, so the two can only disagree if
        the context were built from something other than this tenant, and
        asserting both makes that impossible to introduce silently.
      */
      if (
        target._id.toString() === actor.membershipId ||
        target.userId.toString() === actor.userId ||
        target.role === "owner"
      ) {
        throw refuse(
          log,
          "self_target",
          targetContext,
          new OwnershipTransferSelfTargetError(SELF_TARGET_MESSAGE),
        );
      }

      /*
        ---- Gate 3: the membership must be active (§6.3) ----

        `invited` has not been accepted and `suspended` has been revoked;
        `requireOrganization` refuses both for a CALLER. Handing the tenant to
        someone who cannot sign into it would manufacture an organization that
        is unowned in practice.
      */
      if (target.status !== "active") {
        throw refuse(
          log,
          "membership_not_active",
          targetContext,
          new OwnershipTransferTargetInvalidError(TARGET_INVALID_MESSAGE),
        );
      }

      /*
        ---- Gate 4: the account must exist, be active, and be verified (§6.4) ----

        The identical three-part gate `currentUser.service.ts`,
        `refresh.service.ts`, `organizationOnboarding.service.ts`, and
        `member.service.ts` apply — five services, one definition of who
        Serviqo still serves. A suspended user holding a stale active
        membership is exactly what this catches, and it is the case a
        membership-only check would miss.
      */
      const targetUser = await userRepository.findById(target.userId.toString());

      if (targetUser === null || targetUser.status !== "active" || targetUser.emailVerifiedAt === null) {
        throw refuse(
          log,
          "user_not_eligible",
          targetContext,
          new OwnershipTransferTargetInvalidError(TARGET_INVALID_MESSAGE),
        );
      }

      /*
        ================= THE TRANSFER (ADR-028 §8) =================

        Two writes, no transaction, and the guards ARE the preconditions.
        Read this alongside ADR-028 §8; the ordering is not arbitrary.
      */

      /*
        STEP 1 — demote, guarded on `role: "owner"`.

        This is the concurrency primitive. Two simultaneous transfers both aim
        at the same single owner document and MongoDB applies each update
        atomically to it, so EXACTLY ONE matches. The loser matches nothing,
        writes nothing, never reaches step 2, and therefore cannot promote a
        second target. "One transfer wins" is a property of the database rather
        than of a comparison that races.

        `null` here also covers the honest race: the caller was the owner when
        `requireOrganization` read their membership and is not the owner by the
        time this write runs. Nothing has been written, so there is nothing to
        compensate.
      */
      const demoted = await membershipRepository.demoteOwner(
        actor.membershipId,
        organizationId,
        PREVIOUS_OWNER_ROLE,
      );

      if (demoted === null) {
        throw refuse(
          log,
          "ownership_changed",
          targetContext,
          new OwnershipTransferConflictError(CONFLICT_MESSAGE),
        );
      }

      /*
        >>> THE ORGANIZATION NOW HAS NO OWNER <<<

        One database round-trip wide, and inert while it lasts (ADR-028 §8c):
        `requireOrganization` has no opinion about ownership, no other route
        consults `role === "owner"` to authorize anything, nothing is deleted,
        no access is granted, and NOBODY holds
        `organization.transfer_ownership` — so no second transfer can begin
        inside it. ADR-028 §10 states what remains true if the process dies
        here, and SECURITY.md §3a records it as a deployment gate: a replica
        set and a transaction are what remove it, not more code.
      */

      let promoted: MembershipDocument | null;
      try {
        /*
          STEP 2 — promote, guarded on tenant, `status: "active"`, and
          `role: { $ne: "owner" }`.

          The filter re-asserts gates 1 and 3 AS PART OF THE WRITE rather than
          trusting reads taken microseconds ago, so a target suspended in
          between is not promoted. A duplicate-key throw is possible in
          principle — index B is the final authority, as ADR-027 §8 has it for
          index A — and is treated identically to `null`: compensate, refuse.
        */
        promoted = await membershipRepository.promoteToOwner(target._id.toString(), organizationId);
      } catch (err) {
        log.error(
          { event: "organization.ownership_transfer_failed", ...targetContext, failureType: failureType(err) },
          "Ownership transfer could not promote the new owner",
        );
        await compensate(organizationId, actor, log);
        throw new OwnershipTransferConflictError(CONFLICT_MESSAGE);
      }

      if (promoted === null) {
        await compensate(organizationId, actor, log);
        throw refuse(
          log,
          "ownership_changed",
          targetContext,
          new OwnershipTransferConflictError(CONFLICT_MESSAGE),
        );
      }

      /* Today a no-op, derived from `can()` rather than assumed (§13). */
      const releasedConversations = await releaseAssignmentsIfNeeded(
        organizationId,
        demoted.userId.toString(),
        log,
      );

      /*
        STEP 3 — the post-condition, recorded (§8e).

        Index B already makes a count above 1 impossible, so this is not a
        duplicate check. It is what turns "exactly one owner" from a property
        the code intends into a fact the log states on every transfer — and it
        is what the integration suite reads to prove the invariant held across
        concurrent attempts.
      */
      const ownerCount = await membershipRepository.countOwners(organizationId);

      log.info(
        {
          event: "organization.ownership_transferred",
          ...targetContext,
          previousOwnerRole: demoted.role,
          ownerCount,
          releasedConversations,
        },
        "Organization ownership transferred",
      );

      return {
        previousOwner: { id: demoted._id.toString(), role: demoted.role },
        newOwner: { id: promoted._id.toString(), role: promoted.role },
      };
    },
  };
}
