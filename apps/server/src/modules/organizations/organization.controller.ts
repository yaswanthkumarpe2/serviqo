import { success } from "../../lib/response";
import { InsufficientPermissionError, OrganizationNotAccessibleError } from "../../lib/errors";
import { organizationRepository } from "./organization.repository";
import { buildWidgetUrl } from "./widgetLink";

import type { ReplaceAllowedOriginsInput, WidgetAppearanceInput } from "./organization.validation";
import type { TransferOwnershipInput } from "./ownership.validation";
import type { OwnershipTransferService } from "./ownershipTransfer.service";
import type { WidgetSettingsService } from "./widgetSettings.service";
import type { RequestHandler } from "express";

export interface OrganizationControllerDependencies {
  ownershipTransferService: OwnershipTransferService;
  widgetSettingsService: WidgetSettingsService;
}

/**
 * Translates request → service → response, and nothing else — the same
 * contract `auth.controller.ts` follows.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error into
 * a response.
 */
export function createOrganizationController({
  ownershipTransferService,
  widgetSettingsService,
}: OrganizationControllerDependencies) {
  /**
   * Reads the active organization and the caller's role in it (ADR-017 §8).
   *
   * The first consumer of `requireOrganization` and `requirePermission`. It
   * exists so this slice does not ship two security-critical middlewares that
   * nothing exercises — the failure mode `accessToken.ts` named when it
   * declined to write a verifier before its first caller.
   *
   * Everything this handler needs has already been proved: the organization
   * exists, is active, and the caller holds an active membership in it with a
   * role that grants `organization.read`. Nothing is re-derived here, and the
   * id used for the lookup comes from the context rather than from
   * `req.params` — the middleware validated one and the handler must not read
   * the other, or the two could diverge.
   */
  const read: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;

    const organization = await organizationRepository.findById(context.organizationId);

    /*
      Reachable only if the organization was deleted between the middleware's
      lookup and this one — microseconds, and nothing deletes organizations
      today. Answered with the same refusal rather than a 500, because a
      client that lost a race should see the same thing as one that never had
      access.
    */
    if (organization === null) {
      throw new OrganizationNotAccessibleError("Organization not found");
    }

    success(res, {
      organization: {
        id: organization._id.toString(),
        name: organization.name,
        slug: organization.slug,
        /*
          The customer chat link (ADR-038 §4). On the plain organisation read
          rather than only on widget-config, because every member — agents
          included, who hold `organization.read` but not `organization.manage`
          — needs to see and copy it.
        */
        widgetUrl: buildWidgetUrl(organization.slug),
        status: organization.status,
        createdAt: organization.createdAt,
      },
      // From the database via the middleware, never from the client.
      role: context.role,
      // True when a super admin is acting here without a membership (ADR-039 §5).
      viaPlatformAdmin: context.viaPlatformAdmin,
    });
  };

  /**
   * Reads the widget key and allowed origins (ADR-020 §2).
   *
   * Behind `organization.manage`, not `organization.read` — the route file
   * is where that choice is made, and this handler trusts it the same way
   * `read` above trusts `requireOrganization`'s prior proof of membership.
   */
  const getWidgetConfig: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;
    const settings = await widgetSettingsService.getSettings(context.organizationId);
    success(res, settings);
  };

  /**
   * Replaces the allowed-origins list (ADR-020 §3).
   *
   * `req.body` is safe to assert: `validateBody` already normalized and
   * duplicate-checked every entry against `replaceAllowedOriginsSchema`.
   */
  const updateAllowedOrigins: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;
    const { allowedOrigins } = req.body as ReplaceAllowedOriginsInput;

    const settings = await widgetSettingsService.replaceAllowedOrigins(
      context.organizationId,
      allowedOrigins,
      { userId: req.principal!.userId },
      req.log,
    );

    success(res, settings);
  };

  /**
   * Rotates the widget key (ADR-020 §5). The response carries the new key
   * and nothing about the old one.
   */
  const rotateWidgetKey: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;

    const settings = await widgetSettingsService.rotateWidgetKey(
      context.organizationId,
      { userId: req.principal!.userId },
      req.log,
    );

    success(res, settings);
  };

  /**
   * Transfers ownership of the organization (ADR-028 §1, §4).
   *
   * Note what this handler never reads: `req.body.organizationId`,
   * `req.body.currentOwnerId`, `req.body.userId`, `req.body.role`,
   * `req.body.status`, `req.query.organizationId`. The tenant comes from
   * `req.organizationContext`, which `requireOrganization` built from the path
   * segment after proving membership; the acting owner comes from
   * `req.principal` and from that same context's `membershipId` — the
   * membership document the middleware read from the database on THIS request.
   * The only client-supplied value in the whole operation is which member
   * receives ownership, and `transferOwnershipSchema` already proved it is a
   * well-formed id and stripped everything else (ADR-028 §4).
   *
   * `organizationContext.membershipId` is what makes "never trust a
   * client-supplied current owner id" structural rather than defensive: there
   * is no field to distrust, because the acting owner's membership is never
   * named by the request at all.
   *
   * 200 rather than 201: nothing is created. The response carries two
   * membership ids and two roles and nothing else (ADR-028 §15) — the client
   * refetches the roster and its organization context, which is what takes the
   * previous owner's owner-only controls away.
   */
  const transferOwnership: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;
    const { membershipId } = req.body as TransferOwnershipInput;

    // Only an owner transfers, and an owner is always a member. Unreachable
    // behind `requirePermission`, and refused here too rather than asserted.
    if (context.membershipId === null) {
      throw new InsufficientPermissionError("Only the organisation's owner can transfer ownership");
    }

    const result = await ownershipTransferService.transferOwnership(
      context.organizationId,
      membershipId,
      { userId: req.principal!.userId, membershipId: context.membershipId },
      req.log,
    );

    success(res, result);
  };

  /** Replaces the chat's appearance and business hours (ADR-040 §1). */
  const updateWidgetAppearance: RequestHandler = async (req, res) => {
    const context = req.organizationContext!;
    const settings = await widgetSettingsService.updateAppearance(
      context.organizationId,
      req.body as WidgetAppearanceInput,
      { userId: req.principal!.userId },
      req.log,
    );
    success(res, settings);
  };

  return { read, getWidgetConfig, updateAllowedOrigins, updateWidgetAppearance, rotateWidgetKey, transferOwnership };
}
