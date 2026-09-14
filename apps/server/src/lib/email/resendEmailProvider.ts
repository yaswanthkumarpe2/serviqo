import { Resend } from "resend";

import {
  EMAIL_VERIFICATION_CODE_LENGTH,
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
} from "../../config/constants";

import { logger } from "../logger";
import { describeActionUrl, maskEmailAddress } from "./redaction";

import type {
  AgentCredentialsEmailInput,
  EmailProvider,
  InvitationEmailInput,
  PasswordResetEmailInput,
  VerificationEmailInput,
} from "./emailProvider";

/**
 * The one piece of the Resend SDK this provider calls. Declared as its own
 * interface — mirroring `EmailLogger` in `consoleEmailProvider.ts` — so
 * tests can inject a fake that asserts on what was sent and returns a
 * synthetic response, with no real API key and no network call. The real
 * `Resend(apiKey).emails` object satisfies this structurally.
 */
export interface ResendEmailsClient {
  send(payload: { from: string; to: string; subject: string; html: string; text: string }): Promise<{
    data: { id: string } | null;
    error: { message: string; name: string; statusCode: number | null } | null;
  }>;
}

/**
 * Minimal structural logger this provider needs: `info` for a delivered
 * email, `error` for a failed one. Pino satisfies this; tests supply a
 * capture object instead, the same pattern `consoleEmailProvider.ts` uses.
 */
export interface EmailDeliveryLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface ResendEmailProviderOptions {
  /** Resend API key (`RESEND_API_KEY`). Never logged. */
  apiKey: string;
  /** Verified sender address (`EMAIL_FROM`), e.g. `"Serviqo <noreply@yourdomain.com>"`. */
  from: string;
  /** Injected in tests; defaults to the real Resend SDK built from `apiKey`. */
  client?: ResendEmailsClient;
  log?: EmailDeliveryLogger;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** The code's lifetime, in the units a person reads (ADR-030 §3). */
const VERIFICATION_EXPIRY_MINUTES = Math.round(EMAIL_VERIFICATION_TOKEN_TTL_MS / 60_000);

/**
 * The verification email (ADR-030 §6).
 *
 * The code is in the BODY and deliberately not in the subject. A subject
 * line is shown in notification banners and on locked screens, and a
 * credential that is readable without unlocking the device is a credential
 * anyone holding the phone can use.
 *
 * The message states the expiry, because a code that stops working with no
 * explanation reads as a broken product rather than an expired credential,
 * and sends the recipient to resend rather than to support.
 *
 * The link carries no secret — it only opens the page and prefills the
 * address (see `buildVerificationUrl`). Both are offered because a
 * recipient reading mail on a phone and signing up on a laptop can retype
 * six digits, which is the entire ergonomic argument for codes over links.
 */
function verificationEmail(code: string, url: string): EmailContent {
  return {
    subject: "Verify your email address",
    text:
      `Welcome to Serviqo.\n\n` +
      `Your ${EMAIL_VERIFICATION_CODE_LENGTH}-digit verification code is:\n\n` +
      `${code}\n\n` +
      `Enter it at ${url}\n\n` +
      `The code expires in ${VERIFICATION_EXPIRY_MINUTES} minutes.\n\n` +
      `If you didn't create a Serviqo account, you can ignore this email — ` +
      `nobody can use this code without it.`,
    html:
      `<p>Welcome to Serviqo.</p>` +
      `<p>Your ${EMAIL_VERIFICATION_CODE_LENGTH}-digit verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">` +
      `${escapeHtml(code)}</p>` +
      `<p>Enter it at <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
      `<p>The code expires in ${VERIFICATION_EXPIRY_MINUTES} minutes.</p>` +
      `<p>If you didn't create a Serviqo account, you can ignore this email — ` +
      `nobody can use this code without it.</p>`,
  };
}

/**
 * The mail an admin-created agent receives (ADR-034 §7).
 *
 * Says what happened, hands over the two things they need, and names the order
 * they must be used in — verify first, then sign in — because an agent who
 * tries the password before verifying is refused and the message should have
 * told them why in advance rather than leaving them to discover it.
 */
function agentCredentialsEmail(
  organizationName: string,
  temporaryPassword: string,
  code: string,
  verificationUrl: string,
  signInUrl: string,
): EmailContent {
  return {
    subject: `You've been added to ${organizationName} on Serviqo`,
    text:
      `You've been added to ${organizationName} as a support agent.

` +
      `Two steps, in this order.

` +
      `1. Verify this address. Your ${EMAIL_VERIFICATION_CODE_LENGTH}-digit code is:

` +
      `   ${code}

` +
      `   Enter it at ${verificationUrl}
` +
      `   The code expires in ${VERIFICATION_EXPIRY_MINUTES} minutes.

` +
      `2. Sign in at ${signInUrl} with this temporary password:

` +
      `   ${temporaryPassword}

` +
      `Change it once you are in. This password is not stored anywhere and ` +
      `cannot be sent to you again — if you lose this email, ask your admin ` +
      `to add you again.

` +
      `If you weren't expecting this, ignore it: the account cannot be used ` +
      `until the code above is entered.`,
    html:
      `<p>You've been added to <strong>${escapeHtml(organizationName)}</strong> as a support agent.</p>` +
      `<p>Two steps, in this order.</p>` +
      `<p><strong>1. Verify this address.</strong> Your ${EMAIL_VERIFICATION_CODE_LENGTH}-digit code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">` +
      `${escapeHtml(code)}</p>` +
      `<p>Enter it at <a href="${escapeHtml(verificationUrl)}">${escapeHtml(verificationUrl)}</a>. ` +
      `The code expires in ${VERIFICATION_EXPIRY_MINUTES} minutes.</p>` +
      `<p><strong>2. Sign in</strong> at <a href="${escapeHtml(signInUrl)}">${escapeHtml(signInUrl)}</a> ` +
      `with this temporary password:</p>` +
      `<p style="font-size:18px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">` +
      `${escapeHtml(temporaryPassword)}</p>` +
      `<p>Change it once you are in. This password is not stored anywhere and cannot be sent to you ` +
      `again — if you lose this email, ask your admin to add you again.</p>` +
      `<p>If you weren't expecting this, ignore it: the account cannot be used until the code above ` +
      `is entered.</p>`,
  };
}

function passwordResetEmail(url: string): EmailContent {
  return {
    subject: "Reset your password",
    text: `We received a request to reset your Serviqo password.\n\nChoose a new password by opening this link:\n${url}\n\nIf you didn't request this, you can ignore this email.`,
    html:
      `<p>We received a request to reset your Serviqo password.</p>` +
      `<p>Choose a new password by clicking the link below.</p>` +
      `<p><a href="${escapeHtml(url)}">Reset password</a></p>` +
      `<p>If you didn't request this, you can ignore this email.</p>`,
  };
}

function invitationEmail(organizationName: string, url: string): EmailContent {
  return {
    subject: `You've been invited to join ${organizationName} on Serviqo`,
    text: `${organizationName} has invited you to join their team on Serviqo.\n\nAccept the invitation by opening this link:\n${url}\n\nIf you weren't expecting this invitation, you can ignore this email.`,
    html:
      `<p>${escapeHtml(organizationName)} has invited you to join their team on Serviqo.</p>` +
      `<p><a href="${escapeHtml(url)}">Accept invitation</a></p>` +
      `<p>If you weren't expecting this invitation, you can ignore this email.</p>`,
  };
}

function buildClient(apiKey: string): ResendEmailsClient {
  return new Resend(apiKey).emails;
}

/**
 * Production email provider: delivers through Resend (ADR-007 §10's real
 * provider requirement — `resolveEmailProvider` refuses to boot without
 * one).
 *
 * Mirrors `ConsoleEmailProvider`'s redaction discipline for everything it
 * LOGS: success and failure lines alike go through `describeActionUrl` /
 * `maskEmailAddress` and never carry a raw URL, token, or full recipient
 * address. That discipline covers the log stream only — the outgoing email
 * itself still carries the real link, or nobody could verify an address or
 * reset a password.
 *
 * A failed send rejects the returned promise rather than swallowing the
 * error, matching `ConsoleEmailProvider`'s contract (which never fails) and
 * the callers' existing handling — e.g. `registration.service.ts` already
 * catches this, logs it, and lets the request succeed anyway: delivery is
 * not persistence.
 */
export function createResendEmailProvider({
  apiKey,
  from,
  client = buildClient(apiKey),
  log = logger,
}: ResendEmailProviderOptions): EmailProvider {
  async function deliver(event: string, to: string, actionUrl: string, content: EmailContent): Promise<void> {
    const recipient = maskEmailAddress(to);
    const url = describeActionUrl(actionUrl);

    const { data, error } = await client.send({
      from,
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });

    if (error !== null) {
      log.error(
        {
          event: `${event}.failed`,
          delivery: "resend",
          recipient,
          url,
          errorName: error.name,
          errorMessage: error.message,
        },
        "Email delivery via Resend failed",
      );
      throw new Error(`Resend email delivery failed: ${error.name}`);
    }

    log.info(
      {
        event,
        delivery: "resend",
        recipient,
        url,
        messageId: data?.id,
      },
      "Email delivered via Resend",
    );
  }

  return {
    async sendVerification(input: VerificationEmailInput): Promise<void> {
      await deliver(
        "email.resend.verification",
        input.to,
        // The URL is what gets logged, and it holds no secret by design —
        // the code is passed to the template and never to the logger.
        input.verificationUrl,
        verificationEmail(input.code, input.verificationUrl),
      );
    },

    async sendPasswordReset(input: PasswordResetEmailInput): Promise<void> {
      await deliver("email.resend.password_reset", input.to, input.resetUrl, passwordResetEmail(input.resetUrl));
    },

    async sendInvitation(input: InvitationEmailInput): Promise<void> {
      await deliver(
        "email.resend.invitation",
        input.to,
        input.invitationUrl,
        invitationEmail(input.organizationName, input.invitationUrl),
      );
    },

    async sendAgentCredentials(input: AgentCredentialsEmailInput): Promise<void> {
      await deliver(
        "email.resend.agent_credentials",
        input.to,
        // The VERIFICATION url is what reaches the log, and it carries no
        // secret by design. The password and the code go to the template and
        // never to the logger.
        input.verificationUrl,
        agentCredentialsEmail(
          input.organizationName,
          input.temporaryPassword,
          input.code,
          input.verificationUrl,
          input.signInUrl,
        ),
      );
    },
  };
}
