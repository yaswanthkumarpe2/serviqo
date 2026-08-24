import { Router } from "express";

import { validateBody } from "../../middleware/validate";
import { createWidgetController } from "./widget.controller";
import { widgetCorsHeaders, widgetPreflight } from "./widgetCors";
import { createWidgetSessionSchema } from "./widget.validation";
import { createWidgetSessionService } from "./widgetSession.service";

import type { RateLimiters } from "../../lib/rateLimit";

/**
 * The customer-facing route namespace ADR-010 §5 reserved eleven slices ago:
 *
 *   A separate route namespace is reserved for customer-facing traffic
 *   (`/api/v1/widget/*` or `/api/v1/public/*`, chosen when that slice
 *   arrives). Customer traffic never appears under `/api/v1/auth`.
 *
 * This is that slice, and `/api/v1/widget` is the choice. Nothing here mounts
 * `requireAccessToken`, `requireOrganization`, or `requirePermission` — not
 * because it was forgotten, but because a customer holds no staff credential,
 * belongs to no organization as a member, and has no role (ADR-010 §1–2). The
 * absence of those three middlewares is the point, and it is why the tenant
 * is resolved from the widget key inside the service instead.
 */
export interface WidgetRouterDependencies {
  rateLimiters: RateLimiters;
}

export function createWidgetRouter({ rateLimiters }: WidgetRouterDependencies): Router {
  const router = Router();

  const controller = createWidgetController({
    sessionService: createWidgetSessionService(),
  });

  /*
    Minimal per-route CORS (ADR-021 §5), mounted before everything else in
    this router so every response it produces — success, refusal, or
    preflight — carries the same headers. Scoped to this router only: the
    rest of the API keeps the `same-origin` posture `securityHeaders.ts`
    already sets.
  */
  router.use(widgetCorsHeaders);
  router.options("/session", widgetPreflight);

  /*
    Serviqo's first public, unauthenticated WRITE.

    The `widgetSession` limiter class (ADR-019 §11), keyed by IP because there
    is no verified principal to key on and never by `widgetKey` — a per-key
    counter would make one busy tenant's own visitors a shared outage, and
    would hand anyone who read that tenant's page source a denial-of-service
    tool aimed at it.

    Mounted BEFORE `validateBody`, matching `auth.routes.ts`: a limiter behind
    validation spends a Zod parse per attempt, and — more importantly — lets a
    refused caller learn from the difference in responses whether their body
    was well-formed, which is a distinction a refused caller should not get.

    The `global` per-IP bound in `api.routes.ts` applies here as well, since
    this sits under `/api/v1`. The security gate is not bypassed.
  */
  router.post("/session", rateLimiters.widgetSession, validateBody(createWidgetSessionSchema), controller.createSession);

  return router;
}
