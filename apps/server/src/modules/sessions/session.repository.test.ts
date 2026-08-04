import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MAX_USER_AGENT_LENGTH } from "../../config/constants";
import { UserModel } from "../users/user.model";
import { MAX_PREVIOUS_REFRESH_TOKEN_HASHES, SessionModel } from "./session.model";
import { sessionRepository } from "./session.repository";

/**
 * Hash values here are dummy strings. Real refresh secrets and their
 * SHA-256 hashing belong to the future auth/token service; this suite
 * only proves the persistence contract around whatever hash it is given.
 */
const HASH_A = "hash-a-current";
const HASH_B = "hash-b-rotated";
const HASH_C = "hash-c-rotated";

function futureDate(msFromNow = 7 * 24 * 60 * 60 * 1000) {
  return new Date(Date.now() + msFromNow);
}

function pastDate(msAgo = 60 * 1000) {
  return new Date(Date.now() - msAgo);
}

async function createUser(email: string) {
  return UserModel.create({ email, passwordHash: "hashed-value", name: "Test User" });
}

describe("Session persistence", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // TTL/index assertions below inspect real index definitions.
    await SessionModel.init();
    await UserModel.init();
  });

  afterEach(async () => {
    await Promise.all([SessionModel.deleteMany({}), UserModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- creation ----

  it("creates a valid session", async () => {
    const user = await createUser("session@example.com");
    const expiresAt = futureDate();

    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt,
    });

    expect(session._id).toBeDefined();
    expect(session.userId.toString()).toBe(user._id.toString());
    expect(session.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("requires userId", async () => {
    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      sessionRepository.create({ currentRefreshTokenHash: HASH_A, expiresAt: futureDate() }),
    ).rejects.toThrow(/userId/);
  });

  it("requires currentRefreshTokenHash", async () => {
    const user = await createUser("nohash@example.com");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      sessionRepository.create({ userId: user._id, expiresAt: futureDate() }),
    ).rejects.toThrow(/currentRefreshTokenHash/);
  });

  it("requires expiresAt", async () => {
    const user = await createUser("noexpiry@example.com");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field to prove validation rejects it.
      sessionRepository.create({ userId: user._id, currentRefreshTokenHash: HASH_A }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("sets createdAt, updatedAt, and lastUsedAt on create", async () => {
    const user = await createUser("timestamps@example.com");
    const before = Date.now();

    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
    expect(session.lastUsedAt).toBeInstanceOf(Date);
    // lastUsedAt initialises to creation time.
    expect(session.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("defaults revokedAt to null", async () => {
    const user = await createUser("notrevoked@example.com");

    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    expect(session.revokedAt).toBeNull();
  });

  // ---- token protection ----

  it("does not return token state from ordinary retrieval", async () => {
    const user = await createUser("hidden@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const found = await sessionRepository.findById(created._id);

    expect(found).not.toBeNull();
    expect(found?.currentRefreshTokenHash).toBeUndefined();
    expect(found?.previousRefreshTokenHashes).toBeUndefined();
  });

  it("does not expose token state through serialization", async () => {
    const user = await createUser("serialize@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    // Even the security-sensitive document, which *did* select the hashes,
    // must not leak them once serialized.
    const sensitive = await sessionRepository.findByIdWithRefreshTokenState(created._id);
    const asJson = sensitive?.toJSON();
    const asObject = sensitive?.toObject();

    expect(asJson).not.toHaveProperty("currentRefreshTokenHash");
    expect(asJson).not.toHaveProperty("previousRefreshTokenHashes");
    expect(asObject).not.toHaveProperty("currentRefreshTokenHash");
    expect(asObject).not.toHaveProperty("previousRefreshTokenHashes");
  });

  it("returns token state only through the security-sensitive lookup", async () => {
    const user = await createUser("sensitive@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const sensitive = await sessionRepository.findByIdWithRefreshTokenState(created._id);

    expect(sensitive?.currentRefreshTokenHash).toBe(HASH_A);
    expect(sensitive?.previousRefreshTokenHashes).toEqual([]);
  });

  it("excludes __v from serialization", async () => {
    const user = await createUser("versionkey@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    expect(created.toJSON()).not.toHaveProperty("__v");
  });

  // ---- refresh-token history / rotation ----

  it("represents a current hash and previously rotated hashes", async () => {
    const user = await createUser("history@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    await sessionRepository.rotateRefreshToken(created._id, HASH_B);
    const rotated = await sessionRepository.rotateRefreshToken(created._id, HASH_C);

    expect(rotated?.currentRefreshTokenHash).toBe(HASH_C);
    // Oldest first: A was rotated out before B.
    expect(rotated?.previousRefreshTokenHashes).toEqual([HASH_A, HASH_B]);
  });

  it("keeps the session id stable across rotation", async () => {
    const user = await createUser("stableid@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const rotated = await sessionRepository.rotateRefreshToken(created._id, HASH_B);

    expect(rotated?._id.toString()).toBe(created._id.toString());
    await expect(SessionModel.countDocuments({ userId: user._id })).resolves.toBe(1);
  });

  it("advances lastUsedAt on rotation", async () => {
    const user = await createUser("lastused@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    const originalLastUsedAt = created.lastUsedAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const rotated = await sessionRepository.rotateRefreshToken(created._id, HASH_B);

    expect(rotated!.lastUsedAt.getTime()).toBeGreaterThan(originalLastUsedAt);
  });

  it("bounds the rotated-hash history to the configured maximum", async () => {
    const user = await createUser("bounded@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: "hash-0",
      expiresAt: futureDate(),
    });

    // Rotate well past the bound.
    const rotations = MAX_PREVIOUS_REFRESH_TOKEN_HASHES + 3;
    for (let i = 1; i <= rotations; i += 1) {
      await sessionRepository.rotateRefreshToken(created._id, `hash-${i}`);
    }

    const sensitive = await sessionRepository.findByIdWithRefreshTokenState(created._id);

    expect(sensitive?.currentRefreshTokenHash).toBe(`hash-${rotations}`);
    expect(sensitive?.previousRefreshTokenHashes).toHaveLength(MAX_PREVIOUS_REFRESH_TOKEN_HASHES);
    // The oldest entries are discarded; the most recent are retained.
    expect(sensitive?.previousRefreshTokenHashes).toEqual([
      "hash-3",
      "hash-4",
      "hash-5",
      "hash-6",
      "hash-7",
    ]);
    expect(sensitive?.previousRefreshTokenHashes).not.toContain("hash-0");
  });

  it("supports reuse detection: a rotated hash is retrievable as a previous hash", async () => {
    const user = await createUser("reuse@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    await sessionRepository.rotateRefreshToken(created._id, HASH_B);
    const sensitive = await sessionRepository.findByIdWithRefreshTokenState(created._id);

    // This is the three-way outcome future refresh logic depends on.
    expect(sensitive?.currentRefreshTokenHash).toBe(HASH_B); // valid current
    expect(sensitive?.previousRefreshTokenHashes).toContain(HASH_A); // replay of rotated token
    expect(sensitive?.previousRefreshTokenHashes).not.toContain("hash-never-issued"); // unknown
  });

  it("returns null when rotating a session that does not exist", async () => {
    const missingId = new mongoose.Types.ObjectId();
    await expect(sessionRepository.rotateRefreshToken(missingId, HASH_B)).resolves.toBeNull();
  });

  // ---- lastRotatedAt (refresh race / reuse classification) ----

  it("defaults lastRotatedAt to null before any rotation", async () => {
    const user = await createUser("neverrotated@example.com");
    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    expect(session.lastRotatedAt).toBeNull();
  });

  it("sets lastRotatedAt on a successful rotation", async () => {
    const user = await createUser("rotatedonce@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    const before = Date.now();

    const rotated = await sessionRepository.rotateRefreshToken(created._id, HASH_B);

    expect(rotated!.lastRotatedAt).toBeInstanceOf(Date);
    expect(rotated!.lastRotatedAt!.getTime()).toBeGreaterThanOrEqual(before);
    // Rotation stamps both fields with the same instant.
    expect(rotated!.lastRotatedAt!.getTime()).toBe(rotated!.lastUsedAt.getTime());
  });

  it("advances lastRotatedAt on a subsequent rotation", async () => {
    const user = await createUser("rotatedtwice@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const first = await sessionRepository.rotateRefreshToken(created._id, HASH_B);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await sessionRepository.rotateRefreshToken(created._id, HASH_C);

    expect(second!.lastRotatedAt!.getTime()).toBeGreaterThan(first!.lastRotatedAt!.getTime());
  });

  it("leaves lastRotatedAt unchanged when a rotation does not match a session", async () => {
    const user = await createUser("unchangedrotation@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    const rotated = await sessionRepository.rotateRefreshToken(created._id, HASH_B);
    const stampedAt = rotated!.lastRotatedAt!.getTime();

    // A rotation aimed at a different (non-existent) session must not touch this one.
    await expect(
      sessionRepository.rotateRefreshToken(new mongoose.Types.ObjectId(), HASH_C),
    ).resolves.toBeNull();

    const reloaded = await sessionRepository.findById(created._id);
    expect(reloaded!.lastRotatedAt!.getTime()).toBe(stampedAt);
  });

  // ---- user scope ----

  it("allows a user to have multiple concurrent sessions", async () => {
    const user = await createUser("multidevice@example.com");

    await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
      userAgent: "Device One",
    });
    await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
      userAgent: "Device Two",
    });

    const active = await sessionRepository.findActiveByUser(user._id);
    expect(active).toHaveLength(2);
  });

  it("never returns another user's sessions", async () => {
    const userA = await createUser("scope-a@example.com");
    const userB = await createUser("scope-b@example.com");

    await sessionRepository.create({
      userId: userA._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    await sessionRepository.create({
      userId: userB._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
    });

    const aSessions = await sessionRepository.findActiveByUser(userA._id);

    expect(aSessions).toHaveLength(1);
    expect(aSessions[0]!.userId.toString()).toBe(userA._id.toString());
  });

  it("carries no organization, role, or permission data", async () => {
    const user = await createUser("noorg@example.com");
    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const plain = session.toObject();
    expect(plain).not.toHaveProperty("organizationId");
    expect(plain).not.toHaveProperty("activeOrganizationId");
    expect(plain).not.toHaveProperty("membershipId");
    expect(plain).not.toHaveProperty("role");
    expect(plain).not.toHaveProperty("roles");
    expect(plain).not.toHaveProperty("permissions");
  });

  it("does not denormalize user identity into the session", async () => {
    const user = await createUser("nodenorm@example.com");
    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const plain = session.toObject();
    expect(plain).not.toHaveProperty("email");
    expect(plain).not.toHaveProperty("name");
    expect(plain).not.toHaveProperty("passwordHash");
  });

  // ---- revocation ----

  it("revokes a single session", async () => {
    const user = await createUser("revoke@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const revoked = await sessionRepository.revokeById(created._id);

    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    await expect(sessionRepository.findActiveByUser(user._id)).resolves.toHaveLength(0);
  });

  it("revoking one session does not affect the user's other sessions", async () => {
    const user = await createUser("partialrevoke@example.com");
    const keep = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    const drop = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
    });

    await sessionRepository.revokeById(drop._id);

    const active = await sessionRepository.findActiveByUser(user._id);
    expect(active).toHaveLength(1);
    expect(active[0]!._id.toString()).toBe(keep._id.toString());
  });

  it("revokes every active session for a user", async () => {
    const user = await createUser("revokeall@example.com");
    await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
    });

    const revokedCount = await sessionRepository.revokeAllForUser(user._id);

    expect(revokedCount).toBe(2);
    await expect(sessionRepository.findActiveByUser(user._id)).resolves.toHaveLength(0);
  });

  it("revoke-all does not affect another user's sessions", async () => {
    const userA = await createUser("ra-a@example.com");
    const userB = await createUser("ra-b@example.com");
    await sessionRepository.create({
      userId: userA._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });
    await sessionRepository.create({
      userId: userB._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
    });

    await sessionRepository.revokeAllForUser(userA._id);

    await expect(sessionRepository.findActiveByUser(userB._id)).resolves.toHaveLength(1);
  });

  it("preserves the original timestamp when revoking an already-revoked session", async () => {
    const user = await createUser("doublerevoke@example.com");
    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
    });

    const first = await sessionRepository.revokeById(created._id);
    const second = await sessionRepository.revokeById(created._id);

    expect(first?.revokedAt).toBeInstanceOf(Date);
    // Already revoked: no document matches the { revokedAt: null } filter.
    expect(second).toBeNull();

    const stored = await sessionRepository.findById(created._id);
    expect(stored?.revokedAt?.getTime()).toBe(first!.revokedAt!.getTime());
  });

  // ---- expiry ----

  it("persists expiresAt exactly", async () => {
    const user = await createUser("expiry@example.com");
    const expiresAt = futureDate();

    const created = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt,
    });

    const found = await sessionRepository.findById(created._id);
    expect(found?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("declares a TTL index on expiresAt with expireAfterSeconds 0", async () => {
    const indexes = await SessionModel.collection.indexes();
    const ttlIndex = indexes.find((index) => index.key?.expiresAt === 1);

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.expireAfterSeconds).toBe(0);
  });

  it("indexes userId for session listing and logout-all", async () => {
    const indexes = await SessionModel.collection.indexes();
    const userIndex = indexes.find(
      (index) => index.key?.userId === 1 && Object.keys(index.key).length === 1,
    );

    expect(userIndex).toBeDefined();
  });

  it("does not index sensitive token fields", async () => {
    const indexes = await SessionModel.collection.indexes();

    for (const index of indexes) {
      expect(index.key).not.toHaveProperty("currentRefreshTokenHash");
      expect(index.key).not.toHaveProperty("previousRefreshTokenHashes");
    }
  });

  it("determines expiry logically, without waiting for MongoDB TTL deletion", async () => {
    const user = await createUser("logicalexpiry@example.com");
    const expired = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: pastDate(),
    });

    // TTL deletion is asynchronous, so the document is still physically
    // present — proving that "document exists" must never mean "valid".
    await expect(sessionRepository.findById(expired._id)).resolves.not.toBeNull();

    // The logical filter excludes it regardless.
    await expect(sessionRepository.findActiveByUser(user._id)).resolves.toHaveLength(0);
  });

  // ---- metadata ----

  it("persists userAgent when supplied and leaves it undefined otherwise", async () => {
    const user = await createUser("useragent@example.com");
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Serviqo/1.0";

    const withUa = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
      userAgent,
    });
    const withoutUa = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
    });

    expect(withUa.userAgent).toBe(userAgent);
    expect(withoutUa.userAgent).toBeUndefined();
  });

  it("persists an IPv4 address", async () => {
    const user = await createUser("ipv4@example.com");
    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
      ip: "203.0.113.42",
    });

    expect(session.ip).toBe("203.0.113.42");
  });

  it("persists an IPv6 address, including the IPv4-mapped form", async () => {
    const user = await createUser("ipv6@example.com");
    const ipv6 = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
      ip: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    });
    const mapped = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_B,
      expiresAt: futureDate(),
      ip: "::ffff:255.255.255.255",
    });

    expect(ipv6.ip).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(mapped.ip).toBe("::ffff:255.255.255.255");
  });

  it("rejects an oversized userAgent rather than silently truncating it", async () => {
    const user = await createUser("bigua@example.com");

    await expect(
      sessionRepository.create({
        userId: user._id,
        currentRefreshTokenHash: HASH_A,
        expiresAt: futureDate(),
        userAgent: "x".repeat(MAX_USER_AGENT_LENGTH + 1),
      }),
    ).rejects.toThrow(/userAgent/);
  });

  it("accepts a userAgent exactly at the maximum length", async () => {
    const user = await createUser("maxua@example.com");

    const session = await sessionRepository.create({
      userId: user._id,
      currentRefreshTokenHash: HASH_A,
      expiresAt: futureDate(),
      userAgent: "x".repeat(MAX_USER_AGENT_LENGTH),
    });

    expect(session.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
  });
});
