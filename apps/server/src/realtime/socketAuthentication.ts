import { customerRepository } from "../modules/customers/customer.repository";
import { organizationRepository } from "../modules/organizations/organization.repository";
import { verifyWidgetToken } from "../modules/widget/widgetToken";

import type { WidgetPrincipal } from "../modules/widget/widgetToken";

/**
 * Socket handshake authentication (ADR-023 §3) — the widget token, verified
 * by the exact same primitives `requireWidgetToken.ts` uses for REST:
 * `verifyWidgetToken`, `organizationRepository.findById`,
 * `customerRepository.findByIdAndOrganization`. The orchestration below is
 * intentionally NOT shared with that file (different control-flow model,
 * different tested surface — see ADR-023 §3); every primitive that actually
 * touches the database or a credential IS shared, so nothing here duplicates
 * verification or persistence logic.
 */

/** Why a handshake was refused. Reaches the log and never the client (ADR-023 §3, mirroring ADR-022 §6). */
export type SocketAuthReason =
  | "missing_token"
  | "invalid_token"
  | "organization_not_found"
  | "organization_not_active"
  | "customer_not_found";

export type SocketAuthOutcome =
  | { ok: true; principal: WidgetPrincipal }
  | { ok: false; kind: "invalid_token"; reason: SocketAuthReason }
  | { ok: false; kind: "session_refused"; reason: SocketAuthReason; organizationId: string };

/**
 * Resolves a widget token to the principal it names, or the reason it does
 * not, in one call so a later edit cannot skip a check — the same posture
 * `verifyWidgetToken` itself documents.
 */
export async function authenticateSocketToken(token: unknown): Promise<SocketAuthOutcome> {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, kind: "invalid_token", reason: "missing_token" };
  }

  const principal = await verifyWidgetToken(token);
  if (principal === null) {
    return { ok: false, kind: "invalid_token", reason: "invalid_token" };
  }

  const { customerId, organizationId } = principal;

  /*
    A widget token cannot be revoked before it expires (ADR-019 §14), so a
    tenant suspended AFTER a token was issued is only caught here — the
    identical re-check `requireWidgetToken` performs for REST on every
    request, applied once at handshake time for a socket connection.
  */
  const organization = await organizationRepository.findById(organizationId);
  if (organization === null) {
    return { ok: false, kind: "session_refused", reason: "organization_not_found", organizationId };
  }
  if (organization.status !== "active") {
    return { ok: false, kind: "session_refused", reason: "organization_not_active", organizationId };
  }

  const customer = await customerRepository.findByIdAndOrganization(customerId, organizationId);
  if (customer === null) {
    return { ok: false, kind: "session_refused", reason: "customer_not_found", organizationId };
  }

  return { ok: true, principal: { customerId, organizationId } };
}
