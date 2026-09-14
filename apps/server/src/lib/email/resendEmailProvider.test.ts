import { beforeEach, describe, expect, it } from "vitest";

import { createResendEmailProvider } from "./resendEmailProvider";

import type { EmailDeliveryLogger, ResendEmailsClient } from "./resendEmailProvider";

/** Obvious sentinel — if it ever reaches a log line, these tests fail. */
const SECRET = "DO_NOT_LOG_THIS_SECRET";
const RECIPIENT = "yaswanth@example.com";
const API_KEY = "re_test_key_do_not_log";
const FROM = "Serviqo <noreply@serviqo.test>";

interface CapturedLog {
  level: "info" | "error";
  payload: Record<string, unknown>;
  message: string;
}

/**
 * Minimal capture logger, mirroring `consoleEmailProvider.test.ts`'s
 * pattern — the real Pino instance is left untouched.
 */
function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const log: EmailDeliveryLogger = {
    info(payload, message) {
      entries.push({ level: "info", payload, message });
    },
    error(payload, message) {
      entries.push({ level: "error", payload, message });
    },
  };
  return { log, entries };
}

function serializeAll(entries: CapturedLog[]): string {
  return entries.map((entry) => `${JSON.stringify(entry.payload)} ${entry.message}`).join("\n");
}

/**
 * Fake Resend client — asserts on what it was called with and returns a
 * synthetic response, exactly like the SDK's `emails.send` shape. No
 * network call, no real API key required.
 */
function createFakeClient(result: Awaited<ReturnType<ResendEmailsClient["send"]>>) {
  const calls: Parameters<ResendEmailsClient["send"]>[0][] = [];
  const client: ResendEmailsClient = {
    async send(payload) {
      calls.push(payload);
      return result;
    },
  };
  return { client, calls };
}

describe("ResendEmailProvider", () => {
  let capture: ReturnType<typeof createCapturingLogger>;

  beforeEach(() => {
    capture = createCapturingLogger();
  });

  describe("sending", () => {
    it("sends the verification email through the injected client, using the configured sender", async () => {
      const { client, calls } = createFakeClient({ data: { id: "msg_1" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendVerification({
        to: RECIPIENT,
        code: "481920",
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.from).toBe(FROM);
      expect(calls[0]!.to).toBe(RECIPIENT);
      expect(calls[0]!.html).toContain("http://localhost:5173/verify-email?token=a");
      expect(calls[0]!.text).toContain("http://localhost:5173/verify-email?token=a");
    });

    it("sends the password-reset email with the reset URL in the body", async () => {
      const { client, calls } = createFakeClient({ data: { id: "msg_2" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendPasswordReset({
        to: RECIPIENT,
        code: "123456",
        resetUrl: "http://localhost:5173/reset-password?token=a",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.html).toContain("http://localhost:5173/reset-password?token=a");
      expect(calls[0]!.text).toContain("http://localhost:5173/reset-password?token=a");
    });

    // ADR-036 §1: the code is the credential, so it belongs in the body and
    // never in a subject a locked phone shows.
    it("puts the reset code in the body and keeps it out of the subject", async () => {
      const { client, calls } = createFakeClient({ data: { id: "msg_2b" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendPasswordReset({
        to: RECIPIENT,
        code: "730418",
        resetUrl: "http://localhost:5173/reset-password?email=a%40example.com",
      });

      expect(calls[0]!.text).toContain("730418");
      expect(calls[0]!.html).toContain("730418");
      expect(calls[0]!.subject).not.toContain("730418");
      expect(JSON.stringify(capture.entries)).not.toContain("730418");
    });

    it("sends the invitation email with the organization name and invitation URL", async () => {
      const { client, calls } = createFakeClient({ data: { id: "msg_3" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendInvitation({
        to: RECIPIENT,
        organizationName: "Acme Support",
        roleLabel: "a support agent",
        invitationUrl: "http://localhost:5173/invitations?token=a",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.subject).toContain("Acme Support");
      expect(calls[0]!.html).toContain("Acme Support");
      expect(calls[0]!.html).toContain("http://localhost:5173/invitations?token=a");
    });

    it("HTML-escapes an organization name containing markup", async () => {
      const { client, calls } = createFakeClient({ data: { id: "msg_4" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendInvitation({
        to: RECIPIENT,
        organizationName: '<script>alert("x")</script>',
        roleLabel: "a support agent",
        invitationUrl: "http://localhost:5173/invitations?token=a",
      });

      expect(calls[0]!.html).not.toContain("<script>");
    });

    it("constructs a working client from apiKey/from alone, with no client injected (no network call made)", async () => {
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, log: capture.log });

      expect(typeof provider.sendVerification).toBe("function");
      expect(typeof provider.sendPasswordReset).toBe("function");
      expect(typeof provider.sendInvitation).toBe("function");
    });
  });

  describe("success logging", () => {
    it("logs delivery as resend with a masked recipient and no raw token", async () => {
      const { client } = createFakeClient({ data: { id: "msg_5" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendVerification({
        to: RECIPIENT,
        code: "481920",
        verificationUrl: `http://localhost:5173/verify-email?token=${SECRET}`,
      });

      expect(capture.entries).toHaveLength(1);
      expect(capture.entries[0]!.level).toBe("info");
      expect(capture.entries[0]!.payload.delivery).toBe("resend");
      expect(capture.entries[0]!.payload.recipient).toBe("y***@example.com");
      expect(capture.entries[0]!.payload.messageId).toBe("msg_5");
      expect(serializeAll(capture.entries)).not.toContain(SECRET);
      expect(serializeAll(capture.entries)).not.toContain(RECIPIENT);
    });

    it("never logs the API key", async () => {
      const { client } = createFakeClient({ data: { id: "msg_6" }, error: null });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await provider.sendVerification({
        to: RECIPIENT,
        code: "481920",
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      expect(serializeAll(capture.entries)).not.toContain(API_KEY);
    });
  });

  describe("failure handling", () => {
    it("rejects when Resend returns an error, and logs it without leaking the token", async () => {
      const { client } = createFakeClient({
        data: null,
        error: { message: "domain not verified", name: "validation_error", statusCode: 403 },
      });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await expect(
        provider.sendVerification({
          to: RECIPIENT,
          code: "481920",
        verificationUrl: `http://localhost:5173/verify-email?token=${SECRET}`,
        }),
      ).rejects.toThrow(/resend/i);

      expect(capture.entries).toHaveLength(1);
      expect(capture.entries[0]!.level).toBe("error");
      expect(capture.entries[0]!.payload.delivery).toBe("resend");
      expect(capture.entries[0]!.payload.errorName).toBe("validation_error");
      expect(serializeAll(capture.entries)).not.toContain(SECRET);
      expect(serializeAll(capture.entries)).not.toContain(RECIPIENT);
    });

    it("rejects for a failed password-reset send", async () => {
      const { client } = createFakeClient({
        data: null,
        error: { message: "rate limited", name: "rate_limit_exceeded", statusCode: 429 },
      });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await expect(
        provider.sendPasswordReset({
          to: RECIPIENT,
          code: "123456",
          resetUrl: "http://localhost:5173/reset-password?token=a",
        }),
      ).rejects.toThrow();
    });

    it("rejects for a failed invitation send", async () => {
      const { client } = createFakeClient({
        data: null,
        error: { message: "invalid from address", name: "invalid_from_address", statusCode: 422 },
      });
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, client, log: capture.log });

      await expect(
        provider.sendInvitation({
          to: RECIPIENT,
          organizationName: "Acme Support",
          roleLabel: "a support agent",
          invitationUrl: "http://localhost:5173/invitations?token=a",
        }),
      ).rejects.toThrow();
    });
  });
});
