/**
 * Vendor-independent email boundary (ADR-002 §4).
 *
 * Authentication and organization services depend on this interface only —
 * they never import an SMTP client or a vendor SDK. Swapping in Resend, SES,
 * Postmark, or SendGrid later means adding one implementation, not touching
 * auth code.
 *
 * The provider receives READY-TO-USE values — a URL, or since ADR-030 a code
 * that has already been minted and hashed elsewhere. It deliberately does not
 * generate or hash tokens, build authentication state, query MongoDB, or know
 * anything about User, AccountToken, or Membership documents. Keeping the boundary
 * this thin is what stops delivery concerns from leaking into security logic
 * and vice versa.
 */

export interface VerificationEmailInput {
  to: string;
  /**
   * The six-digit code the recipient retypes (ADR-030 §6).
   *
   * THE credential. It must appear in the message body and nowhere else —
   * not in the subject, which mail clients show in notifications and
   * previews on a locked screen, and not in the URL below.
   */
  code: string;
  /**
   * Where the recipient types the code. Carries the address for prefill and
   * NO secret, so unlike the link it replaced it is harmless in a referrer
   * header, a browser history, or a screenshot.
   */
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
