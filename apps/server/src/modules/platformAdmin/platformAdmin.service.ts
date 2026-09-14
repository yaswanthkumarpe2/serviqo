import { logger } from "../../lib/logger";
import { buildWidgetUrl } from "../organizations/widgetLink";
import { userRepository } from "../users/user.repository";
import { platformAdminRepository } from "./platformAdmin.repository";

import type { OrganizationStatus } from "../organizations/organization.model";
import type { PlatformRole, StoredUserKind, UserStatus } from "../users/user.model";
import type { AuthLogger } from "../auth/authLogging";
import type {
  PlatformConversationBreakdown,
  PlatformTotals,
  PlatformUserBreakdown,
} from "./platformAdmin.repository";

/**
 * What the operations console is told (ADR-032 §8).
 *
 * Every field below is a COUNT, a status, or an administrative identifier.
 * Nothing here is the content of a support conversation: not a message body,
 * not a customer's name, not a visitor's page URL. That is the line ADR-032
 * draws and it is drawn in the data model rather than in the UI, because a
 * console that merely declines to render something still transported it.
 *
 * The staff EMAIL addresses are the one piece of personal data present, and
 * they are here because the console's whole job is answering "which account is
 * this" — an operator looking at a stuck sign-up needs to recognise the
 * address, and a list of opaque ids cannot be acted on.
 */

/** How many rows a listing returns. Deliberately small — see §9. */
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

export interface PlatformOverview {
  totals: PlatformTotals;
  users: PlatformUserBreakdown;
  conversations: PlatformConversationBreakdown;
}

/** One tenant, as an operator sees it. */
export interface PlatformOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  /** The organisation's customer chat link (ADR-038, ADR-039 §2). */
  widgetUrl: string;
  status: OrganizationStatus;
  /**
   * Whether this tenant can actually receive widget traffic.
   *
   * Two independent facts, reported separately because they fail separately:
   * a tenant with no `widgetKey` is unreachable, and a tenant with a key but
   * no allowed origins is reachable by nobody — the safe-by-default empty
   * state ADR-019 §10 chose. Collapsing them into one "installed" boolean
   * would hide which of the two an operator needs to fix.
   */
  hasWidgetKey: boolean;
  allowedOriginCount: number;
  memberCount: number;
  conversationCount: number;
  /** Null when the owning membership is missing — see §10; a real state, not an error. */
  owner: { id: string; name: string; email: string } | null;
  createdAt: Date;
}

/** One staff account, as an operator sees it. */
export interface PlatformUserSummary {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  /** Null means the address was never confirmed — the state that blocks sign-in. */
  emailVerifiedAt: Date | null;
  platformRole: PlatformRole;
  // Stored, not staff-only: the console lists every account, including any legacy
  // customer accounts ADR-034 created before ADR-037 removed them.
  kind: StoredUserKind;
  membershipCount: number;
  createdAt: Date;
}

export interface PlatformOrganizationList {
  organizations: PlatformOrganizationSummary[];
  /** How many exist in total, so a truncated list can say what it is hiding. */
  total: number;
}

export interface PlatformUserList {
  users: PlatformUserSummary[];
  total: number;
}

export interface PlatformAdminService {
  getOverview(log?: AuthLogger): Promise<PlatformOverview>;
  listOrganizations(limit: number | undefined, log?: AuthLogger): Promise<PlatformOrganizationList>;
  listUsers(limit: number | undefined, log?: AuthLogger): Promise<PlatformUserList>;
}

/**
 * Clamps a caller-supplied page size into the range this service will serve.
 *
 * A limit is a hint, not an instruction. Honouring `?limit=100000` would let
 * an authenticated admin turn a console into a full table scan by editing a
 * URL, and refusing it with a validation error would be a worse answer than
 * simply serving the largest page that is sensible.
 */
function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_LIST_LIMIT);
}

export function createPlatformAdminService(): PlatformAdminService {
  return {
    async getOverview(log: AuthLogger = logger): Promise<PlatformOverview> {
      const [totals, users, conversations] = await Promise.all([
        platformAdminRepository.countTotals(),
        platformAdminRepository.countUserBreakdown(),
        platformAdminRepository.countConversationBreakdown(),
      ]);

      /*
        The shape of the answer is logged, never the answer. "An admin read
        the overview" is the auditable fact; the tenant count is not worth
        putting in every log line, and the breakdowns are business data that
        would then live in two places with two retention policies.
      */
      log.info({ event: "platform.overview.read" }, "Platform overview served");

      return { totals, users, conversations };
    },

    async listOrganizations(limit: number | undefined, log: AuthLogger = logger): Promise<PlatformOrganizationList> {
      const pageSize = clampLimit(limit);

      const [organizations, total] = await Promise.all([
        platformAdminRepository.listRecentOrganizations(pageSize),
        platformAdminRepository.countTotals().then((totals) => totals.organizations),
      ]);

      const organizationIds = organizations.map((organization) => organization._id);

      /*
        Three bulk lookups for the whole page rather than three per row. The
        owner resolution is two steps — memberships name a `userId`, and the
        name and address live on `User` — because ownership is a fact about a
        membership and never a column on the organization (ADR-010 §3).
      */
      const [memberCounts, conversationCounts, ownerIds] = await Promise.all([
        platformAdminRepository.countActiveMembersByOrganization(organizationIds),
        platformAdminRepository.countConversationsByOrganization(organizationIds),
        platformAdminRepository.findOwnerUserIdsByOrganization(organizationIds),
      ]);

      const owners = await userRepository.findByIds([...ownerIds.values()]);

      const summaries = organizations.map((organization) => {
        const id = organization._id.toString();
        const ownerId = ownerIds.get(id);
        const owner = ownerId === undefined ? undefined : owners.get(ownerId.toString());

        return {
          id,
          name: organization.name,
          slug: organization.slug,
          widgetUrl: buildWidgetUrl(organization.slug),
          status: organization.status,
          hasWidgetKey: organization.widgetKey !== null,
          allowedOriginCount: organization.allowedOrigins.length,
          memberCount: memberCounts.get(id) ?? 0,
          conversationCount: conversationCounts.get(id) ?? 0,
          /*
            Null is reachable and is NOT an error: ADR-016 §3 accepts an
            organization whose owning membership write failed, and ADR-028's
            transfer moves ownership between two documents. A console that
            threw here would be unable to show an operator the exact record
            they were called in to repair.
          */
          owner:
            owner === undefined ? null : { id: owner._id.toString(), name: owner.name, email: owner.email },
          createdAt: organization.createdAt,
        } satisfies PlatformOrganizationSummary;
      });

      log.info({ event: "platform.organizations.read", returned: summaries.length }, "Platform tenant list served");

      return { organizations: summaries, total };
    },

    async listUsers(limit: number | undefined, log: AuthLogger = logger): Promise<PlatformUserList> {
      const pageSize = clampLimit(limit);

      const [users, total] = await Promise.all([
        platformAdminRepository.listRecentUsers(pageSize),
        platformAdminRepository.countTotals().then((totals) => totals.users),
      ]);

      const membershipCounts = await platformAdminRepository.countActiveMembershipsByUser(
        users.map((user) => user._id),
      );

      const summaries = users.map((user) => {
        const id = user._id.toString();

        return {
          id,
          name: user.name,
          email: user.email,
          status: user.status,
          emailVerifiedAt: user.emailVerifiedAt,
          platformRole: user.platformRole,
          kind: user.kind,
          membershipCount: membershipCounts.get(id) ?? 0,
          createdAt: user.createdAt,
        } satisfies PlatformUserSummary;
      });

      /*
        The count reaches the log; the addresses do not. The same rule
        `currentUser.service.ts` applies to memberships — an operator
        debugging a slow console needs to know how many rows were served, and
        putting the whole staff directory in the log on every page load would
        copy personal data into a second system for no benefit.
      */
      log.info({ event: "platform.users.read", returned: summaries.length }, "Platform account list served");

      return { users: summaries, total };
    },
  };
}
