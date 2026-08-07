import { maskEmailAddress } from "../../lib/email/redaction";
import { logger } from "../../lib/logger";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";
import { userRepository } from "../users/user.repository";
import { buildVerificationUrl, failureType, issueVerificationToken } from "./emailVerification";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { ResendVerificationInput } from "./auth.validation";
import type { AuthLogger } from "./emailVerification";

/**
 * Resend of an email-verification link (ADR-008).
 *
 * Returns `void` in every case — success, unknown address, already-verified
 * account, failed write, failed delivery. That is not laziness about error
 * handling: the controller answers a bodiless 204 for all of them, because
 * any distinguishable outcome tells a caller whether an account exists and
 * whether it is verified (ADR-008 §1).
 *
 * Everything worth knowing is logged instead. Log payloads carry a userId
 * where one exists and a masked address where one does not — never a full
 * address, never a token, never a URL.
 */
export interface VerificationService {
  resendVerification(input: ResendVerificationInput, log?: AuthLogger): Promise<void>;
}

export interface VerificationServiceDependencies {
  emailProvider: EmailProvider;
}

export function createVerificationService({ emailProvider }: VerificationServiceDependencies): VerificationService {
  return {
    async resendVerification(input: ResendVerificationInput, log: AuthLogger = logger): Promise<void> {
      // findByEmail normalizes through the User model's own rule, so the
      // schema never needs a second canonicalization authority.
      const user = await userRepository.findByEmail(input.email);

      if (!user) {
        // The domain survives masking because "many resend requests for one
        // domain" is a real signal; the local part does not, because it is
        // the part that identifies a person.
        log.info(
          { event: "auth.resend_verification.no_account", recipient: maskEmailAddress(input.email) },
          "Resend requested for an address with no account; nothing sent",
        );
        return;
      }

      if (user.emailVerifiedAt !== null) {
        log.info(
          { event: "auth.resend_verification.already_verified", userId: user._id.toString() },
          "Resend requested for an already-verified account; nothing sent",
        );
        return;
      }

      try {
        // Superseded tokens are DELETED, not marked consumed (ADR-005 §6):
        // `consumedAt` must keep meaning "the recipient used this link", or a
        // completed verification becomes indistinguishable from an abandoned
        // one. The predicate is scoped to {userId, purpose}, so this never
        // touches another user's tokens or this user's password-reset tokens.
        await accountTokenRepository.invalidateOutstandingForUser({
          userId: user._id,
          purpose: "email_verification",
        });
      } catch (err) {
        log.error(
          {
            event: "auth.resend_verification.invalidate_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Outstanding verification tokens could not be superseded; nothing sent",
        );
        return;
      }

      let rawSecret: string;
      try {
        rawSecret = await issueVerificationToken(user._id);
      } catch (err) {
        // Invalidation already ran, so the user may now hold zero valid
        // tokens — worse than before they asked. Tolerable only because this
        // endpoint is its own retry: asking again re-runs the whole flow, and
        // nothing else depends on a token existing (ADR-008 §5).
        log.error(
          {
            event: "auth.resend_verification.token_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Replacement verification token could not be issued; user has no outstanding token",
        );
        return;
      }

      try {
        await emailProvider.sendVerification({
          to: user.email,
          verificationUrl: buildVerificationUrl(rawSecret),
        });
      } catch (err) {
        // Persistence is complete and the token is valid for its full
        // lifetime, so there is nothing to undo (ADR-008 §6).
        log.error(
          {
            event: "auth.resend_verification.email_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Verification email could not be delivered; replacement token is still valid",
        );
      }

      // rawSecret goes out of scope here and exists nowhere else.
    },
  };
}
