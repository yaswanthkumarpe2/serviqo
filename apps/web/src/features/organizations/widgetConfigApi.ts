import { AuthApiError, NETWORK_ERROR, unwrapEnvelope } from "@/features/auth/authApi";

/**
 * Client for the widget installation endpoints (ADR-020).
 *
 * The envelope reader and its error type come from the auth feature, the
 * same reuse `organizationsApi.ts` already established — one definition of
 * what a Serviqo response looks like, not a second one per feature folder.
 */

const ORGANIZATIONS_BASE = "/api/v1/organizations";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

/** The two fields this surface owns. Never a secret, never a JWT. */
export interface BusinessDay {
  open: string;
  close: string;
}

/** How the customer chat looks and when it is open (ADR-040 §1). */
export interface WidgetAppearance {
  accentColor: string;
  title: string | null;
  welcomeMessage: string | null;
  awayMessage: string | null;
  businessHours: {
    enabled: boolean;
    timezone: string;
    /** Sunday first; `null` is closed all day. */
    days: (BusinessDay | null)[];
  };
}

export interface WidgetSettings {
  widgetKey: string;
  allowedOrigins: string[];
  widgetUrl?: string;
  appearance?: WidgetAppearance;
}

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

function widgetConfigPath(organizationId: string, suffix = ""): string {
  return `${ORGANIZATIONS_BASE}/${encodeURIComponent(organizationId)}/widget-config${suffix}`;
}

async function callWidgetConfig(
  authorizedFetch: AuthorizedFetch,
  path: string,
  init?: RequestInit,
): Promise<WidgetSettings> {
  let response: Response;

  try {
    response = await authorizedFetch(path, init);
  } catch (error) {
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<WidgetSettings>(response);
}

/**
 * Reads the current widget key and allowed origins (ADR-020 §2).
 *
 * Behind `organization.manage`, not `organization.read` — a caller without
 * the permission receives a 403 here, which the caller renders rather than
 * treating as a transport failure.
 */
export function fetchWidgetSettings(authorizedFetch: AuthorizedFetch, organizationId: string): Promise<WidgetSettings> {
  return callWidgetConfig(authorizedFetch, widgetConfigPath(organizationId));
}

/**
 * Replaces the full allowed-origins list (ADR-020 §3).
 *
 * There is no add/remove call: the caller computes the next array locally
 * and sends it whole, matching what `replaceAllowedOriginsSchema` expects on
 * the server.
 */
export function replaceAllowedOrigins(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  allowedOrigins: string[],
): Promise<WidgetSettings> {
  return callWidgetConfig(authorizedFetch, widgetConfigPath(organizationId, "/origins"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowedOrigins }),
  });
}

/**
 * Rotates the widget key (ADR-020 §5). The old key stops working immediately
 * — there is nothing further to confirm and nothing to poll.
 */
export function rotateWidgetKey(authorizedFetch: AuthorizedFetch, organizationId: string): Promise<WidgetSettings> {
  return callWidgetConfig(authorizedFetch, widgetConfigPath(organizationId, "/rotate-key"), { method: "POST" });
}

/** Replaces the chat's appearance and business hours (ADR-040 §1). Behind `organization.manage`. */
export function updateWidgetAppearance(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  appearance: WidgetAppearance,
): Promise<WidgetSettings> {
  return callWidgetConfig(authorizedFetch, widgetConfigPath(organizationId, "/appearance"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appearance),
  });
}
