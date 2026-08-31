import { Resend } from "resend";

import { logger } from "../logger";
import { describeActionUrl, maskEmailAddress } from "./redaction";

import type {
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

function verificationEmail(url: string): EmailContent {
  return {
    subject: "Verify your email address",
    text: `Welcome to Serviqo.\n\nConfirm your email address by opening this link:\n${url}\n\nIf you didn't create a Serviqo account, you can ignore this email.`,
    html:
      `<p>Welcome to Serviqo.</p>` +
      `<p>Confirm your email address by clicking the link below.</p>` +
      `<p><a href="${escapeHtml(url)}">Verify email address</a></p>` +
      `<p>If you didn't create a Serviqo account, you can ignore this email.</p>`,
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
        input.verificationUrl,
        verificationEmail(input.verificationUrl),
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
  };
}
