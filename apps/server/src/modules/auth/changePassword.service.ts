import { InvalidAccessTokenError, InvalidCredentialsError, ValidationError } from "../../lib/errors";
import { hashPassword, isPasswordLengthValid, normalizePassword, verifyPassword } from "../../lib/crypto/password";
import { logger } from "../../lib/logger";
import { sessionRepository } from "../sessions/session.repository";
import { UserModel } from "../users/user.model";
import { userRepository } from "../users/user.repository";

import type { AccessTokenPrincipal } from "./accessToken";
import type { AuthLogger } from "./authLogging";

/**
 * Changing your own password (ADR-034 §8).
 *
 * Built for the agent who was emailed a generated one and should not keep it,
 * but deliberately not restricted to agents — a customer who wants to change
 * their password has the same right to, and a rule that said otherwise would
 * be arbitrary.
 *
 * This is NOT password RESET. Reset proves control of an inbox for somebody
 * who cannot sign in; this proves knowledge of the current password for
 * somebody who already has. They are different flows with different threat
 * models — reset lives in `passwordReset.service.ts` (ADR-036).
 */

export interface ChangePasswordService {
  changePassword(
    principal: AccessTokenPrincipal,
    input: { currentPassword: string; newPassword: string },
    log?: AuthLogger,
  ): Promise<void>;
}

/** The same message every refusal on this route carries. */
const GENERIC_FAILURE_MESSAGE = "Authentication required";

export function createChangePasswordService(): ChangePasswordService {
  return {
    async changePassword(principal, { currentPassword, newPassword }, log: AuthLogger = logger): Promise<void> {
      const { userId, sessionId } = principal;

      /*
        The credential-bearing lookup, named for what it does — the same
        convention `login.service.ts` follows. `passwordHash` is `select: false`
        and never reaches an ordinary query.
      */
      const user = await UserModel.findById(userId).select("+passwordHash");

      /*
        The same exists/active/verified gate every other authenticated surface
        applies (ADR-015 §7). An unverified agent must not be able to replace
        the password that is holding their account shut.
      */
      if (user === null || user.status !== "active" || user.emailVerifiedAt === null) {
        log.info(
          { event: "auth.change_password.refused", reason: "user_not_entitled", userId, sessionId },
          "Password change refused for an account that may no longer be served",
        );
        throw new InvalidAccessTokenError(GENERIC_FAILURE_MESSAGE);
      }

      /*
        Knowing the current password is the whole authorization for this. An
        access token alone is not enough: a token lifted from a machine someone
        walked away from would otherwise let an attacker lock the owner out of
        their own account permanently.
      */
      const matches = await verifyPassword(user.passwordHash, currentPassword);
      if (!matches) {
        log.info(
          { event: "auth.change_password.refused", reason: "wrong_password", userId, sessionId },
          "Password change refused: current password did not match",
        );
        throw new InvalidCredentialsError("Your current password is not correct");
      }

      const normalized = normalizePassword(newPassword);
      if (!isPasswordLengthValid(normalized)) {
        throw new ValidationError("Request validation failed", [
          { field: "newPassword", message: "That password does not meet the length policy" },
        ]);
      }

      /*
        Refused rather than accepted as a no-op. An agent who "changed" their
        password to the one from the invitation email has not changed anything,
        and that mail is now a permanent working credential sitting in an inbox.
      */
      if (await verifyPassword(user.passwordHash, newPassword)) {
        throw new ValidationError("Request validation failed", [
          { field: "newPassword", message: "Choose a password you have not used here before" },
        ]);
      }

      user.passwordHash = await hashPassword(newPassword);
      await user.save();

      /*
        Every OTHER session is revoked, and this one is kept.

        Changing a password is what a person does when they suspect somebody
        else has it, so leaving other sessions alive would make the action
        mostly ceremonial. Keeping the caller's own session is what stops the
        change from signing them out of the page they just used to make it —
        the same split `logout-all` deliberately does not make (ADR-014 §3).
      */
      const revoked = await sessionRepository.revokeAllForUserExcept(userId, sessionId);

      /*
        Clears any lockout, on the reasoning that whoever knows the current
        password and just replaced it is the owner, and leaving them locked out
        by earlier failed attempts would punish a successful recovery.
      */
      await userRepository.clearLoginFailures(userId);

      log.info(
        { event: "auth.change_password.succeeded", userId, sessionId, revokedSessions: revoked },
        "Password changed",
      );
    },
  };
}
