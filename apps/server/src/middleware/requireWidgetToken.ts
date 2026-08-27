import { InvalidWidgetTokenError, WidgetSessionRefusedError } from "../lib/errors";
import { customerRepository } from "../modules/customers/customer.repository";
import { organizationRepository } from "../modules/organizations/organization.repository";
import { verifyWidgetToken } from "../modules/widget/widgetToken";

import type { RequestHandler } from "express";

/**
 * The customer-facing authentication AND tenant boundary, in one middleware
 * (ADR-022 §6) — the widget's answer to what `requireAccessToken` plus
 * `requireOrganization` together do for staff, fused because a widget token
 * has no separate "membership" to check: its own `org` claim and the
 * `Customer` it names are the entire relationship.
 *
 * A route declares it exactly like the staff pair:
 *
 *   router.post("/conversations", requireWidgetToken, rateLimiters...,  handler)
 */

/** RFC 6750 §2.1, the identical pattern `requireAccessToken` matches. */
const BEARER_PATTERN = /^Bearer (.+)$/i;

/**
 * One message for a bad credential. Reaches every response from this file's
 * first branch.
 *
 * Exported so `realtime/socketAuthentication.ts` (ADR-023 §3) can reject a
 * socket handshake with the identical wording rather than a second literal
 * that could drift from this one — the same instrument, not a duplicate.
 */
export const INVALID_TOKEN_MESSAGE = "Authentication required";

/** One message for a credential that verified but no longer names anything usable. Exported for the same reason as above. */
export const SESSION_REFUSED_MESSAGE = "This chat widget is not available.";

/** Why a request was refused. Reaches the log, never a response body. */
type RefusalReason =
  | "missing_header"
  | "malformed_header"
  | "invalid_token"
  | "organization_not_found"
  | "organization_not_active"
  | "customer_not_found";

/**
 * Reads the bearer widget token from `Authorization`, verifies it, confirms
 * the organization it names is still active and the customer it names still
 * exists inside that organization, and attaches `req.widgetPrincipal`.
 *
 * Two DIFFERENT refusals, deliberately (ADR-022 §6):
 *
 * - The credential itself is unusable (missing, malformed, bad signature,
 *   expired, wrong issuer/audience) → `401 INVALID_WIDGET_TOKEN`.
 * - The credential verifies, but what it names has stopped being valid
 *   (organization suspended or gone, customer record gone) →
 *   `403 WIDGET_SESSION_REFUSED`, REUSING the exact error
 *   `POST /widget/session` raises for the same underlying fact, so a
 *   suspended tenant refuses a widget request identically regardless of
 *   whether the caller presented a fresh `widgetKey` or an already-issued
 *   token.
 *
 * `Origin` is deliberately not consulted here — see ADR-022 §6 for why the
 * token, not the header, is this surface's authorization boundary.
 */
export const requireWidgetToken: RequestHandler = async (req, _res, next) => {
  function refuseInvalidToken(reason: RefusalReason): void {
    req.log.info({ event: "widget.token.rejected", reason }, "Request refused for want of a valid widget token");
    next(new InvalidWidgetTokenError(INVALID_TOKEN_MESSAGE));
  }

  function refuseSessionInvalid(reason: RefusalReason, organizationId: string): void {
    req.log.info(
      { event: "widget.token.session_invalid", reason, organizationId },
      "Widget token verified but no longer names a usable session",
    );
    next(new WidgetSessionRefusedError(SESSION_REFUSED_MESSAGE));
  }

  const header = req.get("authorization");
  if (header === undefined) {
    return refuseInvalidToken("missing_header");
  }

  const match = BEARER_PATTERN.exec(header);
  if (match === null) {
    return refuseInvalidToken("malformed_header");
  }

  /*
    Signature, issuer, audience, expiry, and claim shape — all inside the
    verifier, which returns null rather than distinguishing them
    (ADR-019 §8, ADR-015 §2's reasoning applied to the second credential
    format).
  */
  const principal = await verifyWidgetToken(match[1]!);
  if (principal === null) {
    return refuseInvalidToken("invalid_token");
  }

  const { customerId, organizationId } = principal;

  /*
    A widget token cannot be revoked before it expires (ADR-019 §14), so a
    tenant suspended AFTER a token was issued is only caught here — the
    identical re-check `requireOrganization` performs for staff on every
    request rather than trusting a stale credential.
  */
  const organization = await organizationRepository.findById(organizationId);
  if (organization === null) {
    return refuseSessionInvalid("organization_not_found", organizationId);
  }
  if (organization.status !== "active") {
    return refuseSessionInvalid("organization_not_active", organizationId);
  }

  /*
    Both ids in one query (ADR-019 §4) — a customer removed from this
    organization after the token was issued is inert here, the same
    property that makes tenant A's token inert in tenant B.
  */
  const customer = await customerRepository.findByIdAndOrganization(customerId, organizationId);
  if (customer === null) {
    return refuseSessionInvalid("customer_not_found", organizationId);
  }

  req.widgetPrincipal = { customerId, organizationId };
  next();
};
