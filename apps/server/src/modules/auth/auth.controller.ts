import { created } from "../../lib/response";

import type { RegisterInput } from "./auth.validation";
import type { RegistrationService } from "./registration.service";
import type { RequestHandler } from "express";

export interface AuthControllerDependencies {
  registrationService: RegistrationService;
}

/**
 * Translates request → service → response, and nothing else. No validation
 * (the route's `validateBody` already ran), no persistence, no email.
 *
 * Errors are not caught here: Express 5 forwards a rejected handler promise
 * to the error middleware, which is the single place that turns an error
 * into a response.
 */
export function createAuthController({ registrationService }: AuthControllerDependencies) {
  const register: RequestHandler = async (req, res) => {
    // Safe to assert: validateBody replaced req.body with this schema's
    // parsed output before this handler could run.
    const user = await registrationService.register(req.body as RegisterInput, req.log);
    created(res, { user });
  };

  return { register };
}
