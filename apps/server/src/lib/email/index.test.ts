import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The guard reads NODE_ENV through `lib/env`, which validates at module
 * load — so switching environments means re-importing both modules under a
 * different process.env rather than mutating anything at runtime.
 */
const BASE_ENV = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:27017/serviqo-test",
  CLIENT_URL: "http://localhost:5173",
  LOG_LEVEL: "silent",
};

const originalEnv = { ...process.env };

async function loadResolver(nodeEnv: string, overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env = { ...originalEnv, ...BASE_ENV, NODE_ENV: nodeEnv };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import("./index")).resolveEmailProvider;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("resolveEmailProvider", () => {
  it("resolves the console provider in development", async () => {
    const resolveEmailProvider = await loadResolver("development");
    const provider = resolveEmailProvider();

    expect(typeof provider.sendVerification).toBe("function");
    expect(typeof provider.sendPasswordReset).toBe("function");
    expect(typeof provider.sendInvitation).toBe("function");
  });

  it("resolves the console provider in test", async () => {
    const resolveEmailProvider = await loadResolver("test");
    expect(() => resolveEmailProvider()).not.toThrow();
  });

  // A production server that boots and then silently discards every
  // verification email is the failure this guard exists for (ADR-007 §10).
  it("fails fast in production when RESEND_API_KEY and EMAIL_FROM are unset", async () => {
    const resolveEmailProvider = await loadResolver("production", {
      RESEND_API_KEY: undefined,
      EMAIL_FROM: undefined,
    });
    expect(() => resolveEmailProvider()).toThrow(/production EmailProvider/i);
  });

  it("fails fast in production when only RESEND_API_KEY is set", async () => {
    const resolveEmailProvider = await loadResolver("production", {
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: undefined,
    });
    expect(() => resolveEmailProvider()).toThrow(/production EmailProvider/i);
  });

  it("fails fast in production when only EMAIL_FROM is set", async () => {
    const resolveEmailProvider = await loadResolver("production", {
      RESEND_API_KEY: undefined,
      EMAIL_FROM: "Serviqo <noreply@serviqo.test>",
    });
    expect(() => resolveEmailProvider()).toThrow(/production EmailProvider/i);
  });

  it("does not fall back to the console provider in production when unconfigured", async () => {
    const resolveEmailProvider = await loadResolver("production", {
      RESEND_API_KEY: undefined,
      EMAIL_FROM: undefined,
    });
    let resolved: unknown;
    try {
      resolved = resolveEmailProvider();
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });

  // Constructing the Resend provider never calls `.send()`, so this
  // resolves the real SDK client with no network request — safe to run
  // in CI with no real API key.
  it("resolves the Resend provider in production when RESEND_API_KEY and EMAIL_FROM are set", async () => {
    const resolveEmailProvider = await loadResolver("production", {
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "Serviqo <noreply@serviqo.test>",
    });

    const provider = resolveEmailProvider();

    expect(typeof provider.sendVerification).toBe("function");
    expect(typeof provider.sendPasswordReset).toBe("function");
    expect(typeof provider.sendInvitation).toBe("function");
  });
});
