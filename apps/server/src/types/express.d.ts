import type { logger } from "../lib/logger";
import type { AccessTokenPrincipal } from "../modules/auth/accessToken";
import type { MembershipRole } from "../modules/memberships/membership.model";

/**
 * The active organization and the caller's standing in it, established by
 * `requireOrganization` (ADR-017 §5).
 *
 * `role` is read from the `Membership` document on this request. It is not a
 * token claim (ADR-011 §2), not session state (ADR-004 §8), and never
 * client-supplied — which is what makes a revoked role take effect
 * immediately rather than at token expiry.
 */
export interface OrganizationContext {
  organizationId: string;
  role: MembershipRole;
  membershipId: string;
}

/**
 * The verified widget caller, set by `requireWidgetToken` and by nothing
 * else (ADR-022 §6) — the customer-facing sibling of `principal` fused with
 * `organizationContext`, since a widget token carries both identities and
 * there is no separate "membership" to establish.
 */
export interface WidgetPrincipal {
  customerId: string;
  organizationId: string;
}

declare global {
  namespace Express {
    interface Request {
      log: typeof logger;
      /**
       * Who is calling, set by `requireAccessToken` and by nothing else.
       *
       * Optional because most routes have none: a route that needs a
       * principal mounts the middleware that establishes one, and TypeScript
       * stops a handler assuming it otherwise (ADR-015 consequences).
       */
      principal?: AccessTokenPrincipal;
      /**
       * Which tenant this request is about, set by `requireOrganization` and
       * by nothing else. Optional for the same reason `principal` is.
       */
      organizationContext?: OrganizationContext;
      /**
       * Who is calling on the customer-facing surface, set by
       * `requireWidgetToken` and by nothing else. Optional for the same
       * reason `principal` is — most routes have none.
       */
      widgetPrincipal?: WidgetPrincipal;
    }
  }
}

export {};
