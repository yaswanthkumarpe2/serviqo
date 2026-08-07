import { sha256 } from "../../lib/crypto/tokens";
import { maskEmailAddress } from "../../lib/email/redaction";
import { InvalidVerificationTokenError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";
import { userRepository } from "../users/user.repository";
import { buildVerificationUrl, failureType, issueVerificationToken } from "./emailVerification";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { ResendVerificationInput, VerifyEmailInput } from "./auth.validation";
import type { AuthLogger } from "./emailVerification";
import type { Types } from "mongoose";

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
  /**
   * Redeems a verification token. Resolves on success and on an
   * already-verified account; throws InvalidVerificationTokenError for every
   * other outcome, without distinguishing them (ADR-009 §1).
   */
  verifyEmail(input: VerifyEmailInput, log?: AuthLogger): Promise<void>;
}

export interface VerificationServiceDependencies {
  emailProvider: EmailProvider;
}

/**
 * Removes every remaining UNUSED verification token for a user.
 *
 * The token just redeemed has `consumedAt` set and therefore survives —
 * ADR-005 §6 keeps spent tokens until expiry so a replayed link stays
 * distinguishable from a fabricated one. "Outstanding" means unused
 * (ADR-009 §6).
 *
 * A failure here must not fail the request: the address is verified by this
 * point, and a leftover token is harmless because redeeming one against an
 * already-verified account is a no-op.
 */
async function clearOutstandingTokens(userId: Types.ObjectId, log: AuthLogger): Promise<void> {
  try {
    await accountTokenRepository.invalidateOutstandingForUser({
      userId,
      purpose: "email_verification",
    });
  } catch (err) {
    log.error(
      {
        event: "auth.verify_email.cleanup_failed",
        userId: userId.toString(),
        failureType: failureType(err),
      },
      "Outstanding verification tokens could not be cleared; account is still verified",
    );
  }
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

    async verifyEmail(input: VerifyEmailInput, log: AuthLogger = logger): Promise<void> {
      // The single atomic authority. Hash, purpose, not-consumed and
      // not-expired are all in one predicate, so of N concurrent callers
      // presenting the same token exactly one succeeds (ADR-005 §4).
      //
      // Nothing below re-checks expiry or consumption: a `find → inspect`
      // step here would reintroduce the race this predicate exists to
      // eliminate.
      const consumed = await accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: sha256(input.token),
        purpose: "email_verification",
        now: new Date(),
      });

      if (!consumed) {
        // Invalid, expired, already consumed, or fabricated — one response
        // for all of them, because naming the reason would confirm whether
        // the token was ever real (ADR-009 §1).
        log.info(
          { event: "auth.verify_email.rejected" },
          "Verification token could not be redeemed",
        );
        throw new InvalidVerificationTokenError("Verification token could not be redeemed");
      }

      const user = await userRepository.findById(consumed.userId.toString());

      if (!user) {
        // The account went away between issuance and redemption. The token
        // is spent either way; the caller gets the same answer as everyone
        // whose token was never valid.
        log.error(
          { event: "auth.verify_email.orphaned_token", userId: consumed.userId.toString() },
          "Verification token referenced a user that no longer exists",
        );
        throw new InvalidVerificationTokenError("Verification token could not be redeemed");
      }

      if (user.emailVerifiedAt !== null) {
        // A real link for an account that is already verified. The token is
        // not refunded — un-consuming it would need exactly the
        // read-modify-write this design forbids — and 204 is correct: the
        // address is verified (ADR-009 §5).
        log.info(
          { event: "auth.verify_email.already_verified", userId: user._id.toString() },
          "Verification token redeemed for an already-verified account",
        );
        await clearOutstandingTokens(user._id, log);
        return;
      }

      // The predicate, not the read above, is what makes this set-once: a
      // concurrent second verification matches nothing and leaves the first
      // timestamp intact (ADR-009 §3).
      const updated = await userRepository.markEmailVerified(user._id, new Date());

      if (!updated) {
        log.info(
          { event: "auth.verify_email.already_verified_race", userId: user._id.toString() },
          "Verification lost the set-once race; the earlier timestamp stands",
        );
      }

      await clearOutstandingTokens(user._id, log);
    },
  };
}
