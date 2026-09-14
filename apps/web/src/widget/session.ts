import type { WidgetSessionResult } from "./types";

/**
 * The widget's client for `POST /api/v1/widget/session` (ADR-019, ADR-021 §5).
 *
 * A genuine cross-origin call from wherever this bundle is embedded to
 * wherever the API lives — closed for reading by ADR-021 §5's minimal CORS
 * headers, not by anything this file does. `credentials` is deliberately
 * left at its default ("same-origin"): this endpoint uses no cookie, and
 * asking for credentialed CORS here would be the one combination ADR-021 §5
 * specifically declined to enable.
 */

export interface OpenSessionInput {
  widgetKey: string;
  visitorToken?: string;
  /** The long-lived key, offered so an expired token still resumes (ADR-038 §3). */
  visitorKey?: string;
  name?: string;
  email?: string;
  phone?: string;
}

/**
 * Raised for every failure — refused, malformed, or a transport error never
 * reaching the server. One message, matching `WIDGET_SESSION_REFUSED`'s own
 * refusal posture (ADR-019 §12): the widget has no server-described reason
 * to relay even if it wanted to, since the response body never carries one.
 */
export class WidgetSessionError extends Error {}

const GENERIC_ERROR_MESSAGE = "Chat is not available right now.";

interface SuccessEnvelope {
  success: true;
  data: unknown;
}

function isSuccessEnvelope(body: unknown): body is SuccessEnvelope {
  return typeof body === "object" && body !== null && (body as { success?: unknown }).success === true;
}

function isWidgetSessionResult(value: unknown): value is WidgetSessionResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WidgetSessionResult>;
  if (typeof candidate.token !== "string" || typeof candidate.expiresInSeconds !== "number") return false;
  if (candidate.visitorKey !== undefined && typeof candidate.visitorKey !== "string") return false;
  const customer = candidate.customer;
  if (typeof customer !== "object" || customer === null) return false;
  const c = customer as Partial<WidgetSessionResult["customer"]>;
  return (
    typeof c.id === "string" &&
    (c.name === null || typeof c.name === "string") &&
    (c.email === null || typeof c.email === "string") &&
    // Tolerated as absent: a server from before ADR-038 does not send it.
    (c.phone === undefined || c.phone === null || typeof c.phone === "string")
  );
}

/**
 * Opens or resumes a widget session. Resolves with the minimal payload
 * ADR-019 §12 defines, or rejects with `WidgetSessionError` for every other
 * outcome — network failure, a non-2xx status, or a body that does not
 * parse as the expected shape.
 */
export async function openWidgetSession(apiBase: string, input: OpenSessionInput): Promise<WidgetSessionResult> {
  let response: Response;

  try {
    response = await fetch(`${apiBase}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    // The underlying error is not attached or logged — it can name internal
    // hosts, and it tells a visitor nothing actionable (ADR-021 §6).
    throw new WidgetSessionError(GENERIC_ERROR_MESSAGE);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || !isSuccessEnvelope(body) || !isWidgetSessionResult(body.data)) {
    throw new WidgetSessionError(GENERIC_ERROR_MESSAGE);
  }

  // Normalised so the rest of the widget can rely on the field existing.
  return { ...body.data, customer: { ...body.data.customer, phone: body.data.customer.phone ?? null } };
}
