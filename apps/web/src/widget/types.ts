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
  /** Optional, like the two above (ADR-038 §5). */
  phone: string | null;
}

/** The full success payload of `POST /api/v1/widget/session`. */
export interface WidgetSessionResult {
  token: string;
  expiresInSeconds: number;
  customer: WidgetSessionCustomer;
  /**
   * The long-lived visitor key, present only on the response that minted it
   * (ADR-038 §3). The widget stores it and offers it on every later session,
   * which is how a returning visitor finds their conversation after the
   * one-day token has expired.
   */
  visitorKey?: string;
}

/** Resolved once at startup from the `<script>` tag that loaded this file (ADR-021 §4). */
export interface WidgetConfig {
  widgetKey: string;
  /** `origin/api/v1/widget` — derived from the script's own `src`, never hardcoded. */
  apiBase: string;
  /**
   * The bare origin the socket connects to (ADR-024 §3), derived from the
   * same script `src` as `apiBase`. Socket.IO attaches at the server root
   * (`/socket.io/`), not under the widget's REST prefix, so it needs the
   * origin without the `/api/v1/widget` path — kept as its own resolved
   * field rather than re-derived by string-trimming `apiBase` at the call
   * site, which is how the two would drift apart.
   */
  socketOrigin: string;
}

/**
 * One message as `GET /widget/conversations/:id/messages` and the socket's
 * `message:new` both return it (ADR-022 §13) — the identical shape from both
 * transports, which is what lets one render path and one de-duplication rule
 * serve both (ADR-024 §4).
 */
export interface WidgetMessage {
  id: string;
  conversationId: string;
  senderType: "customer" | "agent";
  body: string;
  createdAt: string;
}

/** What `POST /widget/conversations` returns (ADR-022 §13). */
export interface WidgetConversation {
  id: string;
  status: "open" | "closed";
  createdAt: string;
  lastMessageAt: string;
}

/** One page of history (ADR-022 §11, §13). */
export interface WidgetMessagePage {
  messages: WidgetMessage[];
  nextCursor: string | null;
}
