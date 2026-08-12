import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOGIN_LOCK_DURATION_MS, LOGIN_MAX_FAILED_ATTEMPTS } from "../../config/constants";
import { UserModel } from "./user.model";
import { userRepository } from "./user.repository";

describe("User persistence", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Index creation is async; wait for it so the unique-email test below
    // is actually exercising the real constraint, not a race with it.
    await UserModel.init();
  });

  afterEach(async () => {
    await UserModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it("creates a user", async () => {
    const user = await userRepository.create({
      email: "test@example.com",
      passwordHash: "hashed-value",
      name: "Test User",
    });

    expect(user._id).toBeDefined();
    expect(user.email).toBe("test@example.com");
    expect(user.name).toBe("Test User");
  });

  it("trims and lowercases email on create", async () => {
    const user = await userRepository.create({
      email: "  Test@Example.com  ",
      passwordHash: "hashed-value",
      name: "Test User",
    });

    expect(user.email).toBe("test@example.com");
  });

  it("treats case variants of the same email as one identity", async () => {
    await userRepository.create({
      email: "Test@Example.com",
      passwordHash: "hashed-value",
      name: "Test User",
    });

    const found = await userRepository.findByEmail("test@example.com");
    expect(found).not.toBeNull();
    expect(found?.email).toBe("test@example.com");
  });

  it("rejects a duplicate canonical email at the database level", async () => {
    await userRepository.create({
      email: "dup@example.com",
      passwordHash: "hashed-value",
      name: "First",
    });

    await expect(
      userRepository.create({
        email: "Dup@Example.com",
        passwordHash: "hashed-value",
        name: "Second",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("finds a user by canonical email", async () => {
    const created = await userRepository.create({
      email: "findme@example.com",
      passwordHash: "hashed-value",
      name: "Find Me",
    });

    const found = await userRepository.findByEmail("findme@example.com");
    expect(found?._id.toString()).toBe(created._id.toString());
  });

  it("finds a user by id", async () => {
    const created = await userRepository.create({
      email: "byid@example.com",
      passwordHash: "hashed-value",
      name: "By Id",
    });

    const found = await userRepository.findById(created._id.toString());
    expect(found?.email).toBe("byid@example.com");
  });

  it("excludes passwordHash from normal retrieval and serialization", async () => {
    await userRepository.create({
      email: "secret@example.com",
      passwordHash: "hashed-value",
      name: "Secret",
    });

    const found = await userRepository.findByEmail("secret@example.com");
    expect(found?.passwordHash).toBeUndefined();
    expect(found?.toJSON()).not.toHaveProperty("passwordHash");
  });

  it("defaults emailVerifiedAt to null", async () => {
    const user = await userRepository.create({
      email: "verify@example.com",
      passwordHash: "hashed-value",
      name: "Verify",
    });

    expect(user.emailVerifiedAt).toBeNull();
  });

  it("defaults failedLoginAttempts to 0", async () => {
    const user = await userRepository.create({
      email: "lockout@example.com",
      passwordHash: "hashed-value",
      name: "Lockout",
    });

    expect(user.failedLoginAttempts).toBe(0);
  });

  it("defaults lockedUntil to null", async () => {
    const user = await userRepository.create({
      email: "locked@example.com",
      passwordHash: "hashed-value",
      name: "Locked",
    });

    expect(user.lockedUntil).toBeNull();
  });

  it("defaults status to active", async () => {
    const user = await userRepository.create({
      email: "status@example.com",
      passwordHash: "hashed-value",
      name: "Status",
    });

    expect(user.status).toBe("active");
  });

  it("sets createdAt and updatedAt on create", async () => {
    const user = await userRepository.create({
      email: "timestamps@example.com",
      passwordHash: "hashed-value",
      name: "Timestamps",
    });

    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects creation when a required field is missing", async () => {
    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      userRepository.create({
        email: "incomplete@example.com",
        name: "Incomplete",
      }),
    ).rejects.toThrow(/passwordHash/);

    await expect(userRepository.findByEmail("incomplete@example.com")).resolves.toBeNull();
  });

  it("has no organizationId, role, or permissions field", async () => {
    const user = await userRepository.create({
      email: "notenant@example.com",
      passwordHash: "hashed-value",
      name: "No Tenant",
    });

    const plain = user.toObject();
    expect(plain).not.toHaveProperty("organizationId");
    expect(plain).not.toHaveProperty("organizationIds");
    expect(plain).not.toHaveProperty("role");
    expect(plain).not.toHaveProperty("roles");
    expect(plain).not.toHaveProperty("permissions");
  });

  // ---- credential read (ADR-011 §8) ----

  describe("findByEmailWithPasswordHash", () => {
    const seed = () =>
      userRepository.create({ email: "creds@example.com", passwordHash: "hashed-value", name: "Creds" });

    it("returns the hash the ordinary read withholds", async () => {
      await seed();

      expect((await userRepository.findByEmail("creds@example.com"))!.passwordHash).toBeUndefined();
      expect((await userRepository.findByEmailWithPasswordHash("creds@example.com"))!.passwordHash).toBe(
        "hashed-value",
      );
    });

    it("normalizes the address like every other lookup", async () => {
      await seed();

      await expect(userRepository.findByEmailWithPasswordHash("  Creds@Example.COM ")).resolves.not.toBeNull();
    });

    it("returns null for an unknown address", async () => {
      await expect(userRepository.findByEmailWithPasswordHash("nobody@example.com")).resolves.toBeNull();
    });

    // Even when deliberately selected, the hash must not survive serialization.
    it("still strips the hash from toJSON", async () => {
      await seed();

      const user = await userRepository.findByEmailWithPasswordHash("creds@example.com");
      expect(JSON.stringify(user)).not.toContain("hashed-value");
    });
  });

  // ---- lockout counters (ADR-011 §7) ----

  describe("registerFailedLogin", () => {
    const seed = (overrides: Record<string, unknown> = {}) =>
      UserModel.create({ email: "lock@example.com", passwordHash: "hashed-value", name: "Lock", ...overrides });

    it("increments the counter without locking below the threshold", async () => {
      const user = await seed();

      const updated = await userRepository.registerFailedLogin(user._id);

      expect(updated!.failedLoginAttempts).toBe(1);
      expect(updated!.lockedUntil).toBeNull();
    });

    it("locks on the threshold attempt and resets the counter", async () => {
      const user = await seed({ failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 1 });

      const updated = await userRepository.registerFailedLogin(user._id);

      expect(updated!.lockedUntil).not.toBeNull();
      expect(updated!.failedLoginAttempts).toBe(0);
    });

    it("sets the lock to expire after the configured duration", async () => {
      const user = await seed({ failedLoginAttempts: LOGIN_MAX_FAILED_ATTEMPTS - 1 });
      const before = Date.now();

      const updated = await userRepository.registerFailedLogin(user._id);

      const remaining = updated!.lockedUntil!.getTime() - before;
      expect(remaining).toBeGreaterThan(LOGIN_LOCK_DURATION_MS - 5000);
      expect(remaining).toBeLessThanOrEqual(LOGIN_LOCK_DURATION_MS + 5000);
    });

    // Read-modify-write would lose one of these; the pipeline cannot.
    it("loses no increment under concurrency", async () => {
      const user = await seed();

      await Promise.all(Array.from({ length: 5 }, () => userRepository.registerFailedLogin(user._id)));

      expect((await UserModel.findById(user._id))!.failedLoginAttempts).toBe(5);
    });

    it("touches nothing but the lockout fields", async () => {
      const user = await seed({ emailVerifiedAt: new Date(), status: "active" });

      await userRepository.registerFailedLogin(user._id);

      const updated = await UserModel.findById(user._id);
      expect(updated!.email).toBe("lock@example.com");
      expect(updated!.status).toBe("active");
      expect(updated!.emailVerifiedAt).not.toBeNull();
    });

    it("returns null for a user that does not exist", async () => {
      await expect(userRepository.registerFailedLogin(new mongoose.Types.ObjectId())).resolves.toBeNull();
    });
  });

  describe("clearLoginFailures", () => {
    it("resets both lockout fields", async () => {
      const user = await UserModel.create({
        email: "clear@example.com",
        passwordHash: "hashed-value",
        name: "Clear",
        failedLoginAttempts: 4,
        lockedUntil: new Date(Date.now() + 60_000),
      });

      await userRepository.clearLoginFailures(user._id);

      const updated = await UserModel.findById(user._id);
      expect(updated!.failedLoginAttempts).toBe(0);
      expect(updated!.lockedUntil).toBeNull();
    });

    it("is a no-op for a user that does not exist", async () => {
      await expect(userRepository.clearLoginFailures(new mongoose.Types.ObjectId())).resolves.toBeUndefined();
    });
  });
});
