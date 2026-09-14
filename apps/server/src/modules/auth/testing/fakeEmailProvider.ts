import type {
  AgentCredentialsEmailInput,
  EmailProvider,
  InvitationEmailInput,
  PasswordResetEmailInput,
  VerificationEmailInput,
} from "../../../lib/email/emailProvider";

/**
 * In-memory EmailProvider for tests.
 *
 * A fake rather than a module mock, because the architecture already takes
 * the provider as a parameter — nothing needs to intercept imports.
 *
 * Captured inputs stay in test memory and are never logged. Assertions read
 * the captured CODE and compare its SHA-256 against the persisted hash; the
 * code itself is never printed, snapshotted, or placed in an assertion
 * message.
 */
export interface FakeEmailProvider {
  provider: EmailProvider;
  verifications: VerificationEmailInput[];
  passwordResets: PasswordResetEmailInput[];
  invitations: InvitationEmailInput[];
  /**
   * Agent invitations, captured with BOTH secrets so a test can sign in as the
   * agent it just created (ADR-034 §7). They stay in test memory and, like the
   * verification codes beside them, are never printed or snapshotted.
   */
  agentCredentials: AgentCredentialsEmailInput[];
}

export function createFakeEmailProvider(): FakeEmailProvider {
  const verifications: VerificationEmailInput[] = [];
  const passwordResets: PasswordResetEmailInput[] = [];
  const invitations: InvitationEmailInput[] = [];
  const agentCredentials: AgentCredentialsEmailInput[] = [];

  return {
    verifications,
    passwordResets,
    invitations,
    agentCredentials,
    provider: {
      async sendVerification(input) {
        verifications.push(input);
      },
      async sendPasswordReset(input) {
        passwordResets.push(input);
      },
      async sendInvitation(input) {
        invitations.push(input);
      },
      async sendAgentCredentials(input) {
        agentCredentials.push(input);
      },
    },
  };
}

/** A provider whose delivery always fails, for the delivery-failure path. */
export function createFailingEmailProvider(message = "delivery failed"): EmailProvider {
  return {
    async sendVerification() {
      throw new Error(message);
    },
    async sendPasswordReset() {
      throw new Error(message);
    },
    async sendInvitation() {
      throw new Error(message);
    },
    async sendAgentCredentials() {
      throw new Error(message);
    },
  };
}

/**
 * Pulls the raw secret out of a captured link without ever logging it.
 *
 * Password reset still emails a link with its secret in the query string.
 * Email VERIFICATION no longer does — since ADR-030 the credential is the
 * six-digit `code` on the captured input, and the URL carries only the
 * address — so a verification test that reaches for this is asking the wrong
 * question and will get `null`.
 */
export function extractToken(actionUrl: string): string | null {
  return new URL(actionUrl).searchParams.get("token");
}

/** The address a verification link prefills. Carries no secret. */
export function extractEmail(verificationUrl: string): string | null {
  return new URL(verificationUrl).searchParams.get("email");
}
