import { ValidationError } from "../../lib/errors";
import { created, success } from "../../lib/response";
import { OBJECT_ID_PATTERN } from "./member.validation";

import type { MemberService } from "./member.service";
import type { AddMemberInput, UpdateMemberRoleInput } from "./member.validation";
import type { RequestHandler } from "express";

export interface MemberControllerDependencies {
  memberService: MemberService;
}

/**
 * Translates request → service → response for the team-management surface
 * (ADR-027 §1), and nothing else — the contract every controller in this
 * codebase follows.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise to
 * the error middleware, which is the single place that turns an error into a
 * response.
 *
 * Note what these handlers never read: `req.body.organizationId`,
 * `req.body.userId`, `req.body.membershipId`, `req.body.status`,
 * `req.body.invitedByUserId`, `req.query.organizationId`. The tenant comes from
 * `req.organizationContext`, which `requireOrganization` built from the path
 * segment after proving membership (ADR-017 §1, §5); the acting user comes from
 * `req.principal`, which `requireAccessToken` derived from a verified token;
 * the target comes from the path. None of the three has a client-reachable
 * source (ADR-027 §4).
 */
export function createMemberController({ memberService }: MemberControllerDependencies) {
  /**
   * Guards `:membershipId` before any service or repository call touches it —
   * the identical helper `agentInbox.controller.ts` applies to
   * `:conversationId`, for the identical reason: a malformed value reaching
   * `Mongoose.findOne` raises a `CastError`, which `errorHandler` turns into a
   * generic 500, reporting a client's mistyped URL as a server fault.
   *
   * Answering `400` specifically is safe here: it depends only on the
   * submitted string's shape, never on whether any membership exists, so it is
   * not an existence oracle (ADR-027 §9).
   */
  function requireWellFormedMembershipId(value: string | string[] | undefined): string {
    if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
      throw new ValidationError("Request validation failed", [
        { field: "membershipId", message: "membershipId is not a valid id" },
      ]);
    }
    return value;
  }

  /**
   * The organization's roster (ADR-027 §14).
   *
   * `req.organizationContext` and `req.principal` are safe to assert:
   * `requireAccessToken` and `requireOrganization` set them or this handler was
   * never reached, and `requirePermission` refused after that unless the
   * caller's role holds `member.read`.
   */
  const listMembers: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;

    const members = await memberService.listMembers(organizationId, { userId }, req.log);

    success(res, { members });
  };

  /**
   * Adds a member (ADR-027 §3).
   *
   * `req.body` is safe to assert: `validateBody(addMemberSchema)` replaced it
   * with exactly `{ email, role }`. No `userId`, no `organizationId`, no
   * `status`, and no `invitedByUserId` could have survived that schema even if
   * a client sent them — they are stripped, not rejected, so a forged value
   * never becomes observable to this handler at all.
   *
   * 201, matching every other creating route: a membership is created, and
   * `created()` is the envelope helper that exists for that.
   */
  const addMember: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const input = req.body as AddMemberInput;

    const member = await memberService.addMember(organizationId, input, { userId }, req.log);

    created(res, member);
  };

  /**
   * Changes a member's role (ADR-027 §1, §7).
   *
   * The target is the PATH segment and the value is the body, so a client
   * cannot express "change this person in that organization" — the tenant it
   * named in the URL is the only one the service can reach.
   *
   * Answers 200 with the same projection the list returns, so the client
   * updates its row from the response with no second fetch.
   */
  const changeRole: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const membershipId = requireWellFormedMembershipId(req.params.membershipId);
    const { role } = req.body as UpdateMemberRoleInput;

    const member = await memberService.changeRole(organizationId, membershipId, role, { userId }, req.log);

    success(res, member);
  };

  /**
   * Removes a member and releases their conversations (ADR-027 §7, §10).
   *
   * Answers 200 with the removed member and the number of conversations that
   * were released, rather than 204. The count is the visible consequence of
   * the removal and the dashboard states it back to the manager — "they held
   * three conversations, which are now unassigned" is exactly the thing a
   * person wants confirmed after an irreversible action, and a 204 would make
   * the client fetch to discover it.
   */
  const removeMember: RequestHandler = async (req, res) => {
    const { organizationId } = req.organizationContext!;
    const { userId } = req.principal!;
    const membershipId = requireWellFormedMembershipId(req.params.membershipId);

    const { removed, releasedConversations } = await memberService.removeMember(
      organizationId,
      membershipId,
      { userId },
      req.log,
    );

    success(res, { member: removed, releasedConversations });
  };

  return { listMembers, addMember, changeRole, removeMember };
}
