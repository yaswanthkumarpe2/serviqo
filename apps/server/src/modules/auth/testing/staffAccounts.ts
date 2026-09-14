import { hashPassword } from "../../../lib/crypto/password";
import { UserModel } from "../../users/user.model";
import { buildVerificationUrl, issueVerificationCode } from "../emailVerification";

import type { EmailProvider } from "../../../lib/email/emailProvider";
import type { UserKind } from "../../users/user.model";

/**
 * Creates a staff account for a test, in the state public registration used
 * to leave one in (ADR-037).
 *
 * `POST /auth/register` no longer exists: customers never hold accounts, and
 * staff exist only because somebody invited them. Most suites never cared how
 * an account came to be — they needed a person who could verify and sign in —
 * so this reproduces exactly that state, and nothing else:
 *
 *   - an UNVERIFIED account with the given password,
 *   - one outstanding verification code,
 *   - that code handed to the provider, so a fake captures it where the old
 *     registration mail put it.
 *
 * Deliberately NOT exported from any production module. It is a fixture: an
 * account created without an invitation is precisely the thing the product no
 * longer allows, and keeping this under `testing/` is what keeps that true.
 */

export interface CreatedStaffAccount {
  id: string;
  name: string;
  email: string;
}

export interface CreateStaffAccountInput {
  name: string;
  email: string;
  password: string;
  kind?: UserKind;
}

export async function createStaffAccount(
  emailProvider: EmailProvider,
  { name, email, password, kind = "agent" }: CreateStaffAccountInput,
): Promise<CreatedStaffAccount> {
  const user = await UserModel.create({ name, email, passwordHash: await hashPassword(password), kind });

  const code = await issueVerificationCode(user._id);
  await emailProvider.sendVerification({
    to: user.email,
    code,
    verificationUrl: buildVerificationUrl(user.email),
  });

  return { id: user._id.toString(), name: user.name, email: user.email };
}
