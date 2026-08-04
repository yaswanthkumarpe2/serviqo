import { beforeEach, describe, expect, it } from "vitest";

import { createConsoleEmailProvider } from "./consoleEmailProvider";
import type { EmailLogger } from "./consoleEmailProvider";

/** Obvious sentinel — if it ever reaches a log line, these tests fail. */
const SECRET = "DO_NOT_LOG_THIS_SECRET";
const RECIPIENT = "yaswanth@example.com";

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

/**
 * Minimal capture logger. The production Pino instance is left untouched —
 * the provider takes its logger as a parameter precisely so tests never need
 * to reconfigure or weaken real logging.
 */
function createCapturingLogger() {
  const entries: CapturedLog[] = [];
  const log: EmailLogger = {
    info(payload, message) {
      entries.push({ payload, message });
    },
  };
  return { log, entries };
}

/** Everything the provider handed the logger, as one searchable string. */
function serializeAll(entries: CapturedLog[]): string {
  return entries.map((entry) => `${JSON.stringify(entry.payload)} ${entry.message}`).join("\n");
}

describe("ConsoleEmailProvider", () => {
  let capture: ReturnType<typeof createCapturingLogger>;

  beforeEach(() => {
    capture = createCapturingLogger();
  });

  describe("resolution", () => {
    it("sendVerification resolves", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await expect(
        provider.sendVerification({ to: RECIPIENT, verificationUrl: "http://localhost:5173/verify-email?token=a" }),
      ).resolves.toBeUndefined();
    });

    it("sendPasswordReset resolves", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await expect(
        provider.sendPasswordReset({ to: RECIPIENT, resetUrl: "http://localhost:5173/reset-password?token=a" }),
      ).resolves.toBeUndefined();
    });

    it("sendInvitation resolves", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await expect(
        provider.sendInvitation({
          to: RECIPIENT,
          organizationName: "Acme Support",
          invitationUrl: "http://localhost:5173/invitations?token=a",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("event identification", () => {
    it("identifies a verification email", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      expect(capture.entries).toHaveLength(1);
      expect(capture.entries[0]!.payload.event).toBe("email.dev.verification");
    });

    it("identifies a password-reset email", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendPasswordReset({
        to: RECIPIENT,
        resetUrl: "http://localhost:5173/reset-password?token=a",
      });

      expect(capture.entries[0]!.payload.event).toBe("email.dev.password_reset");
    });

    it("identifies an invitation email", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendInvitation({
        to: RECIPIENT,
        organizationName: "Acme Support",
        invitationUrl: "http://localhost:5173/invitations?token=a",
      });

      expect(capture.entries[0]!.payload.event).toBe("email.dev.invitation");
    });

    it("marks delivery as console so dev logs are never mistaken for real sends", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      expect(capture.entries[0]!.payload.delivery).toBe("console");
      expect(capture.entries[0]!.message).toMatch(/not delivered/i);
    });
  });

  describe("secret leakage", () => {
    it("never logs a raw verification token", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: `http://localhost:5173/verify-email?token=${SECRET}`,
      });

      expect(serializeAll(capture.entries)).not.toContain(SECRET);
    });

    it("never logs a raw password-reset token", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendPasswordReset({
        to: RECIPIENT,
        resetUrl: `http://localhost:5173/reset-password?token=${SECRET}`,
      });

      expect(serializeAll(capture.entries)).not.toContain(SECRET);
    });

    it("never logs a raw invitation token", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendInvitation({
        to: RECIPIENT,
        organizationName: "Acme Support",
        invitationUrl: `http://localhost:5173/invitations?token=${SECRET}`,
      });

      expect(serializeAll(capture.entries)).not.toContain(SECRET);
    });

    it("never logs the full action URL", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      const fullUrl = `http://localhost:5173/verify-email?token=${SECRET}&ref=welcome`;
      await provider.sendVerification({ to: RECIPIENT, verificationUrl: fullUrl });

      const serialized = serializeAll(capture.entries);
      expect(serialized).not.toContain(fullUrl);
      expect(serialized).not.toContain("ref=welcome");
      expect(serialized).not.toContain("welcome");
    });

    it("never logs a URL fragment", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: `http://localhost:5173/verify-email#${SECRET}`,
      });

      expect(serializeAll(capture.entries)).not.toContain(SECRET);
    });

    it("keeps non-sensitive action information available for debugging", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: `http://localhost:5173/verify-email?token=${SECRET}`,
      });

      const url = capture.entries[0]!.payload.url as Record<string, unknown>;
      expect(url.path).toBe("/verify-email");
      expect(url.origin).toBe("http://localhost:5173");
      expect(url.hasToken).toBe(true);
    });
  });

  describe("recipient masking", () => {
    it("logs a masked recipient", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      expect(capture.entries[0]!.payload.recipient).toBe("y***@example.com");
    });

    it("never logs the full recipient address", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      const serialized = serializeAll(capture.entries);
      expect(serialized).not.toContain(RECIPIENT);
      expect(serialized).not.toContain("yaswanth");
    });

    it("masks the recipient across all three email types", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({ to: RECIPIENT, verificationUrl: "http://x.test/v?token=a" });
      await provider.sendPasswordReset({ to: RECIPIENT, resetUrl: "http://x.test/r?token=a" });
      await provider.sendInvitation({
        to: RECIPIENT,
        organizationName: "Acme Support",
        invitationUrl: "http://x.test/i?token=a",
      });

      expect(capture.entries).toHaveLength(3);
      expect(serializeAll(capture.entries)).not.toContain("yaswanth");
      for (const entry of capture.entries) {
        expect(entry.payload.recipient).toBe("y***@example.com");
      }
    });
  });

  describe("robustness", () => {
    it("does not crash on a malformed action URL", async () => {
      const provider = createConsoleEmailProvider(capture.log);

      await expect(
        provider.sendVerification({ to: RECIPIENT, verificationUrl: "not-a-valid-url" }),
      ).resolves.toBeUndefined();
    });

    it("still produces a safe diagnostic representation for a malformed URL", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      await provider.sendVerification({
        to: RECIPIENT,
        verificationUrl: `garbage::${SECRET}`,
      });

      const url = capture.entries[0]!.payload.url as Record<string, unknown>;
      expect(url.path).toBe("(unparseable)");
      expect(serializeAll(capture.entries)).not.toContain(SECRET);
    });

    it("does not mutate the supplied input object", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      const input = {
        to: RECIPIENT,
        organizationName: "Acme Support",
        invitationUrl: `http://localhost:5173/invitations?token=${SECRET}`,
      };
      const snapshot = { ...input };

      await provider.sendInvitation(input);

      expect(input).toEqual(snapshot);
    });

    it("accepts a frozen input object", async () => {
      const provider = createConsoleEmailProvider(capture.log);
      const input = Object.freeze({
        to: RECIPIENT,
        verificationUrl: "http://localhost:5173/verify-email?token=a",
      });

      await expect(provider.sendVerification(input)).resolves.toBeUndefined();
    });
  });
});
