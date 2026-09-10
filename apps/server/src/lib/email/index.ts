import { env } from "../env";
import { logger } from "../logger";
import { createConsoleEmailProvider } from "./consoleEmailProvider";
import { createResendEmailProvider } from "./resendEmailProvider";

import type { EmailProvider } from "./emailProvider";

export type { EmailProvider } from "./emailProvider";

/**
 * Chooses the EmailProvider from configuration (ADR-007 §10, ADR-030).
 *
 * The console provider logs instead of delivering, which makes it a
 * reasonable fallback for a machine with nothing configured and
 * catastrophic in production: a server that boots happily and then silently
 * discards every verification email is exactly the failure this guards
 * against. So production without a real, correctly configured provider is a
 * startup error, not a runtime surprise discovered at the first
 * registration.
 *
 * Called during app construction rather than at module load, so importing
 * this file is always safe and the failure surfaces at the point a server
 * actually tries to start.
 *
 * There is no `EMAIL_PROVIDER` env enum and no vendor branch: exactly one
 * real implementation exists (Resend), and a selector with a single arm is
 * a switch waiting for a second vendor. Both arrive together or not at all.
 */
/**
 * Resend's shared testing sender, which needs no verified domain.
 *
 * It has one restriction that is invisible until it bites: it delivers ONLY
 * to the address that owns the Resend account. Mail to anyone else is
 * refused with a 403 at send time, long after the request that triggered it
 * has returned 201.
 */
const SHARED_TESTING_SENDER = "@resend.dev";

/**
 * Says out loud that mail can only reach one inbox.
 *
 * Worth a startup warning rather than leaving it to be discovered, because
 * every layer below this one is designed to stay quiet about delivery. The
 * registration service treats a failed send as non-fatal and logs it (ADR-008
 * §6) — correctly, since failing the request would tell a stranger whether an
 * address exists. So a developer signing up with a second address of their
 * own gets a 201, a "check your email" screen, and silence, with the only
 * evidence a single line in the server log they had no reason to read.
 *
 * A warning at startup is the one place this can be said that is neither
 * per-request nor visible to a user, which is what keeps it from becoming
 * the enumeration leak the quiet exists to prevent.
 */
function warnIfSharedSender(from: string): void {
  if (!from.toLowerCase().includes(SHARED_TESTING_SENDER)) return;

  logger.warn(
    { event: "email.sender.shared_testing_domain", from },
    "EMAIL_FROM uses Resend's shared testing sender: mail will ONLY be delivered to the address that owns the Resend account, and every other recipient is refused. Verify a domain and send from it to reach anyone else.",
  );
}

export function resolveEmailProvider(): EmailProvider {
  /*
    Production must have a real provider, and says so loudly. Unchanged: a
    server that boots happily and then silently discards every verification
    email is exactly the failure this guards against (ADR-007 §10).
  */
  if (env.NODE_ENV === "production" && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
    throw new Error(
      "No production EmailProvider is configured. Set RESEND_API_KEY and EMAIL_FROM — ConsoleEmailProvider logs instead of delivering and must never serve production traffic.",
    );
  }

  /*
    CONFIGURATION decides the provider, not NODE_ENV — and that is a change
    from the original rule, made because ADR-030 turned the old rule into a
    dead end.

    While verification was a link, a developer could complete the flow
    without delivery: the console provider logged that a mail was "sent",
    and the token could be read out of the database and pasted into a URL.
    A six-digit code cannot be recovered that way. It is stored only as a
    SHA-256 hash, and the console provider deliberately does not print it
    (it is short enough to be read at a glance from a shipped log). So under
    the old rule, a development server could issue a code that literally
    nobody — including its own operator — was able to obtain, and signup was
    impossible locally.

    The fix is not to print the secret in development. It is to let a
    developer who has configured a real provider actually use it. Resend's
    shared `onboarding@resend.dev` sender needs no verified domain and
    delivers to the account owner's own inbox, so this costs nothing to set
    up and gives local signup the same path production takes — which is also
    the version worth testing.

    The console provider remains the answer for a machine with no provider
    configured at all: offline, CI, a fresh clone. It cannot be reached in
    production, because the guard above returns first.
  */
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    warnIfSharedSender(env.EMAIL_FROM);
    return createResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  }

  return createConsoleEmailProvider();
}
