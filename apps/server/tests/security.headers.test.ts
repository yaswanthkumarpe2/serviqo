import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";

/**
 * Security response headers (ADR-018 §9).
 *
 * No database: every assertion here is about what leaves the server, and
 * every route below answers without touching Mongo — 401s, 404s, and the
 * liveness probe.
 */

function buildApp() {
  return createApp({ emailProvider: createFakeEmailProvider().provider });
}

describe("security headers", () => {
  it("sets nosniff on API responses", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends no referrer", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");

    // API URLs carry organization ids (ADR-017 §1); none of that belongs in
    // a Referer sent to a third party.
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("refuses to be framed", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");

    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  /*
    A JSON response should load nothing. helmet's default policy names
    script/style/img sources, which is meaningful for a document and
    meaningless here — and would break Vite's inline bootstrap if this server
    ever served the SPA.
  */
  it("uses a policy written for JSON rather than for documents", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");
    const csp = response.headers["content-security-policy"];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // The document-oriented directives helmet would have added.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("style-src");
    expect(csp).not.toContain("img-src");
  });

  it("stops advertising Express", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("declares a same-origin resource policy", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");

    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  /*
    HSTS is meaningless over the HTTP development uses, and a stray pin
    issued to localhost outlives the experiment that set it — it would break
    every other local project on that host (ADR-018 §9).
  */
  it("sends no HSTS outside production", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/me");

    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  // Headers must be present on responses that never reach a route.
  it.each([
    ["an unauthenticated API request", "/api/v1/auth/me"],
    ["an unknown path", "/api/v1/nothing-here"],
    ["the health probe", "/health"],
  ])("sets them on %s", async (_label, path) => {
    const response = await request(buildApp()).get(path);

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("sets them on a validation failure", async () => {
    const response = await request(buildApp()).post("/api/v1/auth/login").send({ email: "not-an-email" });

    expect(response.status).toBe(400);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  /*
    CORS is deliberately absent until the widget slice (ADR-018 §9, ADR-010
    §9). Every caller is same-origin today — vite.config.ts proxies /api — and
    the widget needs a per-tenant allowed-origin list rather than a blanket
    policy. This asserts the absence so enabling it becomes a deliberate act.
  */
  it("declares no CORS policy yet", async () => {
    const response = await request(buildApp())
      .get("/api/v1/auth/me")
      .set("Origin", "https://some-tenant.example.com");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("still answers normally with the headers attached", async () => {
    const response = await request(buildApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
