import argon2 from "argon2";
import { describe, expect, it } from "vitest";

import {
  ARGON2_MEMORY_COST,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../../config/constants";
import { hashPassword, isPasswordLengthValid, needsRehash, normalizePassword, verifyPassword } from "./password";

/** Test passwords only — never a real credential. */
const VALID_PASSWORD = "correct-horse-battery";

describe("password normalization", () => {
  it("normalizes canonically equivalent sequences identically (NFC)", () => {
    // "é" precomposed (U+00E9) vs decomposed (e + combining acute U+0301).
    const precomposed = "café-password";
    const decomposed = "café-password";

    expect(precomposed).not.toBe(decomposed);
    expect(normalizePassword(precomposed)).toBe(normalizePassword(decomposed));
  });

  it("keeps compatibility-equivalent characters distinct (NFC, not NFKC)", () => {
    // NFKC would fold these together and shrink the password space; NFC must not.
    const ligature = "aﬁxed-password"; // "ﬁ" ligature
    const expanded = "afixed-password";
    expect(normalizePassword(ligature)).not.toBe(normalizePassword(expanded));

    const fullwidth = "ＡBCDEFGHIJ"; // fullwidth "Ａ"
    const halfwidth = "ABCDEFGHIJ";
    expect(normalizePassword(fullwidth)).not.toBe(normalizePassword(halfwidth));

    const circled = "①234567890"; // "①"
    expect(normalizePassword(circled)).not.toBe(normalizePassword("1234567890"));
  });

  it("preserves leading and trailing whitespace", () => {
    // Passwords are opaque secrets, not identifiers: unlike email, they are never trimmed.
    const padded = "  spaced-password  ";
    expect(normalizePassword(padded)).toBe(padded);
  });

  it("verifies a password whose stored and supplied forms differ only by canonical composition", async () => {
    const hash = await hashPassword("café-password");
    await expect(verifyPassword(hash, "café-password")).resolves.toBe(true);
  });
});

describe("password hashing", () => {
  it("hashes with Argon2id using the configured parameters", async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    const [, algorithm, , params] = hash.split("$");

    expect(algorithm).toBe("argon2id");
    expect(params).toBe(`m=${ARGON2_MEMORY_COST},p=${ARGON2_PARALLELISM},t=${ARGON2_TIME_COST}`);
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    await expect(verifyPassword(hash, VALID_PASSWORD)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    await expect(verifyPassword(hash, "wrong-horse-battery")).resolves.toBe(false);
  });

  it("never embeds the plaintext password in the hash", async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    expect(hash).not.toContain(VALID_PASSWORD);
    expect(hash).not.toContain("correct-horse");
  });

  it("produces a different hash for the same password each time (random salt)", async () => {
    const first = await hashPassword(VALID_PASSWORD);
    const second = await hashPassword(VALID_PASSWORD);

    expect(first).not.toBe(second);
    await expect(verifyPassword(first, VALID_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(second, VALID_PASSWORD)).resolves.toBe(true);
  });

  it("returns false rather than throwing for a malformed stored hash", async () => {
    await expect(verifyPassword("not-a-real-argon2-hash", VALID_PASSWORD)).resolves.toBe(false);
  });
});

describe("needsRehash", () => {
  it("returns false for a hash produced with the current parameters", async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    expect(needsRehash(hash)).toBe(false);
  });

  it("returns true for a hash produced with weaker parameters", async () => {
    const weakHash = await argon2.hash(VALID_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });

    expect(needsRehash(weakHash)).toBe(true);
    // The old hash must still verify, so a login can transparently upgrade it.
    await expect(argon2.verify(weakHash, VALID_PASSWORD)).resolves.toBe(true);
  });
});

describe("password length policy", () => {
  it("accepts a password at the minimum length", async () => {
    const atMinimum = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(isPasswordLengthValid(atMinimum)).toBe(true);
    await expect(hashPassword(atMinimum)).resolves.toEqual(expect.any(String));
  });

  it("accepts a password at the maximum length", async () => {
    const atMaximum = "a".repeat(PASSWORD_MAX_LENGTH);
    expect(isPasswordLengthValid(atMaximum)).toBe(true);
    await expect(hashPassword(atMaximum)).resolves.toEqual(expect.any(String));
  });

  it("rejects a password below the minimum length", async () => {
    const tooShort = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(isPasswordLengthValid(tooShort)).toBe(false);
    await expect(hashPassword(tooShort)).rejects.toThrow(RangeError);
  });

  it("rejects a password above the maximum length", async () => {
    const tooLong = "a".repeat(PASSWORD_MAX_LENGTH + 1);
    expect(isPasswordLengthValid(tooLong)).toBe(false);
    await expect(hashPassword(tooLong)).rejects.toThrow(RangeError);
  });

  it("never includes the password in the length error message", async () => {
    const secret = "s".repeat(PASSWORD_MAX_LENGTH + 1);
    await expect(hashPassword(secret)).rejects.toThrow(
      new RegExp(`^Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters$`),
    );
  });

  it("measures length in code points, not UTF-16 units", () => {
    // Each emoji is one code point but two UTF-16 units; 10 of them meets the minimum.
    const emojiPassword = "🔐".repeat(PASSWORD_MIN_LENGTH);
    expect(emojiPassword.length).toBeGreaterThan(PASSWORD_MIN_LENGTH);
    expect(isPasswordLengthValid(emojiPassword)).toBe(true);
  });

  it("returns false instead of throwing when verifying an over-long password", async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    await expect(verifyPassword(hash, "a".repeat(PASSWORD_MAX_LENGTH + 1))).resolves.toBe(false);
  });

  it("does not enforce the minimum length when verifying", async () => {
    // A short login attempt is simply wrong, not an error.
    const hash = await hashPassword(VALID_PASSWORD);
    await expect(verifyPassword(hash, "short")).resolves.toBe(false);
  });
});
