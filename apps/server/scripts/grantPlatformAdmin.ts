import { createInterface } from "node:readline/promises";

import mongoose from "mongoose";

import { env } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { UserModel, normalizeEmail } from "../src/modules/users/user.model";

/**
 * Grants — or revokes — platform-admin standing on an existing account
 * (ADR-032 §11).
 *
 * This is the ONLY way `platformRole` is ever written. No endpoint sets it,
 * registration cannot reach it, and no amount of organization ownership
 * confers it. That is the whole design: the most powerful role in the system
 * is reachable only by someone who already holds the database credentials, so
 * there is no self-service path to escalate into it and no request an attacker
 * could forge to acquire it.
 *
 * It deliberately does NOT create accounts. The account must already exist —
 * invited, with a real address it has verified (ADR-037 removed public sign-up)
 * — and this promotes it. A script that both minted an
 * account and made it omniscient would be a single command that turns database
 * access into a working platform login, and keeping the two steps apart means
 * an admin account is one a human being demonstrably controls the inbox of.
 *
 * Refuses to run against production, like `create:admin` and for a sharper
 * reason. Granting platform access is exactly the action an attacker with a
 * stray environment variable would want, and the guard means this cannot be
 * turned on the live database by accident.
 *
 *   npm run grant:admin --workspace=apps/server
 *   npm run grant:admin --workspace=apps/server -- someone@example.com
 *   npm run grant:admin --workspace=apps/server -- someone@example.com --revoke
 *
 * Takes its arguments from `argv` when they are given, and prompts when they
 * are not. `create:admin` deliberately refuses that — argv is visible in the
 * process list and lands in shell history — and the difference is that this
 * script reads NO SECRET. An email address is not a credential, and the flag
 * says which of two directions to move a field that is already public to
 * anyone who can read the database. Nothing here is worth hiding from `ps`.
 *
 * It also makes the script runnable without a terminal, which the prompting
 * path is not: `readline/promises` does not reliably deliver a second answer
 * from redirected stdin, so a piped `create:admin` prints its prompts and
 * silently does nothing. Anything that must be verified should be runnable
 * without a human at a keyboard.
 */

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    fail(
      "grant:admin refuses to run with NODE_ENV=production. It grants platform-wide read access with no email check and no audit trail; grant it deliberately against a database you are looking at.",
    );
  }

  /*
    `--revoke` is the only flag, and the argument that is not a flag is the
    address. Deliberately not an argument parser: two inputs do not justify a
    dependency, and a hand-rolled loop that accepted `--role=admin` would be
    inventing a second way to say what the flag already says.
  */
  const args = process.argv.slice(2);
  const wantsRevoke = args.includes("--revoke");
  const emailArg = args.find((arg) => !arg.startsWith("--"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const rawEmail = (emailArg ?? (await rl.question("Email of an existing account: "))).trim();
    if (rawEmail.length === 0) fail("An email is required.");
    const email = normalizeEmail(rawEmail);

    /*
      Asked rather than assumed, when it was not given. A script whose only
      direction is "grant" needs a second script to undo it, and the second one
      is always the one nobody wrote — so revocation lives here, one keystroke
      away, and is as easy to run as the grant it reverses.

      The prompt is skipped entirely when the address came from argv: someone
      who typed the whole command has already said what they meant, and
      stopping to ask would make the non-interactive path no more usable than
      the interactive one.
    */
    let platformRole: "admin" | "none" = wantsRevoke ? "none" : "admin";

    if (emailArg === undefined) {
      const answer = (await rl.question("Grant or revoke? [grant/revoke, default grant]: ")).trim().toLowerCase();
      if (answer !== "" && answer !== "grant" && answer !== "revoke") {
        fail(`Expected "grant" or "revoke", got "${answer}". Nothing was changed.`);
      }
      platformRole = answer === "revoke" ? "none" : "admin";
    }

    await mongoose.connect(env.MONGODB_URI);

    const user = await UserModel.findOne({ email });
    if (user === null) {
      fail(`No account exists for ${email}. Invite them first, and run this again once they have verified.`);
    }

    /*
      Refused rather than granted-and-warned. An unverified account cannot
      sign in at all (ADR-030), so granting one platform access produces a
      grant that does nothing and an operator who believes they are done — and
      the fix, verifying the address, is a step the person themselves must
      take.
    */
    if (platformRole === "admin" && user.emailVerifiedAt === null) {
      fail(
        `${email} has not verified their address, so they cannot sign in and a grant would do nothing. Verify it first, then run this again.`,
      );
    }

    if (user.platformRole === platformRole) {
      process.stdout.write(`\n${email} already has platformRole "${platformRole}". Nothing was changed.\n\n`);
      return;
    }

    user.platformRole = platformRole;
    await user.save();

    /*
      Written to stdout rather than through the logger: this is a report to the
      person who just typed it, not an application event. The portal's address
      is printed because it is unlisted — nothing in the product links to it,
      so this is where an operator learns where to go.
    */
    process.stdout.write(
      [
        "",
        platformRole === "admin" ? "Granted platform admin:" : "Revoked platform admin:",
        `  account      ${user.email}`,
        `  platformRole ${platformRole}`,
        "",
        ...(platformRole === "admin"
          ? [
              `Sign in at ${env.CLIENT_URL}/control — the private console. It is deliberately`,
              "unlinked from every other page, so this address is the only record of it.",
              "",
            ]
          : ["Any console session they hold stops working on their next request.", ""]),
      ].join("\n"),
    );
  } finally {
    rl.close();
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "grant:admin failed");
  process.exit(1);
});
