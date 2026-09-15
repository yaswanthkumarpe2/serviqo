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
 *
 * The policy is chosen per request from the path, not from what the route
 * eventually returns, so these assertions hold under `NODE_ENV=test` even
 * though the static file server and SPA fallback are mounted in production
 * only — `/` and `/assets/...` 404 here and still carry the document policy
 * they will carry in production.
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
    meaningless here — the document policy below is where those belong, and
    keeping them off API responses is what makes `default-src 'none'` mean
    something.
  */
  it("uses a policy written for JSON rather than for documents on API paths", async () => {
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

  it("declares a same-origin resource policy on API responses", async () => {
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

  /*
    The bug this suite exists to keep fixed. `app.ts` serves `apps/web/dist`
    with an `index.html` fallback in production, and the API's
    `default-src 'none'` forbids that document its own bundle — a blank page
    and a CSP violation in the console, invisible in development because
    there Vite serves the frontend and this server sends no HTML at all.
  */
  describe("the document policy", () => {
    it.each([
      ["the SPA document", "/"],
      ["a client-side route", "/organizations"],
      ["a hashed bundle", "/assets/index-CS5Fjmy_.js"],
      ["a hashed stylesheet", "/assets/index-D2cUaxfG.css"],
    ])("lets %s load its own script and stylesheet", async (_label, path) => {
      const csp = (await request(buildApp()).get(path)).headers["content-security-policy"];

      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    });

    /*
      The concession is to style-src and nowhere else: the widget builds its
      shadow-root stylesheet as a runtime `<style>` element and React writes
      inline `style` attributes, while `vite build` emits no inline script at
      all. If script-src ever loosens, the policy has stopped being worth
      having.
    */
    it("allows no inline script", async () => {
      const csp = (await request(buildApp()).get("/")).headers["content-security-policy"];

      expect(csp).toContain("script-src 'self';");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).not.toContain("unsafe-eval");
    });

    it("names the webfont host the document links", async () => {
      const csp = (await request(buildApp()).get("/")).headers["content-security-policy"];

      expect(csp).toContain("font-src https://fonts.gstatic.com");
    });

    it("allows the API and the same-origin Socket.IO upgrade", async () => {
      const csp = (await request(buildApp()).get("/")).headers["content-security-policy"];

      expect(csp).toContain("connect-src 'self'");
    });

    it("keeps default-src as the floor for everything unnamed", async () => {
      const csp = (await request(buildApp()).get("/")).headers["content-security-policy"];

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("img-src 'self' data: blob:");
    });

    // Unlike the API's `form-action 'none'`: the dashboard has real forms.
    it("refuses to be framed and submits only to itself", async () => {
      const response = await request(buildApp()).get("/");
      const csp = response.headers["content-security-policy"];

      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    });

    it("still carries the headers that do not depend on what is served", async () => {
      const response = await request(buildApp()).get("/");

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });

    it("does not reach API paths", async () => {
      const csp = (await request(buildApp()).get("/api/v1/auth/me")).headers[
        "content-security-policy"
      ];

      expect(csp).not.toContain("script-src");
      expect(csp).not.toContain("connect-src");
    });
  });

  /*
    `/widget.js` exists to be loaded by tenant sites on other origins (ADR-021
    §1). `same-origin` CORP blocks exactly that — which is why the widget
    works against `widget-test.html` served from our own origin and would fail
    on a real customer's site.
  */
  describe("the widget loader", () => {
    it("may be loaded cross-origin", async () => {
      const response = await request(buildApp()).get("/widget.js");

      expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    });

    it("carries the document policy otherwise", async () => {
      const response = await request(buildApp()).get("/widget.js");
      const csp = response.headers["content-security-policy"];

      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    /*
      The carve-out is one exact path, not a prefix: nothing else on this
      server becomes readable cross-origin by being named similarly.
    */
    it.each([
      ["the SPA document", "/"],
      ["a bundle", "/assets/index-CS5Fjmy_.js"],
      ["a lookalike path", "/widget.js.map"],
      ["an API response", "/api/v1/auth/me"],
    ])("does not open %s cross-origin", async (_label, path) => {
      const response = await request(buildApp()).get(path);

      expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    });
  });

  it("still answers normally with the headers attached", async () => {
    const response = await request(buildApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
