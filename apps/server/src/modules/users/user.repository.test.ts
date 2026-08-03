import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
});
