import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `lib/env` validates eagerly at module load, so each case re-imports it
 * under a different process.env. `vi.resetModules()` is what makes the
 * re-import actually re-run validation instead of returning a cached module.
 */
const BASE_ENV = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:27017/serviqo-test",
  CLIENT_URL: "http://localhost:5173",
  LOG_LEVEL: "silent",
};

const originalEnv = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...originalEnv, ...BASE_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import("./index")).env;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("CLIENT_URL validation", () => {
  it("accepts an http origin", async () => {
    const env = await loadEnv({ CLIENT_URL: "http://localhost:5173" });
    expect(env.CLIENT_URL).toBe("http://localhost:5173");
  });

  it("accepts an https origin", async () => {
    const env = await loadEnv({ CLIENT_URL: "https://app.serviqo.test" });
    expect(env.CLIENT_URL).toBe("https://app.serviqo.test");
  });

  it("strips trailing slashes so URL joining is deterministic", async () => {
    const env = await loadEnv({ CLIENT_URL: "https://app.serviqo.test///" });
    expect(env.CLIENT_URL).toBe("https://app.serviqo.test");
  });

  it("rejects a missing value rather than defaulting", async () => {
    await expect(loadEnv({ CLIENT_URL: undefined })).rejects.toThrow(/CLIENT_URL/);
  });

  it("rejects an empty value", async () => {
    await expect(loadEnv({ CLIENT_URL: "" })).rejects.toThrow(/CLIENT_URL/);
  });

  it("rejects a value that is not a URL", async () => {
    await expect(loadEnv({ CLIENT_URL: "not a url" })).rejects.toThrow(/valid absolute URL/);
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(loadEnv({ CLIENT_URL: "ftp://files.serviqo.test" })).rejects.toThrow(/http or https/);
  });

  it("rejects a query string", async () => {
    await expect(loadEnv({ CLIENT_URL: "https://app.serviqo.test?tenant=acme" })).rejects.toThrow(/query string/);
  });

  it("rejects a fragment", async () => {
    await expect(loadEnv({ CLIENT_URL: "https://app.serviqo.test#section" })).rejects.toThrow(/fragment/);
  });

  // A misconfigured URL can still hold something its operator would not want
  // in a crash log or a CI transcript.
  it("does not echo the offending value in the failure message", async () => {
    const offending = "ftp://do-not-echo-this-host.invalid";
    await expect(loadEnv({ CLIENT_URL: offending })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("do-not-echo-this-host") }),
    );
  });
});

describe("existing environment contract", () => {
  it("still requires MONGODB_URI", async () => {
    await expect(loadEnv({ MONGODB_URI: undefined })).rejects.toThrow(/MONGODB_URI/);
  });

  it("still defaults PORT and LOG_LEVEL", async () => {
    const env = await loadEnv({ PORT: undefined, LOG_LEVEL: undefined });
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
  });
});
