import { hashPassword } from "../../lib/crypto/password";
import { EmailAlreadyExistsError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { userRepository } from "../users/user.repository";
import { buildVerificationUrl, failureType, issueVerificationToken } from "./emailVerification";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { UserDocument } from "../users/user.model";
import type { RegisterInput } from "./auth.validation";
import type { AuthLogger } from "./emailVerification";

/**
 * Registration workflow (ADR-007).
 *
 * The only thing the caller gets back is this DTO. The Mongoose document
 * never leaves the service: `toJSON` already strips `passwordHash`, but it
 * would still expose `status`, `failedLoginAttempts`, and `lockedUntil` —
 * lockout state that belongs to authentication, not to a client.
 */
export interface RegisteredUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface RegistrationService {
  register(input: RegisterInput, log?: AuthLogger): Promise<RegisteredUser>;
}

export interface RegistrationServiceDependencies {
  emailProvider: EmailProvider;
}

/** MongoDB's duplicate-key error code — the unique index rejecting a write. */
const DUPLICATE_KEY_ERROR = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY_ERROR;
}

function toRegisteredUser(user: UserDocument): RegisteredUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    // Derived from persisted state rather than hardcoded false, so the DTO
    // stays correct if this workflow ever gains a pre-verified path.
    emailVerified: user.emailVerifiedAt !== null,
  };
}

export function createRegistrationService({ emailProvider }: RegistrationServiceDependencies): RegistrationService {
  return {
    async register(input: RegisterInput, log: AuthLogger = logger): Promise<RegisteredUser> {
      // Fast path for an address that is already taken, and it avoids
      // spending ~19 MiB and ~100ms of Argon2 work to reach the same answer.
      // NOT the authority — see the duplicate-key catch below.
      const existing = await userRepository.findByEmail(input.email);
      if (existing) {
        throw new EmailAlreadyExistsError("An account with this email address already exists");
      }

      const passwordHash = await hashPassword(input.password);

      let user: UserDocument;
      try {
        user = await userRepository.create({
          name: input.name,
          email: input.email,
          passwordHash,
        });
      } catch (err) {
        // The unique index is the final authority: two concurrent requests
        // for the same address both pass the pre-check, and exactly one
        // survives here. Mongo's message quotes the duplicated value, so it
        // is discarded rather than wrapped.
        if (isDuplicateKeyError(err)) {
          throw new EmailAlreadyExistsError("An account with this email address already exists");
        }
        throw err;
      }

      let rawSecret: string;
      try {
        // No invalidateOutstandingForUser: this user was created microseconds
        // ago by this same request, so prior tokens are impossible. That call
        // belongs to the resend and forgot-password flows (ADR-005 §7).
        rawSecret = await issueVerificationToken(user._id);
      } catch (err) {
        // The User is deliberately left in place, unverified (ADR-007 §3).
        // Compensating deletion would put a destructive primitive on an
        // unauthenticated path to undo a recoverable state.
        //
        // A plain Error is rethrown rather than the original: it reaches the
        // generic 500 branch of errorHandler, which logs whatever it is
        // handed, and the original's message can quote document contents.
        // `cause` is intentionally not attached for the same reason.
        log.error(
          {
            event: "auth.registration.verification_token_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Verification token could not be issued; user remains unverified",
        );
        // `cause` is deliberately not attached: it would carry the original
        // message into Pino's error serializer via errorHandler, and a Mongo
        // error's text can quote document contents (ADR-007 §3). The log line
        // above records the error's class instead, which is enough to triage on.
        // eslint-disable-next-line preserve-caught-error -- see comment above
        throw new Error("Verification token issuance failed");
      }

      try {
        await emailProvider.sendVerification({
          to: user.email,
          verificationUrl: buildVerificationUrl(rawSecret),
        });
      } catch (err) {
        // Delivery is not persistence. Both records are correct and the token
        // is valid for its full lifetime, so the request still succeeds and
        // the response makes no claim about delivery (ADR-007 §4).
        log.error(
          {
            event: "auth.registration.verification_email_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Verification email could not be delivered; account was still created",
        );
      }

      // rawSecret goes out of scope here and exists nowhere else.
      return toRegisteredUser(user);
    },
  };
}
