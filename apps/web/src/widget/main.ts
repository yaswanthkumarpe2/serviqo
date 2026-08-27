import { resolveWidgetConfig } from "./config";
import { initWidget } from "./widget";

/**
 * Bundle entry point (ADR-021). Everything this file does runs at script
 * load, on a page Serviqo does not control — so it does the minimum: guard
 * against a duplicate mount, resolve configuration, and mount once.
 */

const MOUNTED_ATTRIBUTE = "data-serviqo-widget-mounted";

/**
 * Exported so a test can call it directly and more than once — the module
 * itself is only ever imported once by a real page, so the top-level guard
 * below is what production actually relies on; this export exists purely so
 * the idempotency it provides is verifiable (ADR-021 §9).
 */
export function bootstrap() {
  if (document.body.hasAttribute(MOUNTED_ATTRIBUTE)) return;

  const config = resolveWidgetConfig();
  if (config === null) return;

  const handle = initWidget(config);
  if (handle === null) return;

  document.body.setAttribute(MOUNTED_ATTRIBUTE, "true");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
