import { randomBytes } from "node:crypto";

import { hashPassword } from "../../lib/crypto/password";
import { env } from "../../lib/env";
import { MemberAlreadyExistsError, MemberNotInvitableError, NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { AccountTokenModel } from "../accountTokens/accountToken.model";
import { failureType } from "../auth/authLogging";
import { buildVerificationUrl, issueVerificationCode } from "../auth/emailVerification";
import { MembershipModel } from "../memberships/membership.model";
import { membershipRepository } from "../memberships/membership.repository";
import { organizationRepository } from "../organizations/organization.repository";
import { UserModel, normalizeEmail } from "../users/user.model";
import { userRepository } from "../users/user.repository";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { AuthLogger } from "../auth/authLogging";
import type { MembershipDocument, MembershipRole } from "../memberships/membership.model";
import type { UserDocument } from "../users/user.model";

/**
 * Putting a person into an organisation (ADR-039 §3).
 *
 * The one way staff join an organisation, used by the super admin when they
 * create an organisation and name its owner, and by an organisation's own
 * admins when they grow their team. Nobody signs themselves up (ADR-037).
 *
 * Two shapes, decided by whether the address already has a staff account:
 *
 * - **New person.** An account is created unverified with a generated
 *   password, and one email carries the password and a six-digit code. The
 *   password does nothing until the code is redeemed, so an admin who mistyped
 *   an address has created nothing anyone can use.
 * - **Existing staff account.** A membership is added and they are told by
 *   email. No password is sent, because they already have one.
 */

export interface StaffInvitationInput {
  organizationId: string;
  name: string;
  email: string;
  role: MembershipRole;
  /** Who did it, for the roster's record. `null` only for scripts. */
  invitedByUserId: string | null;
}

export interface StaffInvitationResult {
  member: {
    membershipId: string;
    userId: string;
    name: string;
    email: string;
    role: MembershipRole;
    status: MembershipDocument["status"];
    /** False until the person redeems their code. */
    verified: boolean;
    joinedAt: Date;
  };
  organization: { id: string; name: string };
  /** True when a new account was created; false when an existing one was added. */
  accountCreated: boolean;
}

export interface StaffInvitationService {
  invite(input: StaffInvitationInput, log?: AuthLogger): Promise<StaffInvitationResult>;
}

/** 18 bytes is 144 bits, rendered base64url: pasteable, and not guessable. */
const TEMPORARY_PASSWORD_BYTES = 18;

const NOT_INVITABLE_MESSAGE = "That email belongs to an account that cannot join an organisation.";
const ALREADY_MEMBER_MESSAGE = "That person is already a member of this organisation";
const DUPLICATE_KEY_ERROR = 11000;

/** How a role reads in "You've been added to X as ___". */
export function roleLabelFor(role: MembershipRole): string {
  switch (role) {
    case "owner":
      return "the owner";
    case "admin":
      return "an admin";
    case "supervisor":
      return "a supervisor";
    default:
      return "a support agent";
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR;
}

function signInUrl(): string {
  return new URL("/login", env.CLIENT_URL).toString();
}

/**
 * Whether an existing account may be put into an organisation.
 *
 * Only staff. A platform admin already reaches every organisation through the
 * console (ADR-039 §5) and belongs to none; a legacy customer account from
 * ADR-034 can no longer sign in at all.
 */
function isInvitableStaff(user: UserDocument): boolean {
  return user.status === "active" && user.kind === "agent" && user.platformRole !== "admin";
}

export function createStaffInvitationService({ emailProvider }: { emailProvider: EmailProvider }): StaffInvitationService {
  async function addExistingAccount(
    user: UserDocument,
    input: StaffInvitationInput,
    organizationName: string,
    log: AuthLogger,
  ): Promise<{ membership: MembershipDocument }> {
    if (!isInvitableStaff(user)) {
      log.info(
        { event: "staff_invite.refused", reason: "not_invitable", organizationId: input.organizationId },
        "Invitation refused for an account that cannot join an organisation",
      );
      throw new MemberNotInvitableError(NOT_INVITABLE_MESSAGE);
    }

    const existing = await membershipRepository.findByUserAndOrganization(user._id.toString(), input.organizationId);
    if (existing !== null) throw new MemberAlreadyExistsError(ALREADY_MEMBER_MESSAGE);

    let membership: MembershipDocument;
    try {
      membership = await membershipRepository.create({
        userId: user._id,
        organizationId: input.organizationId,
        role: input.role,
        status: "active",
        invitedByUserId: input.invitedByUserId,
      });
    } catch (err) {
      // The unique { userId, organizationId } index is the authority on a race.
      if (isDuplicateKeyError(err)) throw new MemberAlreadyExistsError(ALREADY_MEMBER_MESSAGE);
      throw err;
    }

    // Best effort: the membership is real either way, and the person will see
    // the organisation the next time they sign in.
    try {
      await emailProvider.sendInvitation({
        to: user.email,
        organizationName,
        roleLabel: roleLabelFor(input.role),
        invitationUrl: signInUrl(),
      });
    } catch (err) {
      log.error(
        { event: "staff_invite.notice_failed", userId: user._id.toString(), failureType: failureType(err) },
        "Membership added, but the notice email could not be delivered",
      );
    }

    return { membership };
  }

  async function createNewAccount(
    email: string,
    input: StaffInvitationInput,
    organizationName: string,
    log: AuthLogger,
  ): Promise<{ user: UserDocument; membership: MembershipDocument }> {
    const temporaryPassword = randomBytes(TEMPORARY_PASSWORD_BYTES).toString("base64url");

    let user: UserDocument;
    try {
      user = await UserModel.create({
        name: input.name,
        email,
        passwordHash: await hashPassword(temporaryPassword),
        emailVerifiedAt: null,
        status: "active",
        kind: "agent",
      });
    } catch (err) {
      // Created by a concurrent request between our lookup and this write.
      if (isDuplicateKeyError(err)) throw new MemberAlreadyExistsError(ALREADY_MEMBER_MESSAGE);
      throw err;
    }

    let membership: MembershipDocument;
    try {
      membership = await membershipRepository.create({
        userId: user._id,
        organizationId: input.organizationId,
        role: input.role,
        status: "active",
        invitedByUserId: input.invitedByUserId,
      });

      const code = await issueVerificationCode(user._id);

      await emailProvider.sendAgentCredentials({
        to: user.email,
        organizationName,
        roleLabel: roleLabelFor(input.role),
        temporaryPassword,
        code,
        verificationUrl: buildVerificationUrl(user.email),
        signInUrl: signInUrl(),
      });
    } catch (err) {
      /*
        Rolled back, unlike most partial failures in this codebase, because the
        password exists only in the email that did not go out. Leaving the
        account would make the address permanently "taken" by an account nobody
        can ever sign into, and re-inviting would only add memberships to it.
      */
      await Promise.allSettled([
        MembershipModel.deleteMany({ userId: user._id }),
        AccountTokenModel.deleteMany({ userId: user._id }),
        UserModel.deleteOne({ _id: user._id }),
      ]);
      log.error(
        { event: "staff_invite.rolled_back", organizationId: input.organizationId, failureType: failureType(err) },
        "Invitation failed and the new account was removed",
      );
      throw new Error("The invitation email could not be delivered. Nothing was created; try again.", { cause: err });
    }

    return { user, membership };
  }

  return {
    async invite(input, log: AuthLogger = logger): Promise<StaffInvitationResult> {
      const organization = await organizationRepository.findById(input.organizationId);
      if (organization === null) throw new NotFoundError("Organisation not found");

      /*
        An owner is added only where there is none. The partial unique index on
        owner memberships would refuse a second anyway; checking first gives a
        message instead of a duplicate-key 409 about something else.
      */
      if (input.role === "owner" && (await membershipRepository.countOwners(input.organizationId)) > 0) {
        throw new MemberNotInvitableError("This organisation already has an owner. Transfer ownership instead.");
      }

      const email = normalizeEmail(input.email);
      const existingUser = await userRepository.findByEmail(email);

      let user: UserDocument;
      let membership: MembershipDocument;
      let accountCreated: boolean;

      if (existingUser !== null) {
        ({ membership } = await addExistingAccount(existingUser, input, organization.name, log));
        user = existingUser;
        accountCreated = false;
      } else {
        ({ user, membership } = await createNewAccount(email, input, organization.name, log));
        accountCreated = true;
      }

      log.info(
        {
          event: "staff_invite.succeeded",
          organizationId: organization._id.toString(),
          userId: user._id.toString(),
          role: membership.role,
          accountCreated,
          invitedByUserId: input.invitedByUserId,
        },
        "Staff member added to organisation",
      );

      return {
        member: {
          membershipId: membership._id.toString(),
          userId: user._id.toString(),
          name: user.name,
          email: user.email,
          role: membership.role,
          status: membership.status,
          verified: user.emailVerifiedAt !== null,
          joinedAt: membership.createdAt,
        },
        organization: { id: organization._id.toString(), name: organization.name },
        accountCreated,
      };
    },
  };
}
