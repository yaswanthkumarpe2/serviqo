import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { errorHandler } from "../../middleware/errorHandler";
import { createDisabledRateLimiters, createRateLimiters } from "./index";

import type { Request, Response, NextFunction } from "express";

/**
 * The limiter's own behaviour, isolated from the API surface (ADR-018 §10).
 *
 * Builds a minimal app so the assertions are about the middleware rather
 * than about any route's semantics — in particular, what reaches the log
 * when a request is refused.
 */

interface CapturedLog {
  payload: Record<string, unknown>;
  message: string;
}

/**
 * A stand-in for `requestContext`, capturing what the limiter logs instead
 * of writing it. Also lets a test attach a principal, which the user-keyed
 * classes read.
 */
function buildApp(options: { principal?: { userId: string; sessionId: string } } = {}) {
  const entries: CapturedLog[] = [];
  const record = (payload: Record<string, unknown>, message: string) => {
    entries.push({ payload, message });
  };

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log = { info: record, warn: record, error: record } as unknown as Request["log"];
    if (options.principal) req.principal = options.principal;
    next();
  });

  return { app, entries, serialized: () => JSON.stringify(entries) };
}

describe("createRateLimiters", () => {
  it("builds one limiter per class", () => {
    const limiters = createRateLimiters();

    expect(Object.keys(limiters).sort()).toEqual([
      // Agent replies, claims and closes, off the 30/hour write class (ADR-041 §5).
      "agentConversationWrite",
      // Chat attachment uploads, one class per kind of principal (ADR-041 §4).
      "attachmentUpload",
      "authenticatedRead",
      "authenticatedWrite",
      "credential",
      /*
        The eleventh, twelfth and thirteenth classes, carved out of
        `credential` by ADR-031. Sorted position puts them apart from each
        other and from the class they came from; they belong together
        conceptually — one honest sign-up touches all three.
      */
      "emailVerification",
      "global",
      /*
        The ninth class, added for `POST /organizations/:id/members`
        (ADR-027 §12). Its own class rather than `authenticatedWrite`, because
        it bounds ADR-027 §5's account-existence disclosure specifically —
        sharing a budget with role changes and removals would make ordinary
        team admin indistinguishable from probing, and tightening one would
        throttle the other.
      */
      "memberInvite",
      /*
        The tenth class, added for `POST /organizations/:id/ownership`
        (ADR-028 §11). Its own class rather than `authenticatedWrite` for the
        reason `memberInvite` is: this is the rarest and most destructive
        operation in the product, so sharing the 30/hour write budget would let
        ordinary widget-config edits exhaust it — and would hide a run of
        transfer attempts inside the write class's ordinary noise, which is the
        one pattern an operator most wants to see.
      */
      "ownershipTransfer",
      /*
        The fourteenth and fifteenth classes, for password reset (ADR-036 §5).
        Shaped like `verificationResend` and `emailVerification` respectively —
        one mails a code, one redeems it — and kept apart from them so waiting
        on one kind of mail never spends the budget for the other.
      */
      "passwordReset",
      "passwordResetRequest",
      "session",
      "verificationResend",
      // The seventh and eighth classes, added for conversation and message
      // traffic (ADR-022 §12) — customer-keyed, since a verified widget
      // principal already exists by the time these mount.
      "widgetAttachmentUpload",
      "widgetConversationRead",
      "widgetConversationWrite",
      // The public lookup behind an organisation's chat link (ADR-038 §2).
      "widgetDirectory",
      // The sixth class, added for the public widget session endpoint
      // (ADR-019 §11). ADR-010 §9 ordered it in advance: customer endpoints
      // are high-volume, anonymous, and unauthenticated by design, so they
      // cannot share a bound with staff endpoints that per-account lockout
      // also protects.
      "widgetSession",
    ]);
  });

  /*
    The disabled set must mirror the enabled one exactly, or a route would
    mount a real limiter under one configuration and `undefined` under the
    other — the conditional-mount difference `createDisabledRateLimiters`
    exists to prevent.
  */
  it("keeps the disabled set in step with the enabled one", () => {
    expect(Object.keys(createDisabledRateLimiters()).sort()).toEqual(Object.keys(createRateLimiters()).sort());
  });

  /*
    Built per call rather than shared at module scope, so one application
    instance cannot exhaust another's budget — which is what keeps test
    suites independent and matches the single instance production runs.
  */
  it("gives each set its own counters", async () => {
    const first = buildApp();
    const second = buildApp();
    const limitersA = createRateLimiters();
    const limitersB = createRateLimiters();

    first.app.post("/x", limitersA.credential, (_req, res) => void res.json({ ok: true }));
    second.app.post("/x", limitersB.credential, (_req, res) => void res.json({ ok: true }));
    first.app.use(errorHandler);
    second.app.use(errorHandler);

    // Exhaust the first set entirely.
    for (let i = 0; i < 12; i += 1) await request(first.app).post("/x").send({});

    expect((await request(first.app).post("/x").send({})).status).toBe(429);
    expect((await request(second.app).post("/x").send({})).status).toBe(200);
  });

  describe("logging", () => {
    /**
     * Exhausts the credential class and returns what was logged.
     */
    async function refuseOnce(secret: string) {
      const ctx = buildApp();
      const limiters = createRateLimiters();
      ctx.app.post("/x", limiters.credential, (_req, res) => void res.json({ ok: true }));
      ctx.app.use(errorHandler);

      for (let i = 0; i < 11; i += 1) {
        await request(ctx.app)
          .post("/x")
          .set("Authorization", `Bearer ${secret}`)
          .set("Cookie", `serviqo_refresh=${secret}`)
          .send({ email: "ada@example.com", password: secret });
      }

      return ctx;
    }

    it("records the class and nothing else about the request", async () => {
      const ctx = await refuseOnce("IRRELEVANT");

      const refusal = ctx.entries.find((e) => e.payload.event === "security.rate_limit.exceeded");
      expect(refusal).toBeDefined();
      expect(refusal!.payload.limitClass).toBe("credential");
      expect(Object.keys(refusal!.payload).sort()).toEqual(["event", "limitClass"]);
    });

    /*
      The limiter sees the whole request. None of it may reach the log
      (ADR-018 §10) — not the body, not the Authorization header, not the
      cookie.
    */
    it("logs no password, token, cookie, or email", async () => {
      const SECRET = "DO_NOT_LEAK_THIS_SECRET";
      const ctx = await refuseOnce(SECRET);

      expect(ctx.serialized()).not.toContain(SECRET);
      expect(ctx.serialized()).not.toContain("ada@example.com");
      expect(ctx.serialized()).not.toContain("Bearer");
      expect(ctx.serialized()).not.toContain("serviqo_refresh");
    });

    /*
      For IP-keyed classes the key is an IP address, and logging one per
      refusal turns the limiter into an access log nobody asked for.
    */
    it("does not log the client key", async () => {
      const ctx = await refuseOnce("IRRELEVANT");

      expect(ctx.serialized()).not.toContain("127.0.0.1");
      expect(ctx.serialized()).not.toContain("::ffff:");
      expect(ctx.serialized()).not.toMatch(/"key"|"ip"/);
    });

    it("logs nothing while requests are allowed", async () => {
      const ctx = buildApp();
      const limiters = createRateLimiters();
      ctx.app.post("/x", limiters.credential, (_req, res) => void res.json({ ok: true }));

      await request(ctx.app).post("/x").send({});

      expect(ctx.entries.filter((e) => e.payload.event === "security.rate_limit.exceeded")).toHaveLength(0);
    });
  });

  describe("keying", () => {
    /*
      The user-keyed classes read `req.principal`, which `requireAccessToken`
      established. Two principals therefore get two budgets from one socket
      (ADR-018 §4).
    */
    it("gives two users separate budgets on a user-keyed class", async () => {
      const limiters = createRateLimiters();
      const ada = buildApp({ principal: { userId: "user-ada", sessionId: "s1" } });
      const grace = buildApp({ principal: { userId: "user-grace", sessionId: "s2" } });

      for (const ctx of [ada, grace]) {
        ctx.app.post("/x", limiters.authenticatedWrite, (_req, res) => void res.json({ ok: true }));
        ctx.app.use(errorHandler);
      }

      // Exhaust Ada's write budget (30/hour).
      for (let i = 0; i < 31; i += 1) await request(ada.app).post("/x").send({});

      expect((await request(ada.app).post("/x").send({})).status).toBe(429);
      expect((await request(grace.app).post("/x").send({})).status).toBe(200);
    });

    /*
      A misordered mount — user-keyed limiter before requireAccessToken —
      degrades to the weaker IP key rather than throwing on a hot path.
    */
    it("falls back to the IP key when no principal is present", async () => {
      const ctx = buildApp();
      const limiters = createRateLimiters();
      ctx.app.post("/x", limiters.authenticatedWrite, (_req, res) => void res.json({ ok: true }));
      ctx.app.use(errorHandler);

      // Still limited, just by a different key.
      for (let i = 0; i < 31; i += 1) await request(ctx.app).post("/x").send({});

      expect((await request(ctx.app).post("/x").send({})).status).toBe(429);
    });
  });
});

describe("createDisabledRateLimiters", () => {
  it("provides the same class names", () => {
    expect(Object.keys(createDisabledRateLimiters()).sort()).toEqual(Object.keys(createRateLimiters()).sort());
  });

  /*
    Every route mounts the same middleware in the same order regardless of
    whether limiting is on. A conditional mount would mean the ordering under
    test differed from production's, which is the kind of difference that
    hides a bug until deployment (ADR-018 §8).
  */
  it("refuses nothing", async () => {
    const ctx = buildApp();
    const limiters = createDisabledRateLimiters();
    ctx.app.post("/x", limiters.credential, (_req, res) => void res.json({ ok: true }));
    ctx.app.use(errorHandler);

    for (let i = 0; i < 50; i += 1) {
      expect((await request(ctx.app).post("/x").send({})).status).toBe(200);
    }
  });

  it("sets no rate-limit headers", async () => {
    const ctx = buildApp();
    const limiters = createDisabledRateLimiters();
    ctx.app.post("/x", limiters.credential, (_req, res) => void res.json({ ok: true }));

    const response = await request(ctx.app).post("/x").send({});

    expect(response.headers["ratelimit-policy"]).toBeUndefined();
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("logs nothing", async () => {
    const ctx = buildApp();
    const limiters = createDisabledRateLimiters();
    ctx.app.post("/x", limiters.credential, (_req, res) => void res.json({ ok: true }));

    for (let i = 0; i < 20; i += 1) await request(ctx.app).post("/x").send({});

    expect(ctx.entries).toHaveLength(0);
  });
});

describe("the refusal", () => {
  it("carries Retry-After so a client can back off", async () => {
    const ctx = buildApp();
    const limiters = createRateLimiters();
    ctx.app.post("/x", limiters.credential, (_req, res) => void res.json({ ok: true }));
    ctx.app.use(errorHandler);

    for (let i = 0; i < 11; i += 1) await request(ctx.app).post("/x").send({});
    const response = await request(ctx.app).post("/x").send({});

    expect(response.status).toBe(429);
    // The library set these before the error was raised; next(err) does not
    // clear them, so they accompany the enveloped body.
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("goes through the application's error handler", async () => {
    const ctx = buildApp();
    const limiters = createRateLimiters();
    const handler = vi.fn((_req: Request, res: Response) => void res.json({ ok: true }));
    ctx.app.post("/x", limiters.credential, handler);
    ctx.app.use(errorHandler);

    for (let i = 0; i < 11; i += 1) await request(ctx.app).post("/x").send({});
    const response = await request(ctx.app).post("/x").send({});

    // The route handler never ran for the refused request.
    expect(handler).toHaveBeenCalledTimes(10);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("TOO_MANY_REQUESTS");
  });
});
