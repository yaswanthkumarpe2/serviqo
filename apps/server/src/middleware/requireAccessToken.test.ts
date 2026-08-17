import { describe, expect, it, vi } from "vitest";

import { InvalidAccessTokenError } from "../lib/errors";
import { issueAccessToken } from "../modules/auth/accessToken";
import { requireAccessToken } from "./requireAccessToken";

import type { NextFunction, Request, Response } from "express";

const USER_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f191e810c19729de860ea";

/** Captures what the middleware logs, so the operator-facing reasons can be asserted. */
function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * The two things this middleware touches on a Request: the `Authorization`
 * header and `req.log`. Everything else is deliberately absent, so a change
 * that started reading the body or the query would fail here.
 */
function fakeRequest(header?: string) {
  const log = fakeLog();
  const req = {
    log,
    get: (name: string) => (name.toLowerCase() === "authorization" ? header : undefined),
  } as unknown as Request;

  return { req, log };
}

async function run(header?: string) {
  const { req, log } = fakeRequest(header);
  const next = vi.fn() as unknown as NextFunction;

  await requireAccessToken(req, {} as Response, next);

  return { req, log, next: next as unknown as ReturnType<typeof vi.fn> };
}

/** The `reason` recorded on a refusal — the one place the distinctions exist (ADR-015 §6). */
function refusalReason(log: ReturnType<typeof fakeLog>): string {
  const [payload] = log.info.mock.calls[0] as [{ event: string; reason: string }];
  return payload.reason;
}

async function validHeader(): Promise<string> {
  const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
  return `Bearer ${token}`;
}

describe("requireAccessToken", () => {
  describe("a request carrying a valid token", () => {
    it("attaches the principal the token asserts", async () => {
      const { req } = await run(await validHeader());

      expect(req.principal).toEqual({ userId: USER_ID, sessionId: SESSION_ID });
    });

    it("continues to the handler", async () => {
      const { next } = await run(await validHeader());

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith();
    });

    // RFC 6750 requires the scheme be matched case-insensitively.
    it.each(["bearer", "BEARER", "BeArEr"])("accepts the %s scheme", async (scheme) => {
      const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });

      const { req, next } = await run(`${scheme} ${token}`);

      expect(next).toHaveBeenCalledWith();
      expect(req.principal).toEqual({ userId: USER_ID, sessionId: SESSION_ID });
    });
  });

  describe("refusals", () => {
    const cases: [label: string, header: string | undefined, reason: string][] = [
      ["no Authorization header", undefined, "missing_header"],
      ["an empty header", "", "malformed_header"],
      ["a bare token with no scheme", "some.jwt.here", "malformed_header"],
      ["the Basic scheme", "Basic dXNlcjpwYXNz", "malformed_header"],
      ["the Token scheme", "Token some.jwt.here", "malformed_header"],
      ["Bearer with no credential", "Bearer", "malformed_header"],
      ["Bearer with an empty credential", "Bearer ", "malformed_header"],
      ["a token that does not verify", "Bearer not.a.jwt", "invalid_token"],
    ];

    it.each(cases)("refuses %s", async (_label, header) => {
      const { next, req } = await run(header);

      const error = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as unknown;
      expect(error).toBeInstanceOf(InvalidAccessTokenError);
      expect((error as InvalidAccessTokenError).httpStatus).toBe(401);
      expect((error as InvalidAccessTokenError).code).toBe("INVALID_ACCESS_TOKEN");
      // A refused request never gets a principal, so a handler mounted behind
      // this cannot mistake a rejection for an anonymous caller.
      expect(req.principal).toBeUndefined();
    });

    // The distinctions exist for operators, on the server, after the fact —
    // and nowhere else.
    it.each(cases)("records %s in the log as its own reason", async (_label, header, reason) => {
      const { log } = await run(header);

      expect(log.info).toHaveBeenCalledOnce();
      expect(refusalReason(log)).toBe(reason);
    });

    // Every branch above produces one error with one message, so no refusal is
    // distinguishable by its text any more than by its status code.
    it("gives every refusal the same message", async () => {
      const messages = await Promise.all(
        cases.map(async ([, header]) => {
          const { next } = await run(header);
          return ((next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Error).message;
        }),
      );

      expect(new Set(messages).size).toBe(1);
    });

    it("does not continue to the handler", async () => {
      const { next } = await run("Bearer not.a.jwt");

      // Called once, with an error — never bare, which would run the handler.
      expect(next).toHaveBeenCalledOnce();
      expect((next as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeInstanceOf(InvalidAccessTokenError);
    });
  });

  // ADR-015 §12: the refusal records why a credential failed, never the
  // credential. This is the assertion that fails if someone logs the token to
  // debug a rejection.
  it("never logs the token it was given", async () => {
    const { token } = await issueAccessToken({ userId: USER_ID, sessionId: SESSION_ID });
    const { log } = await run(`Bearer ${token}.tampered`);

    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(token);
    // Not even the signature fragment, which is the part worth stealing.
    expect(logged).not.toContain(token.split(".")[2]);
  });
});
