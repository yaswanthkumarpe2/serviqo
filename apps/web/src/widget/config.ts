import type { WidgetConfig } from "./types";

/**
 * Resolves the loader's configuration from its own `<script>` tag
 * (ADR-021 §4). The script element is the ONLY configuration surface: it
 * carries both the widget key and — via its own `src` — the API's origin.
 * There is no build-time environment variable and no second place either
 * value could be set.
 */

const WIDGET_KEY_ATTRIBUTE = "data-serviqo-widget-key";

/**
 * Finds the `<script>` element that loaded this bundle.
 *
 * `document.currentScript` is set correctly for a classic script during its
 * own synchronous execution, `async` or not — which is what the embed
 * snippet uses. The attribute-selector fallback exists only for the rare
 * host page whose own tooling clears `currentScript` before this runs; it
 * takes the LAST matching element, since a page that somehow includes the
 * snippet more than once should resolve to the one that actually executed
 * most recently.
 */
function findScriptElement(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement) return current;

  const candidates = document.querySelectorAll<HTMLScriptElement>(`script[${WIDGET_KEY_ATTRIBUTE}]`);
  return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

/**
 * Resolves the widget's configuration, or `null` if the embed is
 * misconfigured. Every failure here is a tenant's page-source mistake, not
 * something this widget can recover from — the caller's job is to fail
 * silently rather than render anything onto a page it does not own
 * (ADR-021 §4).
 */
export function resolveWidgetConfig(): WidgetConfig | null {
  const scriptEl = findScriptElement();
  if (scriptEl === null) {
    console.warn("Serviqo widget: could not find the <script> tag that loaded widget.js.");
    return null;
  }

  const widgetKey = scriptEl.getAttribute(WIDGET_KEY_ATTRIBUTE)?.trim();
  if (widgetKey === undefined || widgetKey.length === 0) {
    console.warn(`Serviqo widget: the <script> tag is missing its "${WIDGET_KEY_ATTRIBUTE}" attribute.`);
    return null;
  }

  const src = scriptEl.getAttribute("src");
  if (src === null || src.length === 0) {
    console.warn("Serviqo widget: the <script> tag has no src to resolve the API origin from.");
    return null;
  }

  let origin: string;
  try {
    // Resolved against the current document, matching how the browser
    // itself would resolve a relative `src` on this same script tag.
    origin = new URL(src, window.location.href).origin;
  } catch {
    console.warn("Serviqo widget: could not resolve the API origin from the widget script's src.");
    return null;
  }

  // `socketOrigin` is the same resolved origin: Socket.IO attaches at the
  // server root (`/socket.io/`), not under the REST prefix (ADR-024 §3).
  return { widgetKey, apiBase: `${origin}/api/v1/widget`, socketOrigin: origin };
}
