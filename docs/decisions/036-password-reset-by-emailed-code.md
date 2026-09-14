# ADR-036: Password Reset by Emailed Code

**Status:** Accepted
**Date:** 2026-09-14
**Phase:** 2 (Authentication)
**Amends:** [ADR-005](./005-account-action-token-lifecycle.md), which anticipated password reset as a LINK with an hour-long secret (`PASSWORD_RESET_TOKEN_TTL_MS`, now removed)
**Related:** [ADR-007](./007-registration-flow-and-account-enumeration.md) §4 (account enumeration); [ADR-008](./008-resend-verification-and-silent-responses.md) §1 (silent 204s); [ADR-009](./009-email-verification-consumption.md) §1 (one refusal for every failure); [ADR-011](./011-login-and-session-issuance.md) §7 (lockout); [ADR-030](./030-email-verification-codes.md) §3–6 (six-digit codes, their lifetime and attempt limit); [ADR-031](./031-credential-rate-limit-classes.md) (one class per unauthenticated endpoint); [ADR-032](./032-platform-admin-and-operations-console.md) §11 (platform role granted only from the database); [ADR-034](./034-customer-accounts-and-agent-invitations.md) §7–8 (agents' temporary passwords, change-password); [ADR-035](./035-session-durability-admin-separation-and-owned-mail.md) §4 (admins are a third kind)

## Context

Nobody who forgot a password could get back in. That was tolerable while every
account was an operator testing the product; it stopped being tolerable with
ADR-034, which emails every new agent a generated password that exists nowhere
else. An agent who loses that mail, or who changed the password and then forgot
it, had exactly one recovery: ask an admin to invite them again, which fails,
because the address is already taken.

The pieces were half-built. `AccountToken` has had a `password_reset` purpose
since ADR-005, `EmailProvider.sendPasswordReset` existed with a link-shaped
input, and the sign-in page carried a "Forgot password?" button that did
nothing. None of it was reachable.

A leaked credential made this concrete too. The admin password printed by
`reset:platform` ended up in a chat transcript, and the only way to rotate it
was the same script, which deletes everything else.

## Decisions

### 1. A code, not a link

ADR-005 imagined a link carrying a 256-bit secret. This ADR uses ADR-030's
six-digit code instead, for ADR-030's reasons, which apply here without change:

- A person reads a code on one device and types it on another. A link only
  works in the browser that opened the mail.
- The URL in the mail holds only the address, for prefill, so it is harmless
  in a referrer header, a browser history, or a screenshot.
- Verification already uses codes, so the form, the input, the client
  validation, and the server's consumption and attempt counting all exist and
  are tested. A second credential format would mean a second set of them.

The code travels in the body of the mail and never in the subject, which a
locked phone shows. Every provider's template follows that rule, and the
console provider logs `codeIssued: true` instead of the code.

### 2. Its lifetime and its guesses

`PASSWORD_RESET_CODE_TTL_MS` is ten minutes and `PASSWORD_RESET_MAX_ATTEMPTS` is
five, the same values verification uses. They are separate constants rather
than aliases: the values match because the same person reads the same inbox, but
changing one should never silently change the other.

The attempt counter is the real guessing defence. On the fifth wrong guess the
code is consumed, so a correct sixth guess finds nothing. The consumption and
the counting are the repository's existing atomic operations (ADR-030 §4–5),
with `purpose: "password_reset"` in every predicate, so a verification code can
never be redeemed as a reset code.

### 3. Two endpoints, and what each is allowed to say

```
POST /api/v1/auth/forgot-password   { email }                     → 204
POST /api/v1/auth/reset-password    { email, code, newPassword }  → 204 | 400
```

**`forgot-password` always answers 204.** It gives the same answer for an
unknown address, a disabled account, the platform admin, a failed write and a
failed delivery. Its service returns nothing on every branch, so the controller
has no state it could leak (ADR-008 §1). The web page can therefore only say
"if that address has an account".

**`reset-password` has one refusal:** `400 INVALID_PASSWORD_RESET_CODE`, used for
wrong digits, an expired code, a spent code, a code destroyed by guessing, an
unknown address, and an account no longer eligible. It gets its own error code
rather than reusing `INVALID_VERIFICATION_TOKEN`, because the client words the
two forms differently.

As with verification, response timing still differs between an address that has
an account and one that does not (ADR-008 records the same residual). The
`passwordResetRequest` limiter bounds how fast that can be sampled.

### 4. What a redeemed code does, and in what order

1. **The code is consumed first**, before anything about the new password is
   examined. Any check that runs before consumption can be probed without a
   code. The obvious candidate, "you cannot reuse your current password", would
   let anyone who knows an address test guesses at that account's password with
   no code at all. So there is **no reuse check** on reset, even though
   change-password has one.
2. **Eligibility is re-checked** after consumption. A code is only issued to an
   eligible account, but the account could be disabled or made platform admin
   during the ten minutes the code lives.
3. **The password is replaced and the lockout is cleared in the same write.** A
   reset exists for the person who is locked out; a password that changed while
   the lock stayed would look to them like a failed reset.
4. **An unverified address becomes verified.** Redeeming the code proves control
   of the inbox, which is all verification proves. This is also the recovery for
   an agent who lost their invitation, and for the real owner of an address that
   someone else registered first. An existing verification timestamp is left
   alone.
5. **Every session is revoked.** People reset a password because they forgot it
   or because they think someone else has it. In the second case, the other
   person's session is exactly what has to end. Change-password keeps the
   caller's own session (ADR-034 §8); here the caller has none.
6. **Outstanding reset and verification codes are removed**, best effort.

**No session is issued.** The response is a bare 204 and the person signs in
with the new password. Sessions are created only at `/login`, and keeping reset
and sign-in as separate steps preserves that.

**Password length is checked in the schema**, which is the opposite of
change-password. That is safe here because the length policy is already public
(registration states it) and the check depends only on the submitted string.
It is also necessary: a check made after consumption would burn the code of
someone who typed a nine-character password.

### 5. Two more rate-limit classes

Following ADR-031, each unauthenticated endpoint gets its own budget:

| class | endpoint | limit | shaped like |
| --- | --- | --- | --- |
| `passwordResetRequest` | `POST /forgot-password` | 3 / 15 min / IP | `verificationResend` — it sends mail to an address the caller names |
| `passwordReset` | `POST /reset-password` | 20 / 15 min / IP | `emailVerification` — an outer guessing bound; the attempt counter is the inner one |

They are kept separate from the verification classes so that waiting on one
kind of mail never spends the budget for the other, and so the log can say which
mail sender is under pressure.

### 6. The platform admin cannot be reset by email

`forgot-password` sends nothing for an account with `platformRole: "admin"` or
`kind: "admin"`, and answers exactly as it would for an unknown address.

The admin account owns the organization and can read platform-wide counts.
Letting its password be reset through its inbox would make compromising one
Gmail account equivalent to compromising the deployment. The platform role can
only be granted by someone holding the database credentials (ADR-032 §11), and
recovering the account should require the same.

That recovery is a new script:

```
npm run reset:password --workspace=apps/server -- someone@example.com
```

It generates a password (144 random bits), replaces the hash, lifts any lockout,
revokes every session, and prints the password once. It refuses
`NODE_ENV=production`, like the other scripts. It does not verify an unverified
address, because database access says nothing about who reads the inbox.

It is also the answer to the leaked-credential problem in the Context: an
operator can now rotate one account's password without `reset:platform`.

The web side matches. The customer and agent sign-in pages link to
`/forgot-password`; the admin sign-in page does not, because a link leading to a
silent no-op would be worse than no link.

### 7. The web flow

- `/forgot-password` takes an address, then always moves on to
  `/reset-password?email=…&sent=1`. It moves on whatever the server found,
  because the server says nothing.
- `/reset-password` takes the address (editable), the code, and a new password.
  It has a "Send a new code" action, and on success goes to the sign-in page
  with `?reset=1`, which shows a confirmation.
- Both routes are **ungated**, like `/verify-email`. The reset page is opened
  from an email, often on another device, and someone who suspects a leak may
  well be signed in when they decide to reset.
- The door is carried as `?from=agent`, not inferred. The reset endpoints say
  nothing about the account, so the page cannot ask whether an address belongs
  to an agent. Any other value means the customer door, which routes an agent
  onward anyway.

## Consequences

- Customers and agents can recover their accounts themselves. An agent who lost
  their invitation mail no longer needs a second invitation, which could not
  have worked anyway.
- Every credential emailed by the account flows is now a code. The link-shaped
  consumption path (`consumeValidByHashAndPurpose`) has no production caller; it
  stays for the first flow that genuinely needs a clickable link.
- The platform admin cannot recover by email, by design. Losing that password
  now costs one script run instead of a database wipe.
- A reset signs someone out everywhere. That is the intent, but it is also a
  nuisance lever for anyone who controls the inbox, and anyone who controls the
  inbox can already do much worse.
- No reuse check on reset. Someone can "reset" to the password they already had,
  which changes nothing except ending their sessions, and that is what they asked
  for.
