import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { generateSecret, sha256 } from "../../lib/crypto/tokens";
import { UserModel } from "../users/user.model";
import { AccountTokenModel } from "./accountToken.model";
import { accountTokenRepository } from "./accountToken.repository";

function futureDate(msFromNow = 60 * 60 * 1000) {
  return new Date(Date.now() + msFromNow);
}

function pastDate(msAgo = 60 * 1000) {
  return new Date(Date.now() - msAgo);
}

async function createUser(email: string) {
  return UserModel.create({ email, passwordHash: "hashed-value", name: "Test User" });
}

describe("AccountToken persistence", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Uniqueness and index assertions must run against real, built indexes.
    await AccountTokenModel.init();
    await UserModel.init();
  });

  afterEach(async () => {
    await Promise.all([AccountTokenModel.deleteMany({}), UserModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- schema ----

  it("creates an email-verification token", async () => {
    const user = await createUser("verify@example.com");
    const token = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("secret-a"),
      expiresAt: futureDate(),
    });

    expect(token._id).toBeDefined();
    expect(token.purpose).toBe("email_verification");
    expect(token.userId.toString()).toBe(user._id.toString());
  });

  it("creates a password-reset token", async () => {
    const user = await createUser("reset@example.com");
    const token = await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256("secret-b"),
      expiresAt: futureDate(),
    });

    expect(token.purpose).toBe("password_reset");
  });

  it("rejects an unsupported purpose", async () => {
    const user = await createUser("badpurpose@example.com");

    await expect(
      accountTokenRepository.create({
        userId: user._id,
        // @ts-expect-error -- intentionally invalid enum value to prove validation rejects it.
        purpose: "invitation",
        tokenHash: sha256("secret-c"),
        expiresAt: futureDate(),
      }),
    ).rejects.toThrow();
  });

  it("requires userId", async () => {
    await expect(
      // @ts-expect-error -- intentionally omitting a required field.
      accountTokenRepository.create({
        purpose: "email_verification",
        tokenHash: sha256("secret-d"),
        expiresAt: futureDate(),
      }),
    ).rejects.toThrow(/userId/);
  });

  it("requires tokenHash", async () => {
    const user = await createUser("nohash@example.com");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field.
      accountTokenRepository.create({
        userId: user._id,
        purpose: "email_verification",
        expiresAt: futureDate(),
      }),
    ).rejects.toThrow(/tokenHash/);
  });

  it("requires expiresAt", async () => {
    const user = await createUser("noexpiry@example.com");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field.
      accountTokenRepository.create({
        userId: user._id,
        purpose: "email_verification",
        tokenHash: sha256("secret-e"),
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("requires purpose", async () => {
    const user = await createUser("nopurpose@example.com");

    await expect(
      // @ts-expect-error -- intentionally omitting a required field.
      accountTokenRepository.create({
        userId: user._id,
        tokenHash: sha256("secret-f"),
        expiresAt: futureDate(),
      }),
    ).rejects.toThrow(/purpose/);
  });

  it("defaults consumedAt to null", async () => {
    const user = await createUser("unconsumed@example.com");
    const token = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("secret-g"),
      expiresAt: futureDate(),
    });

    expect(token.consumedAt).toBeNull();
  });

  it("sets createdAt and updatedAt", async () => {
    const user = await createUser("timestamps@example.com");
    const token = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("secret-h"),
      expiresAt: futureDate(),
    });

    expect(token.createdAt).toBeInstanceOf(Date);
    expect(token.updatedAt).toBeInstanceOf(Date);
  });

  it("carries no tenant, role, or permission fields", async () => {
    const user = await createUser("notenant@example.com");
    const token = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("secret-i"),
      expiresAt: futureDate(),
    });

    const plain = token.toObject();
    for (const field of [
      "organizationId",
      "membershipId",
      "role",
      "roles",
      "permissions",
      "status",
      "revokedAt",
      "invalidatedAt",
      "requestedForEmail",
      "ip",
      "userAgent",
      "metadata",
    ]) {
      expect(plain).not.toHaveProperty(field);
    }
  });

  // ---- security: hash handling ----

  it("excludes tokenHash from ordinary retrieval", async () => {
    const user = await createUser("hidden@example.com");
    const created = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("secret-j"),
      expiresAt: futureDate(),
    });

    const found = await AccountTokenModel.findById(created._id);
    expect(found).not.toBeNull();
    expect(found?.tokenHash).toBeUndefined();
  });

  it("excludes tokenHash from serialization even when explicitly selected", async () => {
    const user = await createUser("serialize@example.com");
    const created = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("secret-k"),
      expiresAt: futureDate(),
    });

    const selected = await AccountTokenModel.findById(created._id).select("+tokenHash");
    expect(selected?.tokenHash).toBeDefined();
    expect(selected?.toJSON()).not.toHaveProperty("tokenHash");
    expect(selected?.toObject()).not.toHaveProperty("tokenHash");
    expect(selected?.toJSON()).not.toHaveProperty("__v");
  });

  it("never persists the raw secret", async () => {
    const user = await createUser("rawsecret@example.com");
    const rawSecret = generateSecret();
    const created = await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256(rawSecret),
      expiresAt: futureDate(),
    });

    // Inspect the stored document at the driver level: nothing anywhere may
    // contain the raw value.
    const stored = await AccountTokenModel.collection.findOne({ _id: created._id });
    expect(JSON.stringify(stored)).not.toContain(rawSecret);
    expect(stored?.tokenHash).toBe(sha256(rawSecret));
  });

  it("rejects a duplicate tokenHash at the database level", async () => {
    const userA = await createUser("dup-a@example.com");
    const userB = await createUser("dup-b@example.com");
    const duplicateHash = sha256("shared-secret");

    await accountTokenRepository.create({
      userId: userA._id,
      purpose: "email_verification",
      tokenHash: duplicateHash,
      expiresAt: futureDate(),
    });

    await expect(
      accountTokenRepository.create({
        userId: userB._id,
        purpose: "password_reset",
        tokenHash: duplicateHash,
        expiresAt: futureDate(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("matches token hashes exactly and case-sensitively", async () => {
    const user = await createUser("exact@example.com");
    const hash = sha256("case-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    // Uppercased hex must not match the stored lowercase digest.
    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash.toUpperCase(),
        purpose: "password_reset",
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a hash that was never issued", async () => {
    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: sha256("never-issued"),
        purpose: "password_reset",
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  // ---- expiry ----

  it("consumes a token that has not yet expired", async () => {
    const user = await createUser("valid@example.com");
    const hash = sha256("valid-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    const consumed = await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "email_verification",
      now: new Date(),
    });

    expect(consumed).not.toBeNull();
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
  });

  it("cannot consume an expired token that is still physically present", async () => {
    const user = await createUser("expired@example.com");
    const hash = sha256("expired-secret");
    const created = await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: hash,
      expiresAt: pastDate(),
    });

    // TTL deletion is asynchronous, so the document is still there — proving
    // that "document exists" must never mean "token is valid".
    await expect(AccountTokenModel.findById(created._id)).resolves.not.toBeNull();

    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash,
        purpose: "email_verification",
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it("treats expiry as strictly greater than now", async () => {
    const user = await createUser("boundary@example.com");
    const hash = sha256("boundary-secret");
    const instant = new Date();
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: hash,
      expiresAt: instant,
    });

    // expiresAt === now is not "> now", so it must not be consumable.
    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash,
        purpose: "email_verification",
        now: instant,
      }),
    ).resolves.toBeNull();
  });

  // ---- purpose isolation ----

  it("cannot consume a password-reset token as an email verification", async () => {
    const user = await createUser("crosspurpose-a@example.com");
    const hash = sha256("reset-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash,
        purpose: "email_verification",
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it("cannot consume an email-verification token as a password reset", async () => {
    const user = await createUser("crosspurpose-b@example.com");
    const hash = sha256("verify-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash,
        purpose: "password_reset",
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it("leaves a token unconsumed after a wrong-purpose attempt", async () => {
    const user = await createUser("stillvalid@example.com");
    const hash = sha256("still-valid-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "email_verification",
      now: new Date(),
    });

    // The correct purpose must still work — a wrong-purpose attempt must not
    // burn the token.
    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash,
        purpose: "password_reset",
        now: new Date(),
      }),
    ).resolves.not.toBeNull();
  });

  // ---- single use ----

  it("allows only one successful consumption", async () => {
    const user = await createUser("singleuse@example.com");
    const hash = sha256("single-use-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    const first = await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "password_reset",
      now: new Date(),
    });
    const second = await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "password_reset",
      now: new Date(),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("stamps consumedAt with the supplied instant", async () => {
    const user = await createUser("stamp@example.com");
    const hash = sha256("stamp-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });
    const now = new Date();

    const consumed = await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "password_reset",
      now,
    });

    expect(consumed?.consumedAt?.getTime()).toBe(now.getTime());
  });

  it("does not return tokenHash on the consumed document", async () => {
    const user = await createUser("consumedhash@example.com");
    const hash = sha256("consumed-hash-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    const consumed = await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "password_reset",
      now: new Date(),
    });

    expect(consumed?.tokenHash).toBeUndefined();
    expect(consumed?.toJSON()).not.toHaveProperty("tokenHash");
  });

  it("keeps the consumed document until TTL rather than deleting it", async () => {
    const user = await createUser("retained@example.com");
    const hash = sha256("retained-secret");
    const created = await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: hash,
      purpose: "password_reset",
      now: new Date(),
    });

    // Retention is what lets a replayed already-used token be distinguished
    // from a fabricated one.
    const stillThere = await AccountTokenModel.findById(created._id);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.consumedAt).toBeInstanceOf(Date);
  });

  // ---- concurrency ----

  it("allows exactly one of two concurrent consumptions to succeed", async () => {
    const user = await createUser("race@example.com");
    const hash = sha256("race-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    const attempt = () =>
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: hash,
        purpose: "password_reset",
        now: new Date(),
      });

    const results = await Promise.all([attempt(), attempt()]);
    const succeeded = results.filter((result) => result !== null);
    const failed = results.filter((result) => result === null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    await expect(AccountTokenModel.countDocuments({ tokenHash: hash })).resolves.toBe(1);
    expect(succeeded[0]!.consumedAt).toBeInstanceOf(Date);
  });

  it("allows exactly one success across many concurrent consumptions", async () => {
    const user = await createUser("bigrace@example.com");
    const hash = sha256("big-race-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: hash,
      expiresAt: futureDate(),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        accountTokenRepository.consumeValidByHashAndPurpose({
          tokenHash: hash,
          purpose: "email_verification",
          now: new Date(),
        }),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(7);
  });

  // ---- invalidation ----

  it("deletes outstanding unused tokens for the target user and purpose", async () => {
    const user = await createUser("invalidate@example.com");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256("old-1"),
      expiresAt: futureDate(),
    });
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256("old-2"),
      expiresAt: futureDate(),
    });

    const deleted = await accountTokenRepository.invalidateOutstandingForUser({
      userId: user._id,
      purpose: "password_reset",
    });

    expect(deleted).toBe(2);
    await expect(
      AccountTokenModel.countDocuments({ userId: user._id, purpose: "password_reset" }),
    ).resolves.toBe(0);
  });

  it("does not affect another user's tokens", async () => {
    const userA = await createUser("iso-a@example.com");
    const userB = await createUser("iso-b@example.com");
    await accountTokenRepository.create({
      userId: userA._id,
      purpose: "password_reset",
      tokenHash: sha256("user-a-token"),
      expiresAt: futureDate(),
    });
    await accountTokenRepository.create({
      userId: userB._id,
      purpose: "password_reset",
      tokenHash: sha256("user-b-token"),
      expiresAt: futureDate(),
    });

    await accountTokenRepository.invalidateOutstandingForUser({
      userId: userA._id,
      purpose: "password_reset",
    });

    await expect(AccountTokenModel.countDocuments({ userId: userB._id })).resolves.toBe(1);
  });

  it("does not affect the same user's other purpose", async () => {
    const user = await createUser("crosspurge@example.com");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256("reset-token"),
      expiresAt: futureDate(),
    });
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "email_verification",
      tokenHash: sha256("verify-token"),
      expiresAt: futureDate(),
    });

    await accountTokenRepository.invalidateOutstandingForUser({
      userId: user._id,
      purpose: "password_reset",
    });

    await expect(
      AccountTokenModel.countDocuments({ userId: user._id, purpose: "email_verification" }),
    ).resolves.toBe(1);
  });

  it("preserves already-consumed records", async () => {
    const user = await createUser("preserve@example.com");
    const consumedHash = sha256("already-used");
    const created = await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: consumedHash,
      expiresAt: futureDate(),
    });
    await accountTokenRepository.consumeValidByHashAndPurpose({
      tokenHash: consumedHash,
      purpose: "password_reset",
      now: new Date(),
    });
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256("still-outstanding"),
      expiresAt: futureDate(),
    });

    const deleted = await accountTokenRepository.invalidateOutstandingForUser({
      userId: user._id,
      purpose: "password_reset",
    });

    // Only the unused one is removed; the consumed record survives for
    // replay detection and audit.
    expect(deleted).toBe(1);
    await expect(AccountTokenModel.findById(created._id)).resolves.not.toBeNull();
  });

  it("also removes expired unused tokens as harmless cleanup", async () => {
    const user = await createUser("expiredpurge@example.com");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: sha256("expired-unused"),
      expiresAt: pastDate(),
    });

    await expect(
      accountTokenRepository.invalidateOutstandingForUser({
        userId: user._id,
        purpose: "password_reset",
      }),
    ).resolves.toBe(1);
  });

  it("returns zero when there is nothing to invalidate", async () => {
    const user = await createUser("nothing@example.com");

    await expect(
      accountTokenRepository.invalidateOutstandingForUser({
        userId: user._id,
        purpose: "password_reset",
      }),
    ).resolves.toBe(0);
  });

  it("makes a superseded token unusable", async () => {
    const user = await createUser("superseded@example.com");
    const oldHash = sha256("superseded-secret");
    await accountTokenRepository.create({
      userId: user._id,
      purpose: "password_reset",
      tokenHash: oldHash,
      expiresAt: futureDate(),
    });

    await accountTokenRepository.invalidateOutstandingForUser({
      userId: user._id,
      purpose: "password_reset",
    });

    await expect(
      accountTokenRepository.consumeValidByHashAndPurpose({
        tokenHash: oldHash,
        purpose: "password_reset",
        now: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it("lets two users hold same-purpose tokens simultaneously", async () => {
    const userA = await createUser("concurrent-a@example.com");
    const userB = await createUser("concurrent-b@example.com");

    await accountTokenRepository.create({
      userId: userA._id,
      purpose: "password_reset",
      tokenHash: sha256("a-secret"),
      expiresAt: futureDate(),
    });
    await expect(
      accountTokenRepository.create({
        userId: userB._id,
        purpose: "password_reset",
        tokenHash: sha256("b-secret"),
        expiresAt: futureDate(),
      }),
    ).resolves.toBeDefined();
  });

  // ---- indexes ----

  it("declares a unique index on tokenHash", async () => {
    const indexes = await AccountTokenModel.collection.indexes();
    const tokenHashIndex = indexes.find(
      (index) => index.key?.tokenHash === 1 && Object.keys(index.key).length === 1,
    );

    expect(tokenHashIndex).toBeDefined();
    expect(tokenHashIndex?.unique).toBe(true);
  });

  it("declares a compound userId+purpose index", async () => {
    const indexes = await AccountTokenModel.collection.indexes();
    const compound = indexes.find(
      (index) => index.key?.userId === 1 && index.key?.purpose === 1,
    );

    expect(compound).toBeDefined();
    expect(compound?.unique).toBeUndefined();
  });

  it("declares a TTL index on expiresAt with expireAfterSeconds 0", async () => {
    const indexes = await AccountTokenModel.collection.indexes();
    const ttlIndex = indexes.find((index) => index.key?.expiresAt === 1);

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.expireAfterSeconds).toBe(0);
  });

  it("declares no standalone userId index", async () => {
    const indexes = await AccountTokenModel.collection.indexes();
    const standaloneUserId = indexes.find(
      (index) => index.key?.userId === 1 && Object.keys(index.key).length === 1,
    );

    // { userId, purpose } already provides the userId prefix.
    expect(standaloneUserId).toBeUndefined();
  });

  it("declares exactly the four intended indexes and no others", async () => {
    const indexes = await AccountTokenModel.collection.indexes();
    const keys = indexes.map((index) => JSON.stringify(index.key)).sort();

    expect(keys).toEqual(
      [
        JSON.stringify({ _id: 1 }),
        JSON.stringify({ tokenHash: 1 }),
        JSON.stringify({ userId: 1, purpose: 1 }),
        JSON.stringify({ expiresAt: 1 }),
      ].sort(),
    );
  });

  it("declares no index over consumedAt or other sensitive state", async () => {
    const indexes = await AccountTokenModel.collection.indexes();

    for (const index of indexes) {
      expect(index.key).not.toHaveProperty("consumedAt");
    }
  });
});
