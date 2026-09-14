import { Types } from "mongoose";

import { MemberNotInvitableError, NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { failureType } from "../auth/authLogging";
import { organizationRepository } from "../organizations/organization.repository";
import { createWithAvailableSlug } from "../organizations/organizationOnboarding.service";
import { buildWidgetUrl } from "../organizations/widgetLink";
import { normalizeEmail } from "../users/user.model";
import { userRepository } from "../users/user.repository";

import type { AuthLogger } from "../auth/authLogging";
import type { OrganizationDocument, OrganizationStatus } from "../organizations/organization.model";
import type { StaffInvitationResult, StaffInvitationService } from "../staffInvitations/staffInvitation.service";
import type {
  CreateOrganizationWithOwnerInput,
  InviteOrganizationMemberInput,
} from "./organizationAdministration.validation";

/**
 * The super admin's organisation controls (ADR-039 §1–2).
 *
 * Organisations are created here and nowhere else. Staff no longer create their
 * own (ADR-039 §1): an organisation is a customer of the platform, set up by
 * the platform, and handed to the person who will own it.
 */

export interface AdministeredOrganization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  widgetUrl: string;
  createdAt: Date;
}

export interface OrganizationAdministrationService {
  createOrganization(
    input: CreateOrganizationWithOwnerInput,
    actorUserId: string,
    log?: AuthLogger,
  ): Promise<{ organization: AdministeredOrganization; owner: StaffInvitationResult["member"]; accountCreated: boolean }>;
  updateStatus(organizationId: string, status: OrganizationStatus, log?: AuthLogger): Promise<AdministeredOrganization>;
  inviteMember(
    organizationId: string,
    input: InviteOrganizationMemberInput,
    actorUserId: string,
    log?: AuthLogger,
  ): Promise<StaffInvitationResult>;
}

export function toAdministeredOrganization(organization: OrganizationDocument): AdministeredOrganization {
  return {
    id: organization._id.toString(),
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    widgetUrl: buildWidgetUrl(organization.slug),
    createdAt: organization.createdAt,
  };
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export function createOrganizationAdministrationService({
  staffInvitationService,
}: {
  staffInvitationService: StaffInvitationService;
}): OrganizationAdministrationService {
  return {
    async createOrganization(input, actorUserId, log: AuthLogger = logger) {
      /*
        The owner is checked BEFORE anything is written. An address that
        belongs to an account which cannot join an organisation would otherwise
        leave a brand-new organisation behind with nobody to run it.
      */
      const existing = await userRepository.findByEmail(normalizeEmail(input.owner.email));
      if (
        existing !== null &&
        (existing.status !== "active" || existing.kind !== "agent" || existing.platformRole === "admin")
      ) {
        throw new MemberNotInvitableError("That email belongs to an account that cannot own an organisation.");
      }

      const organization = await createWithAvailableSlug(new Types.ObjectId(), input.name, log);
      const organizationId = organization._id.toString();

      let invited: StaffInvitationResult;
      try {
        invited = await staffInvitationService.invite(
          {
            organizationId,
            name: input.owner.name,
            email: input.owner.email,
            role: "owner",
            invitedByUserId: actorUserId,
          },
          log,
        );
      } catch (err) {
        // No owner means nobody could ever run it; take it back out.
        await organizationRepository.deleteIfUnused(organizationId).catch(() => false);
        log.error(
          { event: "platform.organization.create_rolled_back", organizationId, failureType: failureType(err) },
          "Organisation removed because its owner could not be invited",
        );
        throw err;
      }

      log.info(
        { event: "platform.organization.created", organizationId, actorUserId, ownerUserId: invited.member.userId },
        "Organisation created",
      );

      return {
        organization: toAdministeredOrganization(organization),
        owner: invited.member,
        accountCreated: invited.accountCreated,
      };
    },

    async updateStatus(organizationId, status, log: AuthLogger = logger) {
      if (!OBJECT_ID_PATTERN.test(organizationId)) throw new NotFoundError("Organisation not found");

      const organization = await organizationRepository.updateStatus(organizationId, status);
      if (organization === null) throw new NotFoundError("Organisation not found");

      log.info({ event: "platform.organization.status_changed", organizationId, status }, "Organisation status changed");
      return toAdministeredOrganization(organization);
    },

    async inviteMember(organizationId, input, actorUserId, log: AuthLogger = logger) {
      if (!OBJECT_ID_PATTERN.test(organizationId)) throw new NotFoundError("Organisation not found");

      return staffInvitationService.invite(
        { organizationId, name: input.name, email: input.email, role: input.role, invitedByUserId: actorUserId },
        log,
      );
    },
  };
}
