import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider, extractToken } from "../src/modules/auth/testing/fakeEmailProvider";
import { UserModel } from "../src/modules/users/user.model";

const REGISTER_PATH = "/api/v1/auth/register";

/** Obvious sentinel — if it reaches a response body, the test fails. */
const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

const validBody = { name: "Ada Lovelace", email: EMAIL, password: PASSWORD };

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

describe("POST /api/v1/auth/register", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AccountTokenModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- success ----

  describe("successful registration", () => {
    it("answers 201 with the standard success envelope", async () => {
      const { app } = buildApp();
      const response = await request(app).post(REGISTER_PATH).send(validBody);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        success: true,
        data: { user: { name: "Ada Lovelace", email: EMAIL, emailVerified: false } },
        meta: { version: "v1" },
      });
      expect(response.body.data.user.id).toEqual(expect.any(String));
      expect(response.body.meta.requestId).toEqual(expect.any(String));
      expect(response.body.meta.timestamp).toEqual(expect.any(String));
    });

    it("returns exactly the four approved user fields", async () => {
      const { app } = buildApp();
      const response = await request(app).post(REGISTER_PATH).send(validBody);

      expect(Object.keys(response.body.data.user).sort()).toEqual(["email", "emailVerified", "id", "name"]);
      expect(Object.keys(response.body.data)).toEqual(["user"]);
    });

    it("propagates an incoming X-Request-Id into the envelope", async () => {
      const { app } = buildApp();
      const response = await request(app).post(REGISTER_PATH).set("X-Request-Id", "reg-test-request-id").send(validBody);

      expect(response.headers["x-request-id"]).toBe("reg-test-request-id");
      expect(response.body.meta.requestId).toBe("reg-test-request-id");
    });

    it("persists the user and one verification token", async () => {
      const { app, fake } = buildApp();
      await request(app).post(REGISTER_PATH).send(validBody);

      expect(await UserModel.countDocuments()).toBe(1);
      expect(await AccountTokenModel.countDocuments()).toBe(1);
      expect(fake.verifications).toHaveLength(1);
    });

    it("strips unrecognized keys instead of honouring them", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .send({ ...validBody, status: "disabled", emailVerifiedAt: new Date().toISOString(), role: "owner" });

      expect(response.status).toBe(201);
      const stored = await UserModel.findOne({ email: EMAIL });
      expect(stored!.status).toBe("active");
      expect(stored!.emailVerifiedAt).toBeNull();
    });
  });

  // ---- response secrecy ----

  describe("response secrecy", () => {
    it("returns no password, hash, token, or internal field", async () => {
      const { app, fake } = buildApp();
      const response = await request(app).post(REGISTER_PATH).send(validBody);

      const rawToken = extractToken(fake.verifications[0]!.verificationUrl)!;
      const stored = await AccountTokenModel.findOne({}).select("+tokenHash");
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(rawToken);
      expect(serialized).not.toContain(stored!.tokenHash);
      expect(serialized).not.toContain("verify-email");
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("failedLoginAttempts");
      expect(serialized).not.toContain("lockedUntil");
      expect(serialized).not.toContain("_id");
      expect(serialized).not.toContain("__v");
    });

    it("makes no claim about email delivery", async () => {
      const { app } = buildApp();
      const response = await request(app).post(REGISTER_PATH).send(validBody);

      expect(JSON.stringify(response.body).toLowerCase()).not.toContain("sent");
    });
  });

  // ---- duplicates ----

  describe("duplicate email", () => {
    it("answers 409 EMAIL_ALREADY_EXISTS", async () => {
      const { app } = buildApp();
      await request(app).post(REGISTER_PATH).send(validBody);

      const response = await request(app).post(REGISTER_PATH).send(validBody);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: "EMAIL_ALREADY_EXISTS", version: "v1" },
      });
      expect(response.body.error.requestId).toEqual(expect.any(String));
    });

    it("does not expose the MongoDB duplicate-key message", async () => {
      const { app } = buildApp();
      await request(app).post(REGISTER_PATH).send(validBody);

      const response = await request(app).post(REGISTER_PATH).send(validBody);
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("dup key");
      expect(serialized).not.toContain("index");
    });

    it("creates no second account and sends no second email", async () => {
      const { app, fake } = buildApp();
      await request(app).post(REGISTER_PATH).send(validBody);
      await request(app).post(REGISTER_PATH).send(validBody);

      expect(await UserModel.countDocuments()).toBe(1);
      expect(await AccountTokenModel.countDocuments()).toBe(1);
      expect(fake.verifications).toHaveLength(1);
    });
  });

  // ---- validation ----

  describe("validation failures", () => {
    it("answers 400 VALIDATION_ERROR with field details", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .send({ name: "", email: "not-an-email", password: "short" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");

      const fields = response.body.error.details.map((issue: { field: string }) => issue.field);
      expect(fields).toEqual(expect.arrayContaining(["name", "email", "password"]));
    });

    it("never echoes a submitted value in the details", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .send({ name: "", email: "leak-me@@example", password: "sh0rt" });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain("sh0rt");
      expect(serialized).not.toContain("leak-me");
      for (const issue of response.body.error.details) {
        expect(Object.keys(issue).sort()).toEqual(["field", "message"]);
      }
    });

    it("persists nothing when validation fails", async () => {
      const { app, fake } = buildApp();
      await request(app).post(REGISTER_PATH).send({ name: "", email: "bad", password: "x" });

      expect(await UserModel.countDocuments()).toBe(0);
      expect(await AccountTokenModel.countDocuments()).toBe(0);
      expect(fake.verifications).toHaveLength(0);
    });

    it("rejects a password that is too long before doing Argon2 work", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .send({ ...validBody, password: "a".repeat(129) });

      expect(response.status).toBe(400);
      expect(await UserModel.countDocuments()).toBe(0);
    });
  });

  // ---- request boundary ----

  describe("request boundary", () => {
    it("answers malformed JSON with 400 MALFORMED_JSON", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .set("Content-Type", "application/json")
        .send('{"email": "ada@example.com",}');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("MALFORMED_JSON");
      expect(response.body.error.requestId).toEqual(expect.any(String));
    });

    // A JSON SyntaxError quotes the offending fragment, which here is the
    // password field (ADR-007 §8).
    it("does not echo the body fragment from an unparseable request", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .set("Content-Type", "application/json")
        .send(`{"password": "${PASSWORD}",}`);

      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    });

    it("answers a non-JSON content type with a 400 rather than a crash", async () => {
      const { app } = buildApp();
      const response = await request(app)
        .post(REGISTER_PATH)
        .set("Content-Type", "text/plain")
        .send("name=Ada&email=ada@example.com");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it.each(["get", "put", "patch", "delete"] as const)("answers 404 for %s on the register path", async (method) => {
      const { app } = buildApp();
      const response = await request(app)[method](REGISTER_PATH);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("leaves the unversioned health route in place", async () => {
      const { app } = buildApp();
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("ok");
    });
  });
});
