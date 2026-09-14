import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EMAIL_VERIFICATION_CODE_LENGTH, EMAIL_VERIFICATION_MAX_ATTEMPTS } from "../../config/constants";
import { InvalidVerificationTokenError } from "../../lib/errors";
import { AccountTokenModel } from "../accountTokens/accountToken.model";
import { UserModel } from "../users/user.model";
import { createFakeEmailProvider } from "./testing/fakeEmailProvider";
import { createStaffAccount } from "./testing/staffAccounts";
import { createVerificationService } from "./verification.service";

import type { AuthLogger } from "./authLogging";

/**
 * What makes a six-digit code a credential (ADR-030 §4).
 *
 * The existing `verifyEmail.service.test.ts` covers redemption, expiry,
 * single-use and enumeration — properties a link had too, and which survived
 * the change of format. This suite covers the property that is NEW, and
 * without which the whole scheme is theatre.
 *
 * A 43-character link secret has ~256 bits: guessing it is not a threat
 * anyone models, and no link flow ever needed to count wrong attempts. A
 * six-digit code has about 20 bits — one in a million — which a script walks
 * through in minutes over a network. So the code alone is not the boundary.
 * The boundary is the code PLUS its ten-minute lifetime PLUS the five
 * guesses it survives, and only the third of those is enforced here.
 */

const PASSWORD = "DO_NOT_LEAK_THIS_PASSWORD";
const EMAIL = "ada@example.com";

function buildServices() {
  const fake = createFakeEmailProvider();
  return {
    fake,
    verification: createVerificationService({ emailProvider: fake.provider }),
  };
}

async function registerAndGetCode(services: ReturnType<typeof buildServices>, email = EMAIL) {
  const user = await createStaffAccount(services.fake.provider, { name: "Ada Lovelace", email, password: PASSWORD });
  return { user, code: services.fake.verifications.at(-1)!.code };
}

/** A well-formed six-digit value that is never the real code. */
function wrongCode(actual: string): string {
  return actual === "000000" ? "111111" : "000000";
}

/** Swallows logging so a refusal path under test does not print. */
const silent: AuthLogger = { info: () => undefined, error: () => undefined };

async function tokenFor(userId: string) {
  return AccountTokenModel.findOne({ userId, purpose: "email_verification" });
}

describe("Verification code brute-force resistance", () => {
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

  describe("the issued code", () => {
    it("is exactly the configured number of digits", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);

      expect(code).toHaveLength(EMAIL_VERIFICATION_CODE_LENGTH);
      expect(code).toMatch(/^[0-9]+$/);
    });

    /*
      Assembled as a string precisely so a code beginning with zero keeps its
      width. A numeric type would render `042931` as `42931`, and every code
      starting with a zero would silently become five digits — halving the
      search space for a tenth of all codes.
    */
    it("is a string, so leading zeros survive", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);

      expect(typeof code).toBe("string");
      expect(String(Number(code)).padStart(EMAIL_VERIFICATION_CODE_LENGTH, "0")).toBe(code);
    });

    it("is never stored in the clear", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      const raw = await mongoose.connection
        .collection("accounttokens")
        .findOne({ userId: new mongoose.Types.ObjectId(user.id) });

      // Quoted: six bare digits collide by chance with digits inside an
      // ObjectId or a timestamp, and a flaky secrecy test gets muted.
      expect(JSON.stringify(raw)).not.toContain(`"${code}"`);
    });
  });

  describe("wrong guesses", () => {
    it("counts each one against the issued code", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      const wrong = wrongCode(code);

      await expect(
        services.verification.verifyEmail({ email: EMAIL, code: wrong }, silent),
      ).rejects.toBeInstanceOf(InvalidVerificationTokenError);

      expect((await tokenFor(user.id))!.attempts).toBe(1);
    });

    it("counts them cumulatively", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      const wrong = wrongCode(code);

      for (let i = 0; i < 3; i += 1) {
        await services.verification.verifyEmail({ email: EMAIL, code: wrong }, silent).catch(() => undefined);
      }

      expect((await tokenFor(user.id))!.attempts).toBe(3);
    });

    it("leaves the code usable while budget remains", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      const wrong = wrongCode(code);

      await services.verification.verifyEmail({ email: EMAIL, code: wrong }, silent).catch(() => undefined);

      // A wrong guess must not cost the real code its validity, or one
      // mistyped digit would force every user through a resend.
      await expect(services.verification.verifyEmail({ email: EMAIL, code })).resolves.toBeUndefined();
      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).not.toBeNull();
    });
  });

  describe("exhausting the budget", () => {
    it("destroys the code on the configured attempt", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      const wrong = wrongCode(code);

      for (let i = 0; i < EMAIL_VERIFICATION_MAX_ATTEMPTS; i += 1) {
        await services.verification.verifyEmail({ email: EMAIL, code: wrong }, silent).catch(() => undefined);
      }

      const token = await tokenFor(user.id);
      expect(token!.attempts).toBe(EMAIL_VERIFICATION_MAX_ATTEMPTS);
      // Consumed, not merely flagged.
      expect(token!.consumedAt).not.toBeNull();
    });

    /*
      The property that actually matters. Counting attempts would be pointless
      if the correct code still worked afterwards — an attacker who guesses
      right on try six has still won. Exhaustion must leave nothing to test.
    */
    it("refuses the CORRECT code once the budget is spent", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);
      const wrong = wrongCode(code);

      for (let i = 0; i < EMAIL_VERIFICATION_MAX_ATTEMPTS; i += 1) {
        await services.verification.verifyEmail({ email: EMAIL, code: wrong }, silent).catch(() => undefined);
      }

      await expect(
        services.verification.verifyEmail({ email: EMAIL, code }, silent),
      ).rejects.toBeInstanceOf(InvalidVerificationTokenError);
      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).toBeNull();
    });

    it("lets a resend restore a working code and a fresh budget", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);
      const wrong = wrongCode(code);

      for (let i = 0; i < EMAIL_VERIFICATION_MAX_ATTEMPTS; i += 1) {
        await services.verification.verifyEmail({ email: EMAIL, code: wrong }, silent).catch(() => undefined);
      }

      await services.verification.resendVerification({ email: EMAIL });
      const replacement = services.fake.verifications.at(-1)!.code;

      /*
        The escape hatch, and the reason locking a code rather than an
        account is the right granularity: a real user who fumbles five times
        asks for another email, while an attacker must trigger a fresh send
        — metered by the resend rate limiter — to buy each new set of five.
      */
      await expect(
        services.verification.verifyEmail({ email: EMAIL, code: replacement }),
      ).resolves.toBeUndefined();
      expect((await UserModel.findOne({ email: EMAIL }))!.emailVerifiedAt).not.toBeNull();
      expect(user.id).toBeTruthy();
    });
  });

  describe("scope of the budget", () => {
    /*
      Counted on the token document, so it cannot be reset by rotating an IP,
      a session, or a user agent — the budget belongs to the credential being
      guessed, not to the guesser's current disguise.
    */
    it("does not spend one user's budget on another user's wrong guess", async () => {
      const services = buildServices();
      const { user: ada, code: adaCode } = await registerAndGetCode(services);
      const { user: grace } = await registerAndGetCode(services, "grace@example.com");

      await services.verification
        .verifyEmail({ email: "grace@example.com", code: wrongCode(adaCode) }, silent)
        .catch(() => undefined);

      expect((await tokenFor(grace.id))!.attempts).toBe(1);
      expect((await tokenFor(ada.id))!.attempts).toBe(0);
    });

    it("costs nothing when the address has no account", async () => {
      const services = buildServices();
      const { user, code } = await registerAndGetCode(services);

      await services.verification
        .verifyEmail({ email: "nobody@example.com", code: wrongCode(code) }, silent)
        .catch(() => undefined);

      // A guess at an address with no pending code teaches the guesser
      // nothing and costs a real user nothing.
      expect((await tokenFor(user.id))!.attempts).toBe(0);
    });

    /*
      Same refusal whether the account exists, so this endpoint cannot be
      turned into an account-existence oracle (ADR-007 §4).
    */
    it("refuses identically for an unknown address and a wrong code", async () => {
      const services = buildServices();
      const { code } = await registerAndGetCode(services);

      const outcomes = await Promise.all(
        [
          { email: "nobody@example.com", code: wrongCode(code) },
          { email: EMAIL, code: wrongCode(code) },
        ].map((input) =>
          services.verification.verifyEmail(input, silent).catch((err: unknown) => ({
            code: (err as InvalidVerificationTokenError).code,
            status: (err as InvalidVerificationTokenError).httpStatus,
            message: (err as Error).message,
          })),
        ),
      );

      expect(outcomes[0]).toEqual(outcomes[1]);
    });
  });
});
