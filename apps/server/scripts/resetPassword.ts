import { randomBytes } from "node:crypto";

import mongoose from "mongoose";

import { hashPassword } from "../src/lib/crypto/password";
import { env } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { sessionRepository } from "../src/modules/sessions/session.repository";
import { UserModel, normalizeEmail } from "../src/modules/users/user.model";
import { userRepository } from "../src/modules/users/user.repository";

/**
 * Gives one existing account a new generated password, and signs it out
 * everywhere (ADR-036 §6).
 *
 * The recovery path for the one account the emailed reset refuses: the
 * platform admin, whose inbox is deliberately not enough to take over the
 * deployment. It is also how an operator rotates a password that has leaked —
 * a screenshot, a pasted terminal, a chat log — WITHOUT `reset:platform`,
 * which rotates it by deleting everything else too.
 *
 *   npm run reset:password --workspace=apps/server -- someone@example.com
 *
 * The address comes from argv, for `grant:admin`'s reason: it is not a secret.
 * The password is not taken from anywhere — it is generated, because a
 * password typed as an argument lands in shell history and the process list,
 * and a prompt cannot be driven without a terminal.
 *
 * What it does, all of it:
 *
 *   1. Replaces the password hash with a fresh Argon2id hash of 144 random bits.
 *   2. Lifts any login lockout, since the operator is presumably trying to get
 *      somebody back in.
 *   3. Revokes every session the account holds. A leaked password is the
 *      reason to run this, and whoever used it may still be signed in.
 *
 * It does NOT verify an unverified address. An operator with database access
 * has authority over the account, but has not shown that anybody reads the
 * inbox — and verification is a statement about exactly that.
 *
 * Refuses `NODE_ENV=production`, like every other script here. Handing out a
 * working credential for any account is precisely what a stray environment
 * variable must not be able to do to the live database.
 */

/** 18 bytes is 144 bits, rendered base64url — pasteable, and not guessable. */
const PASSWORD_BYTES = 18;

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    fail("reset:password refuses to run with NODE_ENV=production.");
  }

  const emailArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (emailArg === undefined || emailArg.trim().length === 0) {
    fail("Usage: npm run reset:password --workspace=apps/server -- someone@example.com");
  }
  const email = normalizeEmail(emailArg);

  await mongoose.connect(env.MONGODB_URI);

  try {
    const user = await UserModel.findOne({ email });
    if (user === null) {
      fail(`No account exists for ${email}. Nothing was changed.`);
    }

    const password = randomBytes(PASSWORD_BYTES).toString("base64url");
    await userRepository.replacePasswordAfterReset(user._id, await hashPassword(password));
    const revoked = await sessionRepository.revokeAllForUser(user._id);

    /*
      Stdout, not the logger, and the only time this password exists anywhere.
      Nothing stores it — an operator who loses this output runs the script
      again, which costs nothing but another round of sign-outs.
    */
    process.stdout.write(
      [
        "",
        "Password replaced.",
        "",
        `  account        ${user.email}  (${user.kind}${user.platformRole === "admin" ? ", platform admin" : ""})`,
        `  password       ${password}`,
        `  signed out     ${revoked} session${revoked === 1 ? "" : "s"}`,
        ...(user.emailVerifiedAt === null
          ? ["", "  This address is still UNVERIFIED, so the account cannot sign in until it is."]
          : []),
        "",
        "Shown once and not recoverable. Save it now, and change it after signing in.",
        "",
      ].join("\n"),
    );
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "reset:password failed");
  process.exit(1);
});
