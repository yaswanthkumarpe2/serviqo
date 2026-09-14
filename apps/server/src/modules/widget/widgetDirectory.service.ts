import { NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { normalizeSlug } from "../organizations/organization.model";
import { organizationRepository } from "../organizations/organization.repository";
import { isWellFormedSlug } from "../organizations/organizationSlug";
import { toPublicChatSettings } from "../organizations/widgetAppearance";
import { agentPresence } from "../../realtime/presence";

import type { AuthLogger } from "../auth/authLogging";

/**
 * Resolves an organisation's chat link to what its hosted page needs
 * (ADR-038 §2).
 *
 * `/widget/centralservice` is a page, and the page has to find out which
 * organisation that is and which widget key opens a session with it. This is
 * that lookup, and it answers exactly two things: the name to show at the top
 * of the chat, and the widget key.
 *
 * Neither is a secret. The widget key is designed to be public — it sits in
 * every embedding page's source (ADR-019 §9) — and the name is what the
 * organisation calls itself to its customers. What this deliberately does NOT
 * return is the organisation's id, its status, its origins, or anything about
 * its staff.
 *
 * One slug at a time, and there is no listing. Somebody can still try slugs to
 * learn which organisations exist; that is bounded by the `widgetDirectory`
 * limiter, and an organisation that wanted to be unfindable would not be
 * handing its customers a link.
 */

export interface WidgetDirectoryEntry extends ReturnType<typeof toPublicChatSettings> {
  name: string;
  widgetKey: string;
}

export interface WidgetDirectoryService {
  resolve(slug: string, log?: AuthLogger): Promise<WidgetDirectoryEntry>;
}

/** One message for unknown, malformed and suspended alike. */
const NOT_AVAILABLE_MESSAGE = "This chat is not available.";

export function createWidgetDirectoryService(): WidgetDirectoryService {
  return {
    async resolve(rawSlug, log: AuthLogger = logger) {
      const slug = normalizeSlug(rawSlug);

      /*
        Shape first, so a malformed value never reaches a query. Refused with
        the same 404 as an unknown slug: the difference would say nothing useful
        to a customer and something to a prober.
      */
      if (!isWellFormedSlug(slug)) {
        throw new NotFoundError(NOT_AVAILABLE_MESSAGE);
      }

      const organization = await organizationRepository.findBySlug(slug);

      /*
        A suspended organisation's link says "not available" exactly as an
        unknown one does. Suspension already refuses its widget session; this
        stops the page showing a chat that cannot open.
      */
      if (organization === null || organization.status !== "active") {
        log.info(
          { event: "widget.directory.not_found", reason: organization === null ? "unknown_slug" : "not_active" },
          "Chat link did not resolve",
        );
        throw new NotFoundError(NOT_AVAILABLE_MESSAGE);
      }

      /*
        Organisations created before widget keys existed have none until
        something asks (ADR-020 §2). A customer opening the link is exactly
        that ask, and the mint happens at most once.
      */
      const withKey = await organizationRepository.ensureWidgetKey(organization._id.toString());
      if (withKey === null || withKey.widgetKey === null) {
        throw new NotFoundError(NOT_AVAILABLE_MESSAGE);
      }

      return {
        name: withKey.name,
        widgetKey: withKey.widgetKey,
        // How the chat looks and whether anyone is there (ADR-040 §1–2).
        ...toPublicChatSettings(withKey, agentPresence.isOnline(withKey._id.toString())),
      };
    },
  };
}
