import { createInterface } from "node:readline/promises";

import mongoose from "mongoose";

import { hashPassword, isPasswordLengthValid, normalizePassword } from "../src/lib/crypto/password";
import { env } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { UserModel, normalizeEmail } from "../src/modules/users/user.model";
import { isReservedSlug, isWellFormedSlug, slugifyOrganizationName } from "../src/modules/organizations/organizationSlug";

/**
 * Creates a ready-to-use owner account without the email round trip.
 *
 * Bootstrapping a workspace by hand is four steps — register, read a code
 * out of an inbox, redeem it before it expires, then create an
 * organization — and every one of them can fail in a way that leaves a
 * half-made account behind. That is fine as the product's front door and
 * miserable as a development chore, which is what this script removes.
 *
 * It is NOT a second signup path. It writes the same three documents the
 * real flow writes, in the same shapes, with `emailVerifiedAt` already set
 * — because the point of verification is proving control of an inbox, and
 * an operator with shell access to the database has already demonstrated
 * far more authority than an inbox confers.
 *
 * Refuses to run against production. Not defensive tidiness: a script that
 * mints a verified owner while skipping every check is precisely the tool
 * an attacker would want, and the guard means it cannot be turned on the
 * live database by a stray environment variable.
 *
 *   npm run create:admin --workspace=apps/server
 *
 * Reads the password from stdin rather than argv or an environment
 * variable: both of those persist. `argv` is visible to every other process
 * on the machine through the process list and lands in shell history, and
 * an env var is inherited by every child process.
 */

const ROLE = "owner" as const;

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    fail(
      "create:admin refuses to run with NODE_ENV=production. It creates a verified owner without any email check; use the real signup flow instead.",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const name = (await rl.question("Full name: ")).trim();
    if (name.length === 0) fail("A name is required.");

    const rawEmail = (await rl.question("Email: ")).trim();
    if (rawEmail.length === 0) fail("An email is required.");
    const email = normalizeEmail(rawEmail);

    const password = await rl.question("Password (not echoed to history): ");
    if (!isPasswordLengthValid(normalizePassword(password))) {
      fail("That password does not meet the length policy. Nothing was written.");
    }

    const organizationName = (await rl.question("Organization name: ")).trim();
    if (organizationName.length === 0) fail("An organization name is required.");

    await mongoose.connect(env.MONGODB_URI);

    /*
      Refuse rather than overwrite. Silently resetting the password of an
      existing account would make this script a way to take one over, and
      "it already exists" is information the operator needs anyway.
    */
    if (await UserModel.exists({ email })) {
      fail(`An account already exists for ${email}. Nothing was changed.`);
    }

    /*
      The same slug rules the real onboarding service applies. Reproduced
      rather than reused because that service takes an authenticated actor
      and there is no request here — but the VALIDATORS are imported, so a
      name this script accepts is one the application would accept too.
    */
    const slug = slugifyOrganizationName(organizationName);
    if (!isWellFormedSlug(slug) || isReservedSlug(slug)) {
      fail(`"${organizationName}" does not produce a usable slug. Try a plainer name.`);
    }
    if (await OrganizationModel.exists({ slug })) {
      fail(`An organization already uses the slug "${slug}". Choose a different name.`);
    }

    const user = await UserModel.create({
      name,
      email,
      passwordHash: await hashPassword(password),
      // The whole point of the script: skip the inbox round trip.
      emailVerifiedAt: new Date(),
      status: "active",
    });

    const organization = await OrganizationModel.create({
      name: organizationName,
      slug,
      allowedOrigins: [],
    });

    await MembershipModel.create({
      userId: user._id,
      organizationId: organization._id,
      role: ROLE,
      status: "active",
      invitedByUserId: null,
    });

    /*
      Written to stdout rather than through the logger, and without the
      password. This is a report to the person who just typed it, not an
      application event — and the one value they already know is the one
      that must never be persisted anywhere.
    */
    process.stdout.write(
      [
        "",
        "Created and ready to sign in:",
        `  email        ${user.email}`,
        `  organization ${organization.name}  (/${organization.slug})`,
        `  role         ${ROLE}`,
        "",
        `Sign in at ${env.CLIENT_URL}/login`,
        "",
      ].join("\n"),
    );
  } finally {
    rl.close();
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "create:admin failed");
  process.exit(1);
});
