import { env } from "../env";
import { createConsoleEmailProvider } from "./consoleEmailProvider";
import { createResendEmailProvider } from "./resendEmailProvider";

import type { EmailProvider } from "./emailProvider";

export type { EmailProvider } from "./emailProvider";

/**
 * Chooses the EmailProvider for the running environment (ADR-007 §10).
 *
 * The console provider logs instead of delivering, which makes it perfect
 * for development and catastrophic in production: a server that boots
 * happily and then silently discards every verification email is exactly
 * the failure this guards against. So production without a real, correctly
 * configured provider is a startup error, not a runtime surprise discovered
 * at the first registration.
 *
 * Called during app construction rather than at module load, so importing
 * this file is always safe and the failure surfaces at the point a server
 * actually tries to start.
 *
 * There is no `EMAIL_PROVIDER` env enum and no vendor branch: exactly one
 * real implementation exists (Resend), and a selector with a single arm is
 * a switch waiting for a second vendor. Both arrive together or not at all.
 */
export function resolveEmailProvider(): EmailProvider {
  if (env.NODE_ENV === "production") {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
      throw new Error(
        "No production EmailProvider is configured. Set RESEND_API_KEY and EMAIL_FROM — ConsoleEmailProvider logs instead of delivering and must never serve production traffic.",
      );
    }

    return createResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  }

  return createConsoleEmailProvider();
}
