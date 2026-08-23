import { created } from "../../lib/response";

import type { CreateWidgetSessionInput } from "./widget.validation";
import type { WidgetSessionService } from "./widgetSession.service";
import type { RequestHandler } from "express";

export interface WidgetControllerDependencies {
  sessionService: WidgetSessionService;
}

/**
 * Translates request → service → response, and nothing else — the contract
 * `auth.controller.ts` and `organization.controller.ts` both follow.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error into
 * a response.
 */
export function createWidgetController({ sessionService }: WidgetControllerDependencies) {
  /**
   * Opens a widget session for an anonymous website visitor (ADR-019 §6).
   *
   * Serviqo's first PUBLIC write endpoint. There is no `req.principal` to
   * read and no `req.organizationContext` — by design, since a customer never
   * authenticates (ADR-010 §1) — so this handler reads exactly two things:
   * the validated body, and the `Origin` header.
   *
   * `req.body` is safe to assert: `validateBody` replaced it with the
   * schema's output before this could run, which also means an
   * `organizationId`, `customerId`, `userId`, or `role` a client tried to
   * send was STRIPPED rather than rejected, and cannot reach the service at
   * all (ADR-019 §12).
   *
   * The `Origin` header is passed as data, never as an identity. The service
   * compares it against a list belonging to a tenant the widget key already
   * resolved; nothing looks anything up by it.
   *
   * 201 rather than 200: a session — and usually a `Customer` — is created,
   * and `created()` is the envelope helper that exists for exactly that.
   */
  const createSession: RequestHandler = async (req, res) => {
    const result = await sessionService.createSession(
      req.body as CreateWidgetSessionInput,
      { origin: req.get("origin") },
      req.log,
    );

    created(res, result);
  };

  return { createSession };
}
