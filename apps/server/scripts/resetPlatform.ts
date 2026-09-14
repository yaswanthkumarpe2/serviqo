import { randomBytes } from "node:crypto";

import mongoose from "mongoose";

import { hashPassword } from "../src/lib/crypto/password";
import { env } from "../src/lib/env";
import { logger } from "../src/lib/logger";
import { AccountTokenModel } from "../src/modules/accountTokens/accountToken.model";
import { ConversationModel } from "../src/modules/conversations/conversation.model";
import { CustomerModel } from "../src/modules/customers/customer.model";
import { MembershipModel } from "../src/modules/memberships/membership.model";
import { MessageModel } from "../src/modules/messages/message.model";
import { OrganizationModel } from "../src/modules/organizations/organization.model";
import { isReservedSlug, isWellFormedSlug, slugifyOrganizationName } from "../src/modules/organizations/organizationSlug";
import { SessionModel } from "../src/modules/sessions/session.model";
import { UserModel, normalizeEmail } from "../src/modules/users/user.model";

/**
 * Empties the deployment and seeds one admin and one organization
 * (ADR-034 §12).
 *
 * DESTRUCTIVE AND IRREVERSIBLE. It deletes every user, session, account token,
 * membership, customer, conversation and message, then writes the two documents
 * a working deployment needs: an organization for customers to talk to, and a
 * platform admin who can add agents to it.
 *
 * For starting over on a development database whose contents were all test
 * data. It is not a migration, not a cleanup, and not something to reach for
 * twice — everything it removes is gone.
 *
 * Three guards, in order of how much they save you:
 *
 *   1. It refuses `NODE_ENV=production` outright.
 *   2. It requires `--yes-delete-everything`, spelled out, because a flag you
 *      have to type deliberately is not one you pass by accident.
 *   3. It prints what it is about to delete, with counts, before doing it.
 *
 *   npm run reset:platform --workspace=apps/server -- --yes-delete-everything
 *   npm run reset:platform --workspace=apps/server -- --yes-delete-everything --email you@example.com
 */

const CONFIRM_FLAG = "--yes-delete-everything";

/** 18 bytes is 144 bits, rendered base64url — pasteable, and not guessable. */
const PASSWORD_BYTES = 18;

const DEFAULT_ORGANIZATION_NAME = "Serviqo Support";

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

/** Reads `--flag value` out of argv without pulling in an argument parser. */
function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    fail(
      "reset:platform refuses to run with NODE_ENV=production. It deletes every account and every conversation; there is no version of that which belongs on a live database.",
    );
  }

  if (!process.argv.includes(CONFIRM_FLAG)) {
    fail(
      [
        "Refusing to run without confirmation.",
        "",
        "This DELETES every user, organization, membership, session, customer,",
        "conversation and message in the database, and cannot be undone.",
        "",
        `Re-run with ${CONFIRM_FLAG} if that is what you want.`,
      ].join("\n"),
    );
  }

  const email = normalizeEmail(argValue("--email") ?? "admin@serviqo.local");
  const name = argValue("--name") ?? "Serviqo Admin";
  const organizationName = argValue("--organization") ?? DEFAULT_ORGANIZATION_NAME;

  const slug = slugifyOrganizationName(organizationName);
  if (!isWellFormedSlug(slug) || isReservedSlug(slug)) {
    fail(`"${organizationName}" does not produce a usable slug. Choose a plainer name.`);
  }

  await mongoose.connect(env.MONGODB_URI);

  try {
    /*
      Counted and shown BEFORE anything is removed. An operator who is about to
      lose data should see its size first — "deleting 4 users" and "deleting
      40,000 users" are different decisions, and the second one is the moment
      to press Ctrl-C.
    */
    const models = [
      ["users", UserModel],
      ["organizations", OrganizationModel],
      ["memberships", MembershipModel],
      ["sessions", SessionModel],
      ["account tokens", AccountTokenModel],
      ["customers", CustomerModel],
      ["conversations", ConversationModel],
      ["messages", MessageModel],
    ] as const;

    process.stdout.write("\nDeleting:\n");
    for (const [label, model] of models) {
      process.stdout.write(`  ${String(await model.countDocuments({})).padStart(6)}  ${label}\n`);
    }

    for (const [, model] of models) {
      await model.deleteMany({});
    }

    const password = randomBytes(PASSWORD_BYTES).toString("base64url");

    const organization = await OrganizationModel.create({
      name: organizationName,
      slug,
      // Empty means CLOSED — no website may embed the widget until somebody
      // adds an origin (ADR-019 §10). The safe default, not an oversight.
      allowedOrigins: [],
    });

    const admin = await UserModel.create({
      name,
      email,
      passwordHash: await hashPassword(password),
      /*
        Verified on creation, for the reason `create:admin` states: the point of
        verification is proving control of an inbox, and an operator with the
        database credentials has already demonstrated far more authority than an
        inbox confers.
      */
      emailVerifiedAt: new Date(),
      status: "active",
      platformRole: "admin",
      /*
        Neither a customer nor an agent (ADR-035 §4).

        An admin operates the deployment; they are not one of the tenant's
        customers and not one of its agents, and holding either kind would give
        them a second surface they have no business on — an admin answering
        conversations from the agent workspace makes "who is staff here" a
        question with two answers.

        They still OWN the organization below, which is a membership role and a
        different axis entirely. What they lose by not being an agent — the
        roster, the conversations — the console carries instead (ADR-035 §5).
      */
      kind: "admin",
    });

    await MembershipModel.create({
      userId: admin._id,
      organizationId: organization._id,
      role: "owner",
      status: "active",
      invitedByUserId: null,
    });

    /*
      Written to stdout rather than through the logger, and this is the ONLY
      time this password exists anywhere. Nothing stores it — only its Argon2id
      hash — so an operator who loses this output runs the script again.
    */
    process.stdout.write(
      [
        "",
        "Done. The database now holds one organization and one admin.",
        "",
        "  organization   " + organization.name + "  (/" + organization.slug + ")",
        "  email          " + admin.email,
        "  password       " + password,
        "",
        "  Admin console  " + env.CLIENT_URL + "/control   (unlisted — nothing links to it)",
        "  Staff sign-in  " + env.CLIENT_URL + "/login",
        "  Customers      no account — they chat through the organisation's widget",
        "",
        "This password is shown once and is not recoverable. Save it now.",
        "Add agents from the admin console; they are emailed their own password.",
        "",
      ].join("\n"),
    );
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "reset:platform failed");
  process.exit(1);
});
