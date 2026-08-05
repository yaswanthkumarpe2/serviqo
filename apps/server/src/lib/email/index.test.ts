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

async function loadResolver(nodeEnv: string) {
  vi.resetModules();
  process.env = { ...originalEnv, ...BASE_ENV, NODE_ENV: nodeEnv };
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
  it("fails fast in production when no real provider is configured", async () => {
    const resolveEmailProvider = await loadResolver("production");
    expect(() => resolveEmailProvider()).toThrow(/production EmailProvider/i);
  });

  it("does not fall back to the console provider in production", async () => {
    const resolveEmailProvider = await loadResolver("production");
    let resolved: unknown;
    try {
      resolved = resolveEmailProvider();
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });
});
