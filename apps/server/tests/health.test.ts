import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";

describe("GET /health", () => {
  it("returns the standardized success envelope with status ok", async () => {
    const app = createApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { status: "ok" },
      meta: { version: "v1" },
    });
    expect(response.body.meta.requestId).toEqual(expect.any(String));
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(response.headers["x-correlation-id"]).toBeDefined();
  });

  it("returns the standardized failure envelope for unknown routes", async () => {
    const app = createApp();
    const response = await request(app).get("/no-such-route");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND", version: "v1" },
    });
    expect(response.body.error.requestId).toEqual(expect.any(String));
  });

  it("echoes an incoming X-Request-Id instead of generating a new one", async () => {
    const app = createApp();
    const response = await request(app).get("/health").set("X-Request-Id", "test-request-id-123");

    expect(response.headers["x-request-id"]).toBe("test-request-id-123");
    expect(response.body.meta.requestId).toBe("test-request-id-123");
  });
});
