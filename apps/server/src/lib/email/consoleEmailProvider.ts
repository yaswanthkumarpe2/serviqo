import { logger } from "../logger";
import { describeActionUrl, maskEmailAddress } from "./redaction";

import type {
  EmailProvider,
  InvitationEmailInput,
  PasswordResetEmailInput,
  VerificationEmailInput,
} from "./emailProvider";

/**
 * Minimal structural type for the logger this provider needs. Declared here
 * rather than importing Pino's type so tests can supply a capture function
 * without the production logger being weakened or reconfigured.
 */
export interface EmailLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

/**
 * Development email provider: emits a safe structured log line instead of
 * delivering anything.
 *
 * Safe by default is the whole point. It receives URLs that contain live
 * secrets, so it reduces every one of them through `describeActionUrl` before
 * logging, and never logs a raw URL, token, or full recipient address. Pino's
 * field-name redaction cannot help here — a token inside a URL string is
 * indistinguishable from any other string to that filter.
 *
 * Resolves successfully after logging. No retries, no queue, no background
 * job, no provider-specific error types — those become justified when a real
 * external provider exists and can actually fail.
 */
export function createConsoleEmailProvider(log: EmailLogger = logger): EmailProvider {
  return {
    async sendVerification(input: VerificationEmailInput): Promise<void> {
      log.info(
        {
          event: "email.dev.verification",
          delivery: "console",
          recipient: maskEmailAddress(input.to),
          url: describeActionUrl(input.verificationUrl),
        },
        "Verification email (development: not delivered)",
      );
    },

    async sendPasswordReset(input: PasswordResetEmailInput): Promise<void> {
      log.info(
        {
          event: "email.dev.password_reset",
          delivery: "console",
          recipient: maskEmailAddress(input.to),
          url: describeActionUrl(input.resetUrl),
        },
        "Password reset email (development: not delivered)",
      );
    },

    async sendInvitation(input: InvitationEmailInput): Promise<void> {
      log.info(
        {
          event: "email.dev.invitation",
          delivery: "console",
          recipient: maskEmailAddress(input.to),
          // Not a credential — an organization name, needed to tell one
          // invitation log line from another.
          organizationName: input.organizationName,
          url: describeActionUrl(input.invitationUrl),
        },
        "Invitation email (development: not delivered)",
      );
    },
  };
}
