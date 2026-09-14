import { OrganizationNotAccessibleError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { organizationRepository } from "./organization.repository";
import { appearanceOf } from "./widgetAppearance";
import { buildWidgetUrl } from "./widgetLink";

import type { WidgetAppearance } from "./widgetAppearance";

import type { AuthLogger } from "../auth/authLogging";
import type { OrganizationDocument } from "./organization.model";

/**
 * Widget installation settings for one organization (ADR-020) — the staff
 * surface ADR-019 §14 deferred: reading the widget key, replacing the
 * allowed-origin list, and rotating the key.
 *
 * `AuthLogger` is imported from the auth module rather than duplicated,
 * following `organizationOnboarding.service.ts` and `widgetSession.service.ts`
 * — the name is wrong for a third domain and moves to `lib/` when a fourth
 * one needs it (ADR-016 §9).
 */

/** What a staff member is allowed to see and change. Never the JWT secret, never a token. */
export interface WidgetSettings {
  widgetKey: string;
  allowedOrigins: string[];
  /** The organisation's hosted chat link (ADR-038 §1), beside the embed settings. */
  widgetUrl: string;
  /** Colour, title, messages and business hours (ADR-040 §1). */
  appearance: WidgetAppearance;
}

/** Who is acting. Comes from the verified access token, never from the body. */
export interface WidgetSettingsActor {
  userId: string;
}

export interface WidgetSettingsService {
  getSettings(organizationId: string): Promise<WidgetSettings>;
  replaceAllowedOrigins(
    organizationId: string,
    allowedOrigins: string[],
    actor: WidgetSettingsActor,
    log?: AuthLogger,
  ): Promise<WidgetSettings>;
  rotateWidgetKey(organizationId: string, actor: WidgetSettingsActor, log?: AuthLogger): Promise<WidgetSettings>;
  updateAppearance(
    organizationId: string,
    appearance: WidgetAppearance,
    actor: WidgetSettingsActor,
    log?: AuthLogger,
  ): Promise<WidgetSettings>;
}

/**
 * Projects the organization document down to the two fields this surface
 * owns. `widgetKey` is asserted non-null: every repository method behind
 * this service either loads an organization that already has one or mints
 * one in the same write, so by the time a document reaches here the
 * invariant already holds.
 */
function toWidgetSettings(organization: OrganizationDocument): WidgetSettings {
  return {
    widgetKey: organization.widgetKey!,
    allowedOrigins: organization.allowedOrigins,
    widgetUrl: buildWidgetUrl(organization.slug),
    appearance: appearanceOf(organization.widgetAppearance),
  };
}

export function createWidgetSettingsService(): WidgetSettingsService {
  return {
    /**
     * Reads the widget key and allowed origins, minting a key first if this
     * organization predates Slice 20 (ADR-020 §2).
     *
     * `organizationId` is trusted here: the caller is `requireOrganization`'s
     * `req.organizationContext`, already proved to exist and be active. A
     * `null` result would mean the organization was deleted in the
     * microseconds between that check and this one — nothing deletes
     * organizations today, so this mirrors `organization.controller.ts`'s
     * own `read` handler in treating that as the same refusal a caller who
     * never had access would see, rather than a 500.
     */
    async getSettings(organizationId) {
      const organization = await organizationRepository.ensureWidgetKey(organizationId);
      if (organization === null) {
        throw new OrganizationNotAccessibleError("Organization not found");
      }
      return toWidgetSettings(organization);
    },

    /**
     * Replaces the allowed-origins list (ADR-020 §3, §4).
     *
     * `allowedOrigins` arrives already normalized and duplicate-checked by
     * `replaceAllowedOriginsSchema` — this service trusts that shape and does
     * not re-derive it, the same boundary-does-the-work contract every other
     * service in this codebase relies on `validateBody` for.
     */
    async replaceAllowedOrigins(organizationId, allowedOrigins, actor, log = logger) {
      const organization = await organizationRepository.replaceAllowedOrigins(organizationId, allowedOrigins);
      if (organization === null) {
        throw new OrganizationNotAccessibleError("Organization not found");
      }

      /*
        Safe fields only (ADR-020 §7): an event name, the organization id,
        the acting user id, and a count. Never the origins themselves — they
        are tenant configuration, not secret, and the narrower default costs
        nothing here.
      */
      log.info(
        {
          event: "organization.allowed_origins_updated",
          organizationId,
          userId: actor.userId,
          originCount: allowedOrigins.length,
        },
        "Allowed origins updated",
      );

      return toWidgetSettings(organization);
    },

    /**
     * Rotates the widget key (ADR-020 §5). The old value stops resolving
     * through `findByWidgetKey` from the moment this write commits — there is
     * no separate revocation step because there is no separate list.
     */
    async updateAppearance(organizationId, appearance, actor, log = logger) {
      const organization = await organizationRepository.updateWidgetAppearance(organizationId, appearance);
      if (organization === null) {
        throw new OrganizationNotAccessibleError("Organization not found");
      }
      log.info(
        { event: "organization.widget_appearance_updated", organizationId, userId: actor.userId },
        "Widget appearance updated",
      );
      return toWidgetSettings(organization);
    },

    async rotateWidgetKey(organizationId, actor, log = logger) {
      const organization = await organizationRepository.rotateWidgetKey(organizationId);
      if (organization === null) {
        throw new OrganizationNotAccessibleError("Organization not found");
      }

      // The key itself — old or new — never reaches a log line (ADR-020 §7).
      log.info(
        { event: "organization.widget_key_rotated", organizationId, userId: actor.userId },
        "Widget key rotated",
      );

      return toWidgetSettings(organization);
    },
  };
}
