import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PASSWORD_RESET_MAX_ATTEMPTS, REFRESH_COOKIE_NAME } from "../src/config/constants";
import { sha256 } from "../src/lib/crypto/tokens";
import { createApp } from "../src/app";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { createFakeEmailProvider } from "../src/modules/auth/testing/fakeEmailProvider";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel } from "../src/modules/users/user.model";

/**
 * Password reset by emailed code (ADR-036).
 *
 * The assertions fall into three groups, and the third is the one that
 * matters most. What a redeemed code DOES (new password works, old one does
 * not, every session ends, lockout lifts). What it REFUSES (and that every
 * refusal looks the same). And what the flow must never become: a way to
 * learn whether an address has an account, a way to reset the platform
 * admin through their inbox, or a password oracle that works without a code.
 */

const REGISTER_PATH = "/api/v1/auth/register";
const VERIFY_PATH = "/api/v1/auth/verify-email";
const LOGIN_PATH = "/api/v1/auth/login";
const REFRESH_PATH = "/api/v1/auth/refresh";
const FORGOT_PATH = "/api/v1/auth/forgot-password";
const RESET_PATH = "/api/v1/auth/reset-password";

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const NEW_PASSWORD = "a-brand-new-passphrase";
const EMAIL = "ada@example.com";

function buildApp() {
  const fake = createFakeEmailProvider();
  return { fake, app: createApp({ emailProvider: fake.provider }) };
}

type Ctx = ReturnType<typeof buildApp>;

async function register(ctx: Ctx, email = EMAIL) {
  await request(ctx.app).post(REGISTER_PATH).send({ name: "Ada Lovelace", email, password: PASSWORD });
}

async function registerAndVerify(ctx: Ctx, email = EMAIL) {
  await register(ctx, email);
  const code = ctx.fake.verifications.at(-1)!.code;
  await request(ctx.app).post(VERIFY_PATH).send({ email, code });
}

/** Asks for a reset and returns the code the fake provider captured. */
async function requestCode(ctx: Ctx, email = EMAIL): Promise<string> {
  const response = await request(ctx.app).post(FORGOT_PATH).send({ email });
  expect(response.status).toBe(204);
  return ctx.fake.passwordResets.at(-1)!.code;
}

const signIn = (ctx: Ctx, password: string, email = EMAIL) =>
  request(ctx.app).post(LOGIN_PATH).send({ email, password });

function refreshCookie(response: request.Response): string {
  const cookies = response.headers["set-cookie"] as unknown as string[];
  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`))!.split(";")[0]!;
}

/** The refusal with its per-request fields removed, so two can be compared. */
const refusal = (response: request.Response) => ({ code: response.body.error.code, message: response.body.error.message });

/** A well-formed six-digit value that is never the real code. */
const wrongCode = (actual: string) => (actual === "000000" ? "111111" : "000000");

describe("password reset", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await UserModel.init();
    await AccountTokenModel.init();
    await SessionModel.init();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), AccountTokenModel.deleteMany({}), SessionModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ---- asking for a code ----

  describe("POST /forgot-password", () => {
    it("answers 204 and mails a six-digit code to an existing account", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);

      const response = await request(ctx.app).post(FORGOT_PATH).send({ email: EMAIL });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(ctx.fake.passwordResets).toHaveLength(1);
      expect(ctx.fake.passwordResets[0]!.to).toBe(EMAIL);
      expect(ctx.fake.passwordResets[0]!.code).toMatch(/^[0-9]{6}$/);
    });

    it("answers an unknown address identically, and sends nothing", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);

      const known = await request(ctx.app).post(FORGOT_PATH).send({ email: EMAIL });
      const unknown = await request(ctx.app).post(FORGOT_PATH).send({ email: "nobody@example.com" });

      expect(unknown.status).toBe(known.status);
      expect(unknown.text).toBe(known.text);
      expect(ctx.fake.passwordResets).toHaveLength(1);
    });

    it("puts no secret in the URL — only the address, for prefill", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      const url = new URL(ctx.fake.passwordResets[0]!.resetUrl);
      expect(url.pathname).toBe("/reset-password");
      expect(url.searchParams.get("email")).toBe(EMAIL);
      expect(url.toString()).not.toContain(code);
    });

    it("stores only the code's hash", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      const token = await AccountTokenModel.findOne({ purpose: "password_reset" }).select("+tokenHash");
      expect(token!.tokenHash).toBe(sha256(code));
      expect(token!.tokenHash).not.toContain(code);
    });

    it("supersedes an earlier code, so only the newest works", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const first = await requestCode(ctx);
      const second = await requestCode(ctx);

      expect(await AccountTokenModel.countDocuments({ purpose: "password_reset", consumedAt: null })).toBe(1);

      if (first !== second) {
        const stale = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code: first, newPassword: NEW_PASSWORD });
        expect(stale.status).toBe(400);
      }
      const fresh = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code: second, newPassword: NEW_PASSWORD });
      expect(fresh.status).toBe(204);
    });

    it("sends nothing for the platform admin, and says so to nobody", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { platformRole: "admin", kind: "admin" } });

      const response = await request(ctx.app).post(FORGOT_PATH).send({ email: EMAIL });

      expect(response.status).toBe(204);
      expect(ctx.fake.passwordResets).toHaveLength(0);
      expect(await AccountTokenModel.countDocuments({ purpose: "password_reset" })).toBe(0);
    });

    it("sends nothing for a disabled account", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { status: "disabled" } });

      const response = await request(ctx.app).post(FORGOT_PATH).send({ email: EMAIL });

      expect(response.status).toBe(204);
      expect(ctx.fake.passwordResets).toHaveLength(0);
    });

    it("refuses a malformed address at the boundary", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app).post(FORGOT_PATH).send({ email: "not-an-address" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---- redeeming it ----

  describe("POST /reset-password", () => {
    it("answers 204, and the new password signs in while the old one does not", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      const response = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(204);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect((await signIn(ctx, NEW_PASSWORD)).status).toBe(200);
      expect((await signIn(ctx, PASSWORD)).status).toBe(401);
    });

    it("ends every session the account held", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const laptop = refreshCookie(await signIn(ctx, PASSWORD));
      const phone = refreshCookie(await signIn(ctx, PASSWORD));

      const code = await requestCode(ctx);
      await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect((await request(ctx.app).post(REFRESH_PATH).set("Cookie", laptop)).status).toBe(401);
      expect((await request(ctx.app).post(REFRESH_PATH).set("Cookie", phone)).status).toBe(401);
    });

    it("lifts a lockout, because the locked-out person is who a reset is for", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      await UserModel.updateOne(
        { email: EMAIL },
        { $set: { failedLoginAttempts: 3, lockedUntil: new Date(Date.now() + 60 * 60 * 1000) } },
      );

      const code = await requestCode(ctx);
      await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      const user = await UserModel.findOne({ email: EMAIL });
      expect(user!.lockedUntil).toBeNull();
      expect(user!.failedLoginAttempts).toBe(0);
      expect((await signIn(ctx, NEW_PASSWORD)).status).toBe(200);
    });

    it("verifies an unverified address, since the code proved the inbox", async () => {
      const ctx = buildApp();
      await register(ctx);
      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).toBeNull();

      const code = await requestCode(ctx);
      await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).not.toBeNull();
      expect((await signIn(ctx, NEW_PASSWORD)).status).toBe(200);
      // The verification code that was outstanding is no longer needed.
      expect(await AccountTokenModel.countDocuments({ purpose: "email_verification", consumedAt: null })).toBe(0);
    });

    it("keeps an existing verification timestamp rather than overwriting it", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const before = (await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt!;

      const code = await requestCode(ctx);
      await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt!.getTime()).toBe(before.getTime());
    });

    it("is single-use", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });
      const replay = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: EMAIL, code, newPassword: "yet-another-passphrase" });

      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe("INVALID_PASSWORD_RESET_CODE");
      expect((await signIn(ctx, NEW_PASSWORD)).status).toBe(200);
    });

    it("refuses an expired code", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);
      await AccountTokenModel.updateOne({ purpose: "password_reset" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      const response = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(400);
      expect((await signIn(ctx, PASSWORD)).status).toBe(200);
    });

    it("answers a wrong code and an unknown address with the same refusal", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      const wrong = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: EMAIL, code: wrongCode(code), newPassword: NEW_PASSWORD });
      const unknown = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: "nobody@example.com", code, newPassword: NEW_PASSWORD });

      expect(wrong.status).toBe(400);
      expect(unknown.status).toBe(400);
      expect(refusal(unknown)).toEqual(refusal(wrong));
    });

    it(`destroys the code after ${PASSWORD_RESET_MAX_ATTEMPTS} wrong guesses, so the right one then fails`, async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      for (let i = 0; i < PASSWORD_RESET_MAX_ATTEMPTS; i += 1) {
        await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code: wrongCode(code), newPassword: NEW_PASSWORD });
      }
      const correct = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect(correct.status).toBe(400);
      expect((await signIn(ctx, PASSWORD)).status).toBe(200);
    });

    it("refuses a too-short new password without spending the code", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      const short = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: "short" });
      expect(short.status).toBe(400);
      expect(short.body.error.code).toBe("VALIDATION_ERROR");

      const retry = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });
      expect(retry.status).toBe(204);
    });

    it("refuses a malformed code without spending a guess", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      await requestCode(ctx);

      const response = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code: "12ab", newPassword: NEW_PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect((await AccountTokenModel.findOne({ purpose: "password_reset" }))!.attempts).toBe(0);
    });

    it("will not accept a verification code as a reset code", async () => {
      const ctx = buildApp();
      await register(ctx);
      const verificationCode = ctx.fake.verifications.at(-1)!.code;

      const response = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: EMAIL, code: verificationCode, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(400);
      expect((await signIn(ctx, NEW_PASSWORD)).status).not.toBe(200);
    });

    it("refuses a code whose account became the platform admin after it was issued", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);
      await UserModel.updateOne({ email: EMAIL }, { $set: { platformRole: "admin" } });

      const response = await request(ctx.app).post(RESET_PATH).send({ email: EMAIL, code, newPassword: NEW_PASSWORD });

      expect(response.status).toBe(400);
      expect((await signIn(ctx, PASSWORD)).status).toBe(200);
    });

    it("is not a password oracle: a guess at the current password changes nothing without the code", async () => {
      const ctx = buildApp();
      await registerAndVerify(ctx);
      const code = await requestCode(ctx);

      const guessRight = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: EMAIL, code: wrongCode(code), newPassword: PASSWORD });
      const guessWrong = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: EMAIL, code: wrongCode(code), newPassword: "not-the-password-at-all" });

      expect(guessRight.status).toBe(guessWrong.status);
      expect(refusal(guessRight)).toEqual(refusal(guessWrong));
    });

    it("rejects unknown fields", async () => {
      const ctx = buildApp();
      const response = await request(ctx.app)
        .post(RESET_PATH)
        .send({ email: EMAIL, code: "123456", newPassword: NEW_PASSWORD, userId: "someone-else" });
      expect(response.status).toBe(400);
    });
  });
});
