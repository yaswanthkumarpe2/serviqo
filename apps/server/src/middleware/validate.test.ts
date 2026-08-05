import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { errorHandler } from "./errorHandler";
import { requestContext } from "./requestContext";
import { validateBody } from "./validate";

const testSchema = z.object({
  email: z.string(),
  password: z.string().min(10),
  profile: z.object({ name: z.string().min(1) }),
});

/**
 * Wired exactly like createApp's boundary — request context, json parser,
 * then the error handler — so these assertions describe what a real client
 * receives rather than what the middleware returns in isolation.
 */
function buildTestApp() {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.post("/echo", validateBody(testSchema), (req, res) => {
    res.status(200).json({ received: req.body });
  });
  app.use(errorHandler);
  return app;
}

const validBody = {
  email: "person@example.com",
  password: "correct-horse-battery",
  profile: { name: "Person" },
};

describe("validateBody", () => {
  it("passes a valid body through to the handler", async () => {
    const response = await request(buildTestApp()).post("/echo").send(validBody);

    expect(response.status).toBe(200);
    expect(response.body.received).toEqual(validBody);
  });

  it("strips keys the schema does not declare", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .send({ ...validBody, role: "owner", isAdmin: true });

    expect(response.status).toBe(200);
    expect(response.body.received).toEqual(validBody);
    expect(response.body.received).not.toHaveProperty("role");
    expect(response.body.received).not.toHaveProperty("isAdmin");
  });

  it("rejects an invalid body with the standard failure envelope", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .send({ ...validBody, password: "short" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR", version: "v1" },
    });
    expect(response.body.error.requestId).toEqual(expect.any(String));
    expect(response.body.error.timestamp).toEqual(expect.any(String));
  });

  it("reports every failing field, not just the first", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .send({ password: "short", profile: { name: "" } });

    const fields = response.body.error.details.map((issue: { field: string }) => issue.field);
    expect(fields).toEqual(expect.arrayContaining(["email", "password", "profile.name"]));
  });

  it("reports nested paths in dotted form", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .send({ ...validBody, profile: { name: "" } });

    expect(response.body.error.details).toEqual([{ field: "profile.name", message: expect.any(String) }]);
  });

  it("attributes a non-object body to the root rather than to no field", async () => {
    // An array parses fine — express.json's strict mode accepts objects and
    // arrays — so this reaches the schema rather than the JSON parser.
    const response = await request(buildTestApp()).post("/echo").send([1, 2, 3]);

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([{ field: "body", message: expect.any(String) }]);
  });

  // The reason `details` is {field, message} and nothing else: a response body
  // reaches client logs, error trackers, and browser history (ADR-007 §7).
  it("never echoes the rejected value back to the client", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .send({ email: "wrong@@example", password: "sh0rt", profile: { name: "" } });

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("sh0rt");
    expect(serialized).not.toContain("wrong@@example");
    for (const issue of response.body.error.details) {
      expect(Object.keys(issue).sort()).toEqual(["field", "message"]);
    }
  });

  it("omits details entirely on errors that have none", async () => {
    const app = express();
    app.use(requestContext);
    app.get("/boom", () => {
      throw new Error("unexpected");
    });
    app.use(errorHandler);

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(response.body.error).not.toHaveProperty("details");
  });
});

describe("unparseable request bodies", () => {
  it("answers malformed JSON with 400 MALFORMED_JSON, not 500", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"email": "person@example.com",}');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "MALFORMED_JSON" },
    });
  });

  // Body-parser's own SyntaxError quotes the offending fragment of the body,
  // which on an auth endpoint can be the password (ADR-007 §8).
  it("does not leak the offending fragment of an unparseable body", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"password": "s3cret-in-broken-json",}');

    expect(JSON.stringify(response.body)).not.toContain("s3cret-in-broken-json");
  });

  it("answers an oversized body with 413 PAYLOAD_TOO_LARGE", async () => {
    const app = express();
    app.use(requestContext);
    app.use(express.json({ limit: "1kb" }));
    app.post("/echo", validateBody(testSchema), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(errorHandler);

    const response = await request(app)
      .post("/echo")
      .send({ ...validBody, profile: { name: "x".repeat(2048) } });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("treats a non-JSON content type as an unparsed body, not a crash", async () => {
    const response = await request(buildTestApp())
      .post("/echo")
      .set("Content-Type", "text/plain")
      .send("email=person@example.com");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
