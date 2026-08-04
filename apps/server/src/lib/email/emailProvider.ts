/**
 * Vendor-independent email boundary (ADR-002 §4).
 *
 * Authentication and organization services depend on this interface only —
 * they never import an SMTP client or a vendor SDK. Swapping in Resend, SES,
 * Postmark, or SendGrid later means adding one implementation, not touching
 * auth code.
 *
 * The provider receives READY-TO-USE URLs. It deliberately does not generate
 * or hash tokens, build authentication state, query MongoDB, or know anything
 * about User, AccountToken, or Membership documents. Keeping the boundary
 * this thin is what stops delivery concerns from leaking into security logic
 * and vice versa.
 */

export interface VerificationEmailInput {
  to: string;
  /** Fully-formed link the recipient clicks; contains a secret token. */
  verificationUrl: string;
}

export interface PasswordResetEmailInput {
  to: string;
  /** Fully-formed link the recipient clicks; contains a secret token. */
  resetUrl: string;
}

export interface InvitationEmailInput {
  to: string;
  organizationName: string;
  /** Fully-formed link the recipient clicks; contains a secret token. */
  invitationUrl: string;
}

export interface EmailProvider {
  sendVerification(input: VerificationEmailInput): Promise<void>;
  sendPasswordReset(input: PasswordResetEmailInput): Promise<void>;
  sendInvitation(input: InvitationEmailInput): Promise<void>;
}
