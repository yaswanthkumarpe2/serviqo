import { SESSION_TTL_MS } from "../../config/constants";
import { hashPassword, verifyPassword } from "../../lib/crypto/password";
import { generateSecret } from "../../lib/crypto/tokens";
import { maskEmailAddress } from "../../lib/email/redaction";
import { EmailNotVerifiedError, InvalidCredentialsError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { sessionRepository } from "../sessions/session.repository";
import { userRepository } from "../users/user.repository";
import { issueAccessToken } from "./accessToken";
import { failureType } from "./authLogging";
import { formatRefreshToken, generateRefreshSecret } from "./refreshToken";

import type { UserDocument } from "../users/user.model";
import type { LoginInput } from "./auth.validation";
import type { AuthLogger } from "./authLogging";

/**
 * Organization-user login (ADR-011).
 *
 * Customers are out of scope by construction, not by omission: they own no
 * `User`, no password, and no `Session`, so there is nothing here they could
 * authenticate against (ADR-010 §5).
 */

/**
 * What the caller learns about themselves. Deliberately not the Mongoose
 * document: `toJSON` already strips `passwordHash`, but `status`,
 * `failedLoginAttempts`, and `lockedUntil` would still ride along, and
 * lockout state is exactly what §3's generic failure exists to withhold.
 *
 * `emailVerified` is absent rather than hardcoded true — an unverified
 * account cannot reach this response at all (§6), so the field would be a
 * constant pretending to be data.
 */
export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
}

export interface LoginResult {
  user: AuthenticatedUser;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /**
   * The raw refresh token. The controller puts this in an HttpOnly cookie
   * and NOWHERE else — a copy in the response body would defeat the flag
   * entirely (ADR-011 §1).
   */
  refreshToken: string;
}

/** Diagnostic metadata captured from the HTTP boundary. Never authentication input. */
export interface LoginContext {
  userAgent?: string;
}

export interface LoginService {
  login(input: LoginInput, context: LoginContext, log?: AuthLogger): Promise<LoginResult>;
}

/**
 * One message for every credential failure, so no branch is distinguishable
 * by its text any more than by its status code.
 */
const GENERIC_FAILURE_MESSAGE = "Email or password is incorrect";

function toAuthenticatedUser(user: UserDocument): AuthenticatedUser {
  return { id: user._id.toString(), name: user.name, email: user.email };
}

export function createLoginService(): LoginService {
  /**
   * A throwaway Argon2id hash used to spend the same work on an unknown
   * address that a real one costs (ADR-011 §4).
   *
   * Without it, "no such account" returns after one indexed lookup while a
   * real account spends ~19 MiB and ~100 ms hashing — a difference an
   * attacker can measure, which would turn the generic 401 into an
   * account-existence oracle and undo the decision at the network layer.
   *
   * Built from a random secret with the CURRENT parameters, so it can never
   * drift from real hashes and is never a hash of anything a person chose.
   * Started at construction so the first unknown-address login does not pay
   * for it.
   */
  const dummyPasswordHash = hashPassword(generateSecret());
  // Keeps a startup failure from surfacing as an unhandled rejection; the
  // original promise still rejects for whoever awaits it.
  void dummyPasswordHash.catch(() => undefined);

  return {
    async login(input: LoginInput, context: LoginContext, log: AuthLogger = logger): Promise<LoginResult> {
      const user = await userRepository.findByEmailWithPasswordHash(input.email);

      if (!user) {
        // Discarded — its only purpose is to cost what a real verification
        // costs.
        await verifyPassword(await dummyPasswordHash, input.password);
        log.info(
          { event: "auth.login.failed", reason: "unknown_account", recipient: maskEmailAddress(input.email) },
          "Login attempted for an address with no account",
        );
        throw new InvalidCredentialsError(GENERIC_FAILURE_MESSAGE);
      }

      const now = new Date();

      if (user.lockedUntil !== null && user.lockedUntil > now) {
        // Verified against this account's real hash and discarded, so a
        // locked account costs exactly what an unlocked one does. The result
        // is irrelevant: a locked account is refused either way.
        //
        // The attempt is deliberately NOT counted. Counting it would let an
        // attacker hold someone else's account locked indefinitely by
        // continuing to guess — turning a brute-force defence into a
        // denial-of-service tool aimed at a known address (ADR-011 §7).
        await verifyPassword(user.passwordHash, input.password);
        log.info(
          { event: "auth.login.failed", reason: "locked", userId: user._id.toString() },
          "Login attempted against a locked account",
        );
        throw new InvalidCredentialsError(GENERIC_FAILURE_MESSAGE);
      }

      const passwordMatches = await verifyPassword(user.passwordHash, input.password);

      if (!passwordMatches) {
        try {
          await userRepository.registerFailedLogin(user._id);
        } catch (err) {
          // A counter that failed to move must not change the answer. The
          // error's class is logged, never its message, which can quote
          // document contents.
          log.error(
            {
              event: "auth.login.lockout_update_failed",
              userId: user._id.toString(),
              failureType: failureType(err),
            },
            "Failed-login counter could not be updated",
          );
        }
        log.info(
          { event: "auth.login.failed", reason: "invalid_password", userId: user._id.toString() },
          "Login attempted with an incorrect password",
        );
        throw new InvalidCredentialsError(GENERIC_FAILURE_MESSAGE);
      }

      // Everything below is reachable only with a correct password, which is
      // why these branches can be specific without disclosing anything the
      // caller does not already know (ADR-011 §5).

      if (user.status !== "active") {
        // Stays generic. A disabled account has no self-service remedy, and
        // confirming the state to whoever holds the password tells an
        // attacker the account is worth further attention (ADR-011 §6).
        log.info(
          { event: "auth.login.failed", reason: "account_disabled", userId: user._id.toString() },
          "Login attempted against a disabled account",
        );
        throw new InvalidCredentialsError(GENERIC_FAILURE_MESSAGE);
      }

      if (user.emailVerifiedAt === null) {
        // The one specific refusal, because it is the one with a remedy the
        // caller could not otherwise guess: POST /auth/resend-verification.
        log.info(
          { event: "auth.login.failed", reason: "email_unverified", userId: user._id.toString() },
          "Login attempted before the address was verified",
        );
        throw new EmailNotVerifiedError("Verify your email address before signing in");
      }

      const { secret, secretHash } = generateRefreshSecret();

      // Only the hash is persisted. The Session's _id is generated here and
      // is what the token's routing component will carry (ADR-004 §2).
      const session = await sessionRepository.create({
        userId: user._id,
        currentRefreshTokenHash: secretHash,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        userAgent: context.userAgent,
      });

      try {
        // After the Session exists, deliberately. If session creation had
        // failed, the failure counter should still stand.
        await userRepository.clearLoginFailures(user._id);
      } catch (err) {
        // The user is authenticated and the session is real; a stale counter
        // is self-correcting on their next successful login.
        log.error(
          {
            event: "auth.login.counter_reset_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Login succeeded but the failed-login counter could not be cleared",
        );
      }

      const { token: accessToken, expiresInSeconds } = await issueAccessToken({
        userId: user._id.toString(),
        sessionId: session._id.toString(),
      });

      log.info(
        { event: "auth.login.succeeded", userId: user._id.toString(), sessionId: session._id.toString() },
        "Login succeeded",
      );

      // `secret` goes out of scope here; the only copy that leaves this
      // process is inside the Set-Cookie header the controller writes.
      return {
        user: toAuthenticatedUser(user),
        accessToken,
        expiresIn: expiresInSeconds,
        refreshToken: formatRefreshToken(session._id.toString(), secret),
      };
    },
  };
}
