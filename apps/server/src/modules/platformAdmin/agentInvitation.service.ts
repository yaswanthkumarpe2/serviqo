import { randomBytes } from "node:crypto";

import { EmailAlreadyExistsError, NotFoundError } from "../../lib/errors";
import { hashPassword } from "../../lib/crypto/password";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { buildVerificationUrl, issueVerificationCode } from "../auth/emailVerification";
import { failureType } from "../auth/authLogging";
import { membershipRepository } from "../memberships/membership.repository";
import { organizationRepository } from "../organizations/organization.repository";
import { UserModel, normalizeEmail } from "../users/user.model";

import type { EmailProvider } from "../../lib/email/emailProvider";
import type { AuthLogger } from "../auth/authLogging";
import type { MembershipRole } from "../memberships/membership.model";

/**
 * Adding an agent (ADR-034 §7).
 *
 * The ONLY way an account with `kind: "agent"` comes into existence. Public
 * registration cannot produce one — it writes `"customer"` and has no
 * parameter for anything else — so the set of people who can answer a tenant's
 * conversations is exactly the set an admin put there.
 *
 * Three documents and one email, in a deliberate order:
 *
 *   1. `User`, unverified, with a generated password.
 *   2. `Membership` in the default organization, role `agent`.
 *   3. An email verification code.
 *   4. The mail carrying the password and the code.
 *
 * The account is created UNVERIFIED and therefore cannot sign in, which is the
 * requirement driving the whole shape of this: an admin typing an address is
 * not evidence anybody reads it, and a working account at an address nobody
 * controls is an account somebody else may end up holding. Verification is
 * what turns it on, and `login.service.ts` already refuses every unverified
 * account with `EMAIL_NOT_VERIFIED` — so "verify first" is enforced by
 * machinery that predates this feature rather than by a new check here.
 */

/** The role an invited agent is given. Not a parameter — see §7. */
const AGENT_ROLE: MembershipRole = "agent";

/**
 * Bytes of entropy in a generated first password.
 *
 * 18 bytes is 144 bits, rendered as 24 base64url characters. Far past
 * `PASSWORD_MIN_LENGTH`, and chosen so the password is unguessable rather than
 * memorable: it is meant to be used once from an email and replaced, not
 * retyped from memory.
 */
const TEMPORARY_PASSWORD_BYTES = 18;

export interface InvitedAgent {
  id: string;
  name: string;
  email: string;
  organizationName: string;
}

export interface AgentInvitationService {
  invite(input: { name: string; email: string }, log?: AuthLogger): Promise<InvitedAgent>;
}

export interface AgentInvitationServiceDependencies {
  emailProvider: EmailProvider;
}

/**
 * A password nobody chose and nobody stores.
 *
 * `base64url` so it survives a copy out of an email client without any
 * character needing to be escaped, quoted, or recognised as punctuation — a
 * password a person cannot paste correctly is a support ticket.
 */
function generateTemporaryPassword(): string {
  return randomBytes(TEMPORARY_PASSWORD_BYTES).toString("base64url");
}

export function createAgentInvitationService({
  emailProvider,
}: AgentInvitationServiceDependencies): AgentInvitationService {
  return {
    async invite({ name, email: rawEmail }, log: AuthLogger = logger): Promise<InvitedAgent> {
      const email = normalizeEmail(rawEmail);

      /*
        Which tenant the agent joins is DERIVED, never sent. The request names
        no organization, so no admin request can add somebody to a tenant by
        editing a body — and on a single-tenant deployment there is exactly one
        right answer anyway (ADR-034 §4).
      */
      const organization = await organizationRepository.findDefaultForCustomers();
      if (organization === null) {
        throw new NotFoundError("No organization exists yet. Create one before adding agents.");
      }

      const temporaryPassword = generateTemporaryPassword();

      let user;
      try {
        user = await UserModel.create({
          name,
          email,
          passwordHash: await hashPassword(temporaryPassword),
          // The load-bearing line: unverified, so login refuses it until the
          // code below is redeemed.
          emailVerifiedAt: null,
          status: "active",
          kind: "agent",
        });
      } catch (err: unknown) {
        /*
          MongoDB's unique index on email is the authority, exactly as in
          registration. Unlike registration, disclosing the collision is
          uncontroversial here: the caller is an authenticated platform admin
          who can already list every account, so "that address is taken" tells
          them nothing they could not read directly.
        */
        if (typeof err === "object" && err !== null && "code" in err && err.code === 11000) {
          throw new EmailAlreadyExistsError("An account with this email address already exists");
        }
        throw err;
      }

      /*
        Best-effort, and NOT rolled back if it fails. The same posture
        ADR-016 §3 takes: a compensating delete would put a destructive write on
        this path to undo a state that is recoverable by hand, and an agent with
        no membership is inert rather than dangerous — they can sign in and see
        no tenant.
      */
      try {
        await membershipRepository.create({
          userId: user._id,
          organizationId: organization._id,
          role: AGENT_ROLE,
          invitedByUserId: null,
        });
      } catch (err: unknown) {
        log.error(
          {
            event: "platform.agent_invite.membership_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Agent account created without a membership",
        );
      }

      let code: string;
      try {
        code = await issueVerificationCode(user._id);
      } catch (err: unknown) {
        /*
          The user is left in place, unverified — the same decision
          registration makes. A plain Error is rethrown rather than the
          original, whose message can quote document contents.
        */
        log.error(
          {
            event: "platform.agent_invite.verification_token_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Verification token could not be issued for an invited agent",
        );
        // eslint-disable-next-line preserve-caught-error -- see comment above
        throw new Error("Verification token issuance failed");
      }

      try {
        await emailProvider.sendAgentCredentials({
          to: user.email,
          organizationName: organization.name,
          temporaryPassword,
          code,
          verificationUrl: buildVerificationUrl(user.email),
          // The AGENT door, not the customer one. Sending them to `/login`
          // would land them on the page for the people they are meant to
          // answer.
          signInUrl: `${env.CLIENT_URL}/agent/login`,
        });
      } catch (err: unknown) {
        /*
          Delivery is not persistence — but unlike registration, a failure here
          is worth reporting UP rather than swallowing. The password exists only
          in that message: nothing stores it, so an undelivered invitation
          produces an account nobody can ever sign into, and the admin needs to
          know to try again.
        */
        log.error(
          {
            event: "platform.agent_invite.email_failed",
            userId: user._id.toString(),
            failureType: failureType(err),
          },
          "Agent credentials email could not be delivered; the password is unrecoverable",
        );
        // eslint-disable-next-line preserve-caught-error -- the original's message can quote document contents
        throw new Error("Agent credentials email could not be delivered");
      }

      log.info(
        { event: "platform.agent_invite.succeeded", userId: user._id.toString(), organizationId: organization._id.toString() },
        "Agent invited",
      );

      return {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        organizationName: organization.name,
      };
    },
  };
}
