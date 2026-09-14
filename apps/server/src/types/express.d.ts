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
 * The caller's PLATFORM standing, established by `requirePlatformAdmin`
 * (ADR-032 §4).
 *
 * Read from the `User` document on this request, exactly like
 * `OrganizationContext.role` is read from the `Membership` document — never a
 * token claim. A platform grant that is revoked in the database stops working
 * on the very next request rather than at token expiry, which is the property
 * that matters most for the most powerful role in the system.
 *
 * Deliberately separate from `organizationContext` rather than an extra field
 * on it. A platform admin's requests name no tenant, and folding platform
 * standing into a per-tenant context would invite a handler to read `role`
 * without noticing which of the two axes it was on.
 */
export interface PlatformContext {
  userId: string;
  /** Always `"admin"` — the middleware refuses every other value. */
  platformRole: "admin";
}

/**
 * The signed-in CUSTOMER, set by `requireCustomerAccount` and by nothing else
 * (ADR-034 §4).
 *
 * Deliberately the same shape as `WidgetPrincipal`: both answer "which
 * customer, in which tenant", and the services below take exactly that pair.
 * They are separate types because they are established by different proofs — a
 * widget token for an anonymous visitor, an access token plus a customer
 * account for a signed-in one — and a handler must never be able to read one
 * while believing it proved the other.
 */
export interface CustomerContext {
  customerId: string;
  organizationId: string;
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
       * The caller's platform standing, set by `requirePlatformAdmin` and by
       * nothing else. Optional for the same reason `principal` is, and with a
       * sharper consequence: a handler that finds this undefined is one no
       * platform check ever ran on.
       */
      platformContext?: PlatformContext;
      /**
       * Who is calling on the customer-facing surface, set by
       * `requireWidgetToken` and by nothing else. Optional for the same
       * reason `principal` is — most routes have none.
       */
      widgetPrincipal?: WidgetPrincipal;
      /**
       * Which customer is calling on the signed-in customer surface, set by
       * `requireCustomerAccount` and by nothing else. Optional for the same
       * reason `principal` is.
       */
      customerContext?: CustomerContext;
    }
  }
}

export {};
