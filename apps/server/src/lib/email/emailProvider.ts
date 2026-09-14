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

/**
 * The mail an admin-created agent receives (ADR-034 §7).
 *
 * Carries TWO secrets, which is one more than any other message in this
 * system and is the reason this input exists rather than reusing
 * `InvitationEmailInput`:
 *
 * - `temporaryPassword`, because the agent did not choose one. The admin
 *   created the account, so something has to be the first credential, and the
 *   alternative — a link that sets a password — is a second token flow this
 *   product does not have yet.
 * - `code`, because the address still has to be proved. An admin typing an
 *   address is not evidence that anybody reads it.
 *
 * Both belong in the BODY and never in the subject or a URL, for the reason
 * ADR-030 §6 gives about codes: mail clients show subjects in lock-screen
 * previews, and URLs leak through referrers and browser history.
 *
 * The temporary password is delivered exactly once and is never recoverable —
 * nothing stores it, only its Argon2id hash. An agent who loses the mail needs
 * a new invitation, which is the correct answer.
 */
export interface AgentCredentialsEmailInput {
  to: string;
  organizationName: string;
  /** The generated first password. Shown once, stored never.  */
  temporaryPassword: string;
  /** The six-digit code that proves the address (ADR-030 §3). */
  code: string;
  /** Where the code is typed. Carries the address for prefill and no secret. */
  verificationUrl: string;
  /** Where they sign in afterwards — the agent door, not the customer one. */
  signInUrl: string;
}

export interface EmailProvider {
  sendVerification(input: VerificationEmailInput): Promise<void>;
  sendPasswordReset(input: PasswordResetEmailInput): Promise<void>;
  sendInvitation(input: InvitationEmailInput): Promise<void>;
  sendAgentCredentials(input: AgentCredentialsEmailInput): Promise<void>;
}
