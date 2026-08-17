import { InvalidAccessTokenError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { userRepository } from "../users/user.repository";

import type { UserDocument, UserStatus } from "../users/user.model";
import type { AccessTokenPrincipal } from "./accessToken";
import type { AuthLogger } from "./authLogging";

/**
 * The authenticated caller's own identity (ADR-015).
 *
 * Organization users only, permanently. Customers own no `User` and
 * authenticate against nothing, so there is no principal here they could be
 * (ADR-010 §5) — the audience claim `requireAccessToken` verified is what
 * makes that structural rather than a matter of trusting the caller.
 */

/**
 * What the caller learns about themselves.
 *
 * Deliberately not the Mongoose document. `toJSON` strips `passwordHash`, but
 * `failedLoginAttempts` and `lockedUntil` would still ride along — lockout
 * state belongs to authentication, not to a client — and a DTO built field by
 * field cannot silently gain whatever the schema gains next.
 *
 * Wider than login's `AuthenticatedUser` and deliberately a separate type. The
 * two answer different questions: login reports the minimum a caller needs to
 * know a sign-in worked, while this is the dashboard's view of an account it
 * has already proved it owns. Aliasing them would mean a field added for one
 * appears in the other.
 *
 * No `organizationId` and no `role`: nothing creates a `Membership` yet, so
 * the field would be null for every caller, and "current organization" is not
 * a concept this architecture has (ADR-015 §9).
 */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  /**
   * Always `"active"` — §7's gate refuses every other value before this is
   * built. Included regardless: it is the caller's own state returned to the
   * authenticated owner, so it discloses nothing, and a client that reads it
   * survives a future state being allowed through (ADR-015 §10).
   */
  status: UserStatus;
  /**
   * Never null for the same reason, and a timestamp rather than a boolean —
   * unlike `status` it is genuinely per-user data.
   */
  emailVerifiedAt: Date;
  createdAt: Date;
}

export interface CurrentUserService {
  getCurrentUser(principal: AccessTokenPrincipal, log?: AuthLogger): Promise<CurrentUser>;
}

/** The same message every other refusal on this route carries (ADR-015 §6). */
const GENERIC_FAILURE_MESSAGE = "Authentication required";

/**
 * Built from the loaded document rather than from the token, so `name` and
 * `email` are current as of this request rather than as of login. That is also
 * why neither is a claim: a name in a JWT is stale personal data in a place
 * personal data does not belong (ADR-011 §2).
 */
function toCurrentUser(user: UserDocument): CurrentUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    status: user.status,
    // Non-null by the gate above; asserted rather than defaulted so a change
    // that made it reachable as null fails loudly here instead of shipping
    // `null` to a dashboard that renders it.
    emailVerifiedAt: user.emailVerifiedAt!,
    createdAt: user.createdAt,
  };
}

export function createCurrentUserService(): CurrentUserService {
  return {
    async getCurrentUser(principal: AccessTokenPrincipal, log: AuthLogger = logger): Promise<CurrentUser> {
      const { userId, sessionId } = principal;

      const user = await userRepository.findById(userId);

      /*
        A valid signature identifies a user; it does not entitle them
        (ADR-015 §7). The same three-part gate `refresh.service.ts` applies —
        exists, active, verified — deliberately identical, so the two cannot
        drift into disagreeing about who may hold a session.

        This is what makes disabling an account take effect on the next
        request rather than at token expiry. The account is re-checked every
        time; the SESSION deliberately is not (§8).

        Unknown and disabled collapse into one refusal here rather than
        branching into two responses: distinguishing them would turn a bearer
        token into a probe for account state.
      */
      if (user === null || user.status !== "active" || user.emailVerifiedAt === null) {
        log.info(
          {
            event: "auth.me.failed",
            reason: user === null ? "unknown_user" : "user_not_entitled",
            userId,
            sessionId,
          },
          "Current-user request refused for an account that may no longer be served",
        );
        throw new InvalidAccessTokenError(GENERIC_FAILURE_MESSAGE);
      }

      log.info({ event: "auth.me.succeeded", userId, sessionId }, "Current user resolved");

      return toCurrentUser(user);
    },
  };
}
