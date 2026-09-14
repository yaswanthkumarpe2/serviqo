import {
  EMAIL_VERIFICATION_CODE_LENGTH,
  PASSWORD_RESET_CODE_TTL_MS,
  PASSWORD_RESET_MAX_ATTEMPTS,
} from "../../config/constants";
import { hashPassword } from "../../lib/crypto/password";
import { generateNumericCode } from "../../lib/crypto/otp";
import { sha256 } from "../../lib/crypto/tokens";
import { maskEmailAddress } from "../../lib/email/redaction";
import { env } from "../../lib/env";
import { InvalidPasswordResetCodeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { accountTokenRepository } from "../accountTokens/accountToken.repository";
import { sessionRepository } from "../sessions/session.repository";
import { userRepository } from "../users/user.repository";
import { failureType } from "./authLogging";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { UserDocument } from "../users/user.model";
import type { AuthLogger } from "./authLogging";
import type { ForgotPasswordInput, ResetPasswordInput } from "./auth.validation";
import type { Types } from "mongoose";

/**
 * Password reset by emailed code (ADR-036).
 *
 * Two operations, and they mirror verification's pair on purpose: ask for a
 * code (`requestReset`, the sibling of resend-verification) and redeem one
 * (`resetPassword`, the sibling of verify-email). The mechanics underneath —
 * a hashed six-digit code on an `AccountToken`, consumed atomically by owner,
 * purpose and hash, with wrong guesses counted on the document — are
 * ADR-030's, unchanged. What differs is what a redeemed code buys, and so what
 * this file has to be careful about.
 *
 * This is NOT `changePassword.service.ts`. Changing a password proves
 * knowledge of the current one for somebody already signed in; resetting
 * proves control of the inbox for somebody who is not. The threat models
 * differ, and so do the consequences — a change keeps the caller's session,
 * a reset ends every session, because the caller has none and whoever does
 * may be the reason for the reset.
 */
export interface PasswordResetService {
  /**
   * Mails a reset code if the address belongs to an account that may be reset
   * this way. Resolves with nothing in every case, so the controller has no
   * state it could disclose (ADR-036 §3).
   */
  requestReset(input: ForgotPasswordInput, log?: AuthLogger): Promise<void>;
  /**
   * Redeems a code and replaces the password. Throws
   * `InvalidPasswordResetCodeError` for every refusal without saying which.
   */
  resetPassword(input: ResetPasswordInput, log?: AuthLogger): Promise<void>;
}

export interface PasswordResetServiceDependencies {
  emailProvider: EmailProvider;
}

const REFUSAL_MESSAGE = "Password reset code could not be redeemed";

/**
 * Who may recover an account through their inbox (ADR-036 §6).
 *
 * Every active STAFF account, except the platform admin. Legacy customer
 * accounts are refused too: customers no longer sign in (ADR-037), so a reset
 * would hand them a password for nothing.
 *
 * The platform admin is the other exception. That account can read every
 * tenant's counts and owns the organization, and its recovery path is
 * `npm run reset:password` against the database — a step that needs the
 * deployment's credentials, where this one needs only somebody's mailbox. A
 * reset that worked for the admin would make "compromise one Gmail account"
 * equivalent to "compromise the platform".
 *
 * Refused silently, exactly as an unknown address is. Answering differently
 * would tell a stranger which address is the admin's.
 */
function mayResetByEmail(user: UserDocument): boolean {
  return user.status === "active" && user.kind === "agent" && user.platformRole !== "admin";
}

/**
 * The page where the code is typed. Carries the address for prefill and no
 * secret — the same contract `buildVerificationUrl` keeps (ADR-030 §6).
 */
export function buildPasswordResetUrl(email: string): string {
  const url = new URL("/reset-password", env.CLIENT_URL);
  url.searchParams.set("email", email);
  return url.toString();
}

/**
 * Mints a reset code and returns the digits. Only the hash reaches MongoDB.
 *
 * The code length is verification's constant, deliberately: both forms share
 * one input on the client, and two lengths would be two chances for a person
 * to be told their correct code is the wrong shape.
 */
async function issueResetCode(userId: Types.ObjectId): Promise<string> {
  const code = generateNumericCode(EMAIL_VERIFICATION_CODE_LENGTH);

  await accountTokenRepository.create({
    userId,
    purpose: "password_reset",
    tokenHash: sha256(code),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MS),
  });

  return code;
}

export function createPasswordResetService({ emailProvider }: PasswordResetServiceDependencies): PasswordResetService {
  return {
    async requestReset(input, log: AuthLogger = logger): Promise<void> {
      const user = await userRepository.findByEmail(input.email);

      if (!user) {
        log.info(
          { event: "auth.forgot_password.no_account", recipient: maskEmailAddress(input.email) },
          "Password reset requested for an address with no account; nothing sent",
        );
        return;
      }

      if (!mayResetByEmail(user)) {
        log.info(
          { event: "auth.forgot_password.not_eligible", userId: user._id.toString() },
          "Password reset requested for an account that may not be reset by email; nothing sent",
        );
        return;
      }

      /*
        Unverified accounts ARE served, and that is a decision rather than an
        oversight (ADR-036 §4). Redeeming a code proves control of the inbox,
        which is exactly what verification proves — so there is nothing a
        separate verification would add. It is also the only recovery for two
        real people: an invited agent who lost the mail holding their temporary
        password, and the owner of an address somebody else registered first.
      */

      try {
        // Superseded, not consumed, for ADR-005 §6's reason: `consumedAt` has
        // to keep meaning "somebody used this".
        await accountTokenRepository.invalidateOutstandingForUser({ userId: user._id, purpose: "password_reset" });
      } catch (err) {
        log.error(
          {
            event: "auth.forgot_password.invalidate_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Outstanding reset codes could not be superseded; nothing sent",
        );
        return;
      }

      let code: string;
      try {
        code = await issueResetCode(user._id);
      } catch (err) {
        log.error(
          { event: "auth.forgot_password.token_failed", userId: user._id.toString(), failureType: failureType(err) },
          "Reset code could not be issued; nothing sent",
        );
        return;
      }

      try {
        await emailProvider.sendPasswordReset({
          to: user.email,
          code,
          resetUrl: buildPasswordResetUrl(user.email),
        });
        log.info(
          { event: "auth.forgot_password.sent", userId: user._id.toString() },
          "Password reset code issued and handed to the mail provider",
        );
      } catch (err) {
        // The code is valid for its full lifetime; asking again is the retry.
        log.error(
          { event: "auth.forgot_password.email_failed", userId: user._id.toString(), failureType: failureType(err) },
          "Password reset email could not be delivered; the issued code is still valid",
        );
      }
    },

    async resetPassword(input, log: AuthLogger = logger): Promise<void> {
      const now = new Date();
      const user = await userRepository.findByEmail(input.email);

      if (!user) {
        log.info(
          { event: "auth.reset_password.rejected", reason: "no_account", recipient: maskEmailAddress(input.email) },
          REFUSAL_MESSAGE,
        );
        throw new InvalidPasswordResetCodeError(REFUSAL_MESSAGE);
      }

      /*
        The code is consumed BEFORE anything about the new password is looked
        at, and that order is the security property of this method.

        Anything checked first becomes an oracle available without the code.
        The obvious candidate is "you cannot reuse your current password": run
        before consumption, it would let anyone who knows an address test
        guesses at that account's password, one request each, with no code at
        all. So there is no reuse check here (ADR-036 §4), and the only check on
        the new password — its length — is made by the schema, which depends on
        the submitted string alone.
      */
      const consumed = await accountTokenRepository.consumeValidByUserAndPurpose({
        userId: user._id,
        purpose: "password_reset",
        tokenHash: sha256(input.code),
        now,
      });

      if (!consumed) {
        // Counted before throwing, and a failure to count is not a free guess.
        const attempted = await accountTokenRepository
          .registerFailedAttempt({
            userId: user._id,
            purpose: "password_reset",
            now,
            maxAttempts: PASSWORD_RESET_MAX_ATTEMPTS,
          })
          .catch((error: unknown) => {
            log.error(
              {
                event: "auth.reset_password.attempt_count_failed",
                userId: user._id.toString(),
                failureType: failureType(error),
              },
              "Failed reset attempt could not be counted",
            );
            return null;
          });

        log.info(
          {
            event: "auth.reset_password.rejected",
            reason: "bad_code",
            userId: user._id.toString(),
            attempts: attempted?.attempts ?? null,
            exhausted: attempted?.consumedAt !== null && attempted?.consumedAt !== undefined,
          },
          REFUSAL_MESSAGE,
        );
        throw new InvalidPasswordResetCodeError(REFUSAL_MESSAGE);
      }

      /*
        Re-checked after consumption rather than trusted from issuance. A code
        is only ever minted for an eligible account, but the account can be
        disabled — or granted the platform role — during the ten minutes the
        code lives, and a code must not outlast the standing it was issued on.
      */
      if (!mayResetByEmail(user)) {
        log.info(
          { event: "auth.reset_password.rejected", reason: "not_eligible", userId: user._id.toString() },
          REFUSAL_MESSAGE,
        );
        throw new InvalidPasswordResetCodeError(REFUSAL_MESSAGE);
      }

      const passwordHash = await hashPassword(input.newPassword);
      const replaced = await userRepository.replacePasswordAfterReset(user._id, passwordHash);

      if (!replaced) {
        // Deleted between the lookup and here. Nothing to reset, and nothing
        // to say about it that would differ from any other refusal.
        log.info(
          { event: "auth.reset_password.rejected", reason: "account_gone", userId: user._id.toString() },
          REFUSAL_MESSAGE,
        );
        throw new InvalidPasswordResetCodeError(REFUSAL_MESSAGE);
      }

      /*
        The inbox is proved, so the address is verified — the same fact
        verify-email would have recorded (ADR-036 §4). Set-once, so an
        already-verified account keeps its original timestamp.
      */
      await userRepository.markEmailVerified(user._id, now);

      /*
        EVERY session ends. Somebody resetting a password either forgot it or
        believes somebody else has it, and in the second case the other
        person's session is the thing they are trying to stop. There is no
        session of the caller's own to spare — they are not signed in.
      */
      const revokedSessions = await sessionRepository.revokeAllForUser(user._id);

      /*
        Best effort: leftover codes are harmless now (a reset code for an
        account whose password just changed only changes it again, and needs the
        inbox to do it), but a verification code outstanding for an address
        that is now verified is clutter worth removing.
      */
      await Promise.all(
        (["password_reset", "email_verification"] as const).map((purpose) =>
          accountTokenRepository.invalidateOutstandingForUser({ userId: user._id, purpose }).catch((err: unknown) => {
            log.error(
              {
                event: "auth.reset_password.cleanup_failed",
                userId: user._id.toString(),
                purpose,
                failureType: failureType(err),
              },
              "Outstanding codes could not be cleared; the password was still reset",
            );
          }),
        ),
      );

      log.info(
        { event: "auth.reset_password.succeeded", userId: user._id.toString(), revokedSessions },
        "Password reset",
      );
    },
  };
}
