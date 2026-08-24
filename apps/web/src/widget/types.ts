/**
 * Shared shapes for the widget bundle (ADR-021).
 *
 * Deliberately not imported from `@/features/*`: the widget shares no code
 * with the dashboard (ADR-021 §2), so its own copy of "what a session looks
 * like" lives here rather than being a second consumer of a dashboard type
 * that could drift out from under it.
 */

/** What `POST /api/v1/widget/session` names the caller as (ADR-019 §12). */
export interface WidgetSessionCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

/** The full success payload of `POST /api/v1/widget/session`. */
export interface WidgetSessionResult {
  token: string;
  expiresInSeconds: number;
  customer: WidgetSessionCustomer;
}

/** Resolved once at startup from the `<script>` tag that loaded this file (ADR-021 §4). */
export interface WidgetConfig {
  widgetKey: string;
  /** `origin/api/v1/widget` — derived from the script's own `src`, never hardcoded. */
  apiBase: string;
}
