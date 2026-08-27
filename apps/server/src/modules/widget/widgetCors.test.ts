import { describe, expect, it, vi } from "vitest";

import { widgetCorsHeaders, widgetPreflight } from "./widgetCors";

import type { Request, Response } from "express";

/**
 * Minimal fakes rather than a mocking library, matching the convention
 * `widget.isolation.test.ts`'s `captureLogs` already set for this module.
 */
function fakeReqRes(origin: string | undefined) {
  const headers: Record<string, string> = {};
  const req = { get: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined) } as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
  } as unknown as Response;
  return { req, res, headers };
}

describe("widgetCorsHeaders", () => {
  it("reflects the request Origin, never a wildcard", () => {
    const { req, res, headers } = fakeReqRes("https://shop.example.com");
    const next = vi.fn();

    widgetCorsHeaders(req, res, next);

    expect(headers["Access-Control-Allow-Origin"]).toBe("https://shop.example.com");
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(headers.Vary).toBe("Origin");
    expect(next).toHaveBeenCalledOnce();
  });

  it("never sends Access-Control-Allow-Credentials", () => {
    const { req, res, headers } = fakeReqRes("https://shop.example.com");
    widgetCorsHeaders(req, res, vi.fn());

    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("sets no Allow-Origin when the caller sent no Origin header", () => {
    const { req, res, headers } = fakeReqRes(undefined);
    widgetCorsHeaders(req, res, vi.fn());

    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers.Vary).toBeUndefined();
  });

  it("always overrides the resource policy to cross-origin, Origin or not", () => {
    const { req, res, headers } = fakeReqRes(undefined);
    widgetCorsHeaders(req, res, vi.fn());

    expect(headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
  });

  it("calls next() unconditionally", () => {
    const next = vi.fn();
    const { req, res } = fakeReqRes("https://shop.example.com");
    widgetCorsHeaders(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe("widgetPreflight", () => {
  it("answers 204 with the preflight headers, reflecting any origin", () => {
    const { req, res, headers } = fakeReqRes("https://never-configured.example.com");

    widgetPreflight("POST")(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledOnce();
    expect(headers["Access-Control-Allow-Methods"]).toBe("POST");
    expect(headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization");
    expect(headers["Access-Control-Max-Age"]).toBe("600");
  });

  it("answers with the GET method when parameterized for a read route", () => {
    const { req, res, headers } = fakeReqRes("https://shop.example.com");

    widgetPreflight("GET")(req, res, vi.fn());

    expect(headers["Access-Control-Allow-Methods"]).toBe("GET");
  });
});
