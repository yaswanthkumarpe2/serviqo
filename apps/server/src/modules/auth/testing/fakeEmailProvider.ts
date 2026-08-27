import type {
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
 * the verification URL to extract the raw token and compare its SHA-256
 * against the persisted hash; the token itself is never printed, snapshotted,
 * or placed in an assertion message.
 */
export interface FakeEmailProvider {
  provider: EmailProvider;
  verifications: VerificationEmailInput[];
  passwordResets: PasswordResetEmailInput[];
  invitations: InvitationEmailInput[];
}

export function createFakeEmailProvider(): FakeEmailProvider {
  const verifications: VerificationEmailInput[] = [];
  const passwordResets: PasswordResetEmailInput[] = [];
  const invitations: InvitationEmailInput[] = [];

  return {
    verifications,
    passwordResets,
    invitations,
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
  };
}

/** Pulls the raw token out of a captured link without ever logging it. */
export function extractToken(verificationUrl: string): string | null {
  return new URL(verificationUrl).searchParams.get("token");
}
