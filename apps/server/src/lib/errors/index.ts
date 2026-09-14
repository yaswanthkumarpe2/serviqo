export { AppError } from "./AppError";

import { AppError } from "./AppError";

/**
 * Only the error classes an existing slice actually throws live here.
 * AuthenticationError, AuthorizationError, TenantIsolationError, etc. get
 * added in the slices that throw them.
 */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

/**
 * One rejected field. `field` is the dotted path into the request body
 * (`"email"`, `"profile.name"`, `"members.0.role"`).
 *
 * There is deliberately no `value`/`received` member: the rejected input is
 * routinely the thing that must not be echoed — a password that failed the
 * length rule, an address typed into the wrong box — and a response body
 * ends up in client logs, error trackers, and browser history (ADR-007 §7).
 */
export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Malformed request input, rejected at the HTTP boundary before any handler
 * runs (see middleware/validate.ts). Business rules that need database state
 * — email already taken, token expired — are NOT validation failures and get
 * their own error classes.
 */
export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = "VALIDATION_ERROR";
  readonly details: ValidationIssue[];

  constructor(message: string, details: ValidationIssue[] = []) {
    super(message);
    this.details = details;
  }
}

/**
 * Registration was attempted with an address that already has an account.
 *
 * Serviqo answers this specifically rather than generically, accepting that
 * it discloses whether an address is registered — see ADR-007 §1 for why,
 * and for why login and forgot-password must stay generic.
 */
export class EmailAlreadyExistsError extends AppError {
  readonly httpStatus = 409;
  readonly code = "EMAIL_ALREADY_EXISTS";
}

/**
 * Authentication failed — and deliberately does not say how (ADR-011 §3).
 *
 * Unknown address, wrong password, locked account, and disabled account all
 * raise this same error with the same message. Naming the reason would tell
 * an unauthenticated caller whether an address has an account, which is
 * exactly what ADR-007 §1 committed login to withholding.
 */
export class InvalidCredentialsError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_CREDENTIALS";
}

/**
 * The credentials were correct but the address has never been verified
 * (ADR-011 §6).
 *
 * This is the one authentication refusal that is not generic, and it is safe
 * because it is unreachable without a correct password — so it discloses
 * nothing the caller did not already know. It is named specifically because
 * it is the only refusal with a self-service remedy
 * (`POST /auth/resend-verification`), and a caller cannot be expected to
 * guess that.
 */
export class EmailNotVerifiedError extends AppError {
  readonly httpStatus = 403;
  readonly code = "EMAIL_NOT_VERIFIED";
}

/**
 * A verification token could not be redeemed — and deliberately does not say
 * why (ADR-009 §1).
 *
 * Invalid, expired, already consumed, fabricated, and belonging-to-a-deleted-
 * user all raise this same error with the same message. "Expired" would
 * confirm the token was once real, and "already consumed" would confirm the
 * address is verified; either turns a link into an account-existence probe
 * for whoever holds it.
 */
export class InvalidVerificationTokenError extends AppError {
  readonly httpStatus = 400;
  readonly code = "INVALID_VERIFICATION_TOKEN";
}

/**
 * A password-reset code could not be redeemed — and deliberately does not say
 * why (ADR-036 §3).
 *
 * Wrong digits, an expired code, a spent one, a code destroyed by too many
 * guesses, an address with no account, and an account that may not be reset
 * this way all raise this one error with one message. Each distinction would
 * answer a question an unauthenticated caller must not get answered: whether
 * the address has an account, and whether somebody recently asked to reset it.
 *
 * Its own error rather than `InvalidVerificationTokenError`, because the
 * client needs to tell the two forms' failures apart to word them, and a code
 * named for verification appearing on a password form is a diagnosis waiting
 * to mislead somebody.
 */
export class InvalidPasswordResetCodeError extends AppError {
  readonly httpStatus = 400;
  readonly code = "INVALID_PASSWORD_RESET_CODE";
}

/**
 * A refresh token could not be exchanged — and deliberately does not say why
 * (ADR-012 §3).
 *
 * Absent cookie, malformed token, unknown session, expired session, revoked
 * session, unknown secret, replayed secret, a concurrent rotation that lost,
 * and an account no longer entitled to refresh all raise this one error with
 * one message.
 *
 * The distinctions matter most where they are least safe to make: "this
 * session was revoked" would confirm a real session exists at that id, and
 * "replayed" would tell whoever stole the token that the theft was noticed.
 * The endpoint has exactly two observable outcomes, and this is the one that
 * is not success.
 */
export class InvalidRefreshTokenError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_REFRESH_TOKEN";
}

/**
 * A request did not present a usable access token — and deliberately does not
 * say which part failed (ADR-015 §6).
 *
 * Absent header, malformed header, wrong scheme, bad signature, expired,
 * wrong issuer, wrong audience, a user who no longer exists, and a disabled
 * account all raise this one error with one message.
 *
 * "Expired" is the tempting exception and is refused with the rest: the
 * legitimate client already knows its own expiry, so the distinction helps
 * only whoever is probing with a token they were not given — to them,
 * "expired" confirms it was once real. "No such user" and "disabled" are
 * withheld for the reason ADR-011 §6 withheld a disabled account from a
 * caller holding its password; confirming it to one holding a token is
 * strictly worse.
 *
 * The first error in this file thrown by middleware rather than a service.
 */
export class InvalidAccessTokenError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_ACCESS_TOKEN";
}

/**
 * The caller has made too many requests for the class of endpoint they are
 * using (ADR-018 §6).
 *
 * One message for every limiter class. It names no limit, no window, no
 * route class, and no remaining budget — those are facts about Serviqo's
 * defences rather than about this caller, the same reasoning that kept the
 * required permission out of ADR-017 §6's 403.
 *
 * It also discloses nothing about accounts. The credential limiter is keyed
 * by IP and never by submitted email (ADR-018 §5), so this response is
 * identical whether the address in the body exists or not.
 *
 * `Retry-After` and `RateLimit` headers accompany it. Those are standards-
 * track, they let an honest client back off instead of hammering, and the
 * window length is not a secret — an attacker learns it by waiting.
 */
export class TooManyRequestsError extends AppError {
  readonly httpStatus = 429;
  readonly code = "TOO_MANY_REQUESTS";
}

/**
 * The caller may not reach this organization — and deliberately does not
 * learn which of several reasons applies (ADR-017 §6).
 *
 * The organization does not exist, is suspended, the caller is not a member,
 * their membership is still `invited`, or it has been `suspended`: one
 * response, one message, one status.
 *
 * A `403` here would confirm the organization exists, turning any
 * authenticated account into an oracle for which tenant ids are real — and,
 * with a guessable slug, for whether a named company uses Serviqo. That is
 * the enumeration reasoning ADR-009 §1, ADR-011 §3, ADR-012 §3 and ADR-015 §6
 * each applied in turn, and a tenant's existence is the kind of fact
 * SECURITY.md §2 keeps inside its own boundary.
 *
 * Contrast `InsufficientPermissionError` below, which answers a caller whose
 * membership is already proved.
 */
export class OrganizationNotAccessibleError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

/**
 * The caller is a member of this organization, and their role does not hold
 * the permission this route requires (ADR-017 §6).
 *
 * Specific, unlike every other refusal in this file, and safely so:
 * `requireOrganization` has already proved membership by the time this can be
 * raised, so the caller demonstrably knows the organization exists and works
 * there. Withholding "your role cannot do this" from them would disclose
 * nothing and only make the product confusing.
 */
export class InsufficientPermissionError extends AppError {
  readonly httpStatus = 403;
  readonly code = "INSUFFICIENT_PERMISSION";
}

/**
 * A widget session could not be opened — and deliberately does not say why
 * (ADR-019 §12).
 *
 * Unknown widget key, suspended organization, an organization that no longer
 * exists, a disallowed `Origin`, and an unparseable one all raise this same
 * error with the same message.
 *
 * Distinguishing "unknown key" from "suspended organization" would confirm to
 * an unauthenticated prober which keys are real, which is tenant enumeration
 * through the front door. "Disallowed origin" is the tempting exception —
 * genuinely useful to a tenant installing the widget on a new domain — and it
 * is withheld with the rest, because it equally confirms the key is valid to
 * anyone who scraped one out of a page. Installation diagnostics belong in
 * the dashboard, where the caller is authenticated and already knows the
 * tenant exists.
 *
 * 403 rather than 404: this endpoint's existence is public by construction,
 * named in every tenant's page source, so answering 404 would be pretending a
 * demonstrably present route is absent — an opacity that buys nothing. Not
 * 401, because there is nothing to authenticate as; a widget key is an
 * identifier, and no `WWW-Authenticate` challenge would mean anything.
 */
export class WidgetSessionRefusedError extends AppError {
  readonly httpStatus = 403;
  readonly code = "WIDGET_SESSION_REFUSED";
}

/**
 * A request did not present a usable widget token — and deliberately does
 * not say which part failed (ADR-022 §6, mirroring ADR-015 §6's reasoning
 * for `InvalidAccessTokenError` exactly).
 *
 * Absent header, malformed header, bad signature, expired, wrong issuer,
 * wrong audience, and malformed claims all raise this one error with one
 * message. "Expired" is withheld for the identical reason ADR-015 §6
 * withholds it from a staff caller: the legitimate client already knows its
 * own expiry, so naming it helps only whoever is probing with a token they
 * were not issued.
 *
 * A verified token whose organization or customer no longer resolves is a
 * DIFFERENT failure and raises `WidgetSessionRefusedError` instead
 * (ADR-022 §6) — this error is reserved for the credential itself being
 * unusable, not for what it names having stopped being valid.
 */
export class InvalidWidgetTokenError extends AppError {
  readonly httpStatus = 401;
  readonly code = "INVALID_WIDGET_TOKEN";
}

/**
 * A conversation could not be reached — and deliberately does not say
 * whether it does not exist or belongs to someone else (ADR-022 §8).
 *
 * No conversation at that id, a conversation under a different
 * organization, and a conversation under the right organization but a
 * different customer all raise this same error with the same message and
 * status. Mirrors `OrganizationNotAccessibleError` exactly, for the
 * identical enumeration-resistance reason: a `403` would confirm the id
 * names a real conversation, which is tenant/customer enumeration through
 * an ObjectId guess.
 */
export class ConversationNotAccessibleError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

/**
 * A message was sent into a conversation that has been closed (ADR-026 §6).
 *
 * Raised for BOTH senders — a customer over the widget and an agent over the
 * inbox — from the same check in the same service, so "closed" cannot come to
 * mean two different things depending on who asked.
 *
 * Answered SPECIFICALLY rather than folded into
 * `ConversationNotAccessibleError`'s opaque 404, and safely so: both callers
 * have already proved they may reach this conversation — the customer holds a
 * token naming it and owns it, the agent holds a membership in its tenant —
 * so naming the reason discloses nothing about existence or ownership.
 *
 * The deciding test is the one ADR-011 §6 applied when it made
 * `EmailNotVerifiedError` the single non-generic authentication refusal: this
 * failure has a REMEDY, and the remedy differs from the one a 404 implies. A
 * caller who cannot tell "closed" from "gone" cannot recover; the widget
 * recovers by resolving a new conversation (ADR-026 §8), and an agent
 * recovers by reopening this one.
 */
export class ConversationClosedError extends AppError {
  readonly httpStatus = 409;
  readonly code = "CONVERSATION_CLOSED";
}

/**
 * A claim or release was refused because another agent holds the
 * conversation (ADR-026 §4).
 *
 * Specific for the reason `InsufficientPermissionError` is specific
 * (ADR-017 §6): by the time this can be raised, membership in the tenant is
 * proved and the conversation is proved to be inside it, so "someone else has
 * this one" discloses nothing the caller did not already have access to.
 *
 * It names NO user. Who that someone is depends on the caller's own
 * entitlement to the staff roster (ADR-026 §11), and a refusal is the wrong
 * place to make a disclosure decision that a response projection makes
 * carefully everywhere else.
 */
export class ConversationAlreadyAssignedError extends AppError {
  readonly httpStatus = 409;
  readonly code = "CONVERSATION_ALREADY_ASSIGNED";
}

/**
 * A conversation could not be reopened because its customer already has a
 * newer open one (ADR-026 §7).
 *
 * This is ADR-022 §3's partial unique index refusing the write, translated
 * rather than absorbed. Absorbing it would mean either closing the newer
 * conversation to make room — destroying a thread the customer is actively
 * using — or dropping the index, which is the invariant ADR-022 chose the
 * database to enforce precisely so application code could not get it wrong.
 *
 * The only message in this slice that tells the caller what to do next, and
 * deliberately so: "go to the newer conversation" is not guessable from the
 * word "conflict", and the fact it discloses is one the caller's own inbox
 * list already shows them.
 */
export class ConversationReopenConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = "CONVERSATION_REOPEN_CONFLICT";
}

/**
 * Every slug derived from a submitted organization name was already taken or
 * reserved, within the bounded number of attempts onboarding will make
 * (ADR-016 §7).
 *
 * Effectively unreachable — it needs many organizations whose names slugify
 * identically — and named specifically anyway, because the alternative is an
 * unbounded retry against a contended name, which is a request that never
 * returns. A caller resolves it by choosing a different name.
 *
 * Not an enumeration concern: slugs are public URL segments by construction,
 * and this endpoint is authenticated besides (ADR-016 §8).
 */
export class OrganizationSlugUnavailableError extends AppError {
  readonly httpStatus = 409;
  readonly code = "ORGANIZATION_SLUG_UNAVAILABLE";
}

/**
 * A membership could not be reached — and deliberately does not say why
 * (ADR-027 §9, mirroring ADR-025 §10's reasoning for conversations exactly).
 *
 * No such membership, a membership belonging to another organization, and a
 * well-formed id belonging to nothing all raise this one error with one
 * message. That indistinguishability is not produced here: every membership
 * lookup in the team-management surface takes `{ _id, organizationId }` as a
 * pair, so a row outside the caller's tenant is never located rather than
 * being located and refused.
 *
 * 404 rather than 403, because answering "that membership exists, elsewhere"
 * would confirm the existence of another tenant's row to someone with no
 * standing in it.
 */
export class MemberNotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";
}

/**
 * The person named by a member request already has a membership in this
 * organization — in any status (ADR-027 §8).
 *
 * Answered SPECIFICALLY, unlike most refusals in this codebase, and safely
 * so: `member.manage` is strictly wider than `member.read` in
 * `ROLE_PERMISSIONS`, so a caller who can reach the route that raises this can
 * already fetch the roster it describes. It discloses nothing
 * `GET …/members` would not.
 *
 * Raised for `suspended` and `invited` memberships as well as `active` ones.
 * Re-adding a suspended person would be a reinstatement dressed as an add,
 * and if that is the intent it should be a request that says so.
 */
export class MemberAlreadyExistsError extends AppError {
  readonly httpStatus = 409;
  readonly code = "MEMBER_ALREADY_EXISTS";
}

/**
 * The email a member request named cannot be added (ADR-027 §5).
 *
 * ONE error for "no Serviqo account with that email", "an account that is not
 * active", and "an account whose email is not verified" — the same three-part
 * gate `currentUser.service.ts` and `organizationOnboarding.service.ts` apply
 * to the caller, applied here to the target.
 *
 * ADR-027 §5 records openly that this is distinguishable from success and is
 * therefore an account-existence oracle, why it is accepted rather than
 * papered over with a silent 201, and what bounds it: `member.manage`, a
 * verified acting account, and a dedicated 20/hour rate limit class. The
 * submitted email never reaches a log line.
 *
 * 422 rather than 404: the request is well-formed and the route and tenant
 * both exist — what cannot be processed is the instruction. 404 is already
 * what an unreachable membership answers, and one code meaning two unrelated
 * things is a code no client can branch on.
 */
export class MemberNotInvitableError extends AppError {
  readonly httpStatus = 422;
  readonly code = "MEMBER_NOT_INVITABLE";
}

/**
 * An operation was refused because it would have left the organization
 * without a valid owner (ADR-027 §7a).
 *
 * Raised by a role change or a removal aimed at the owner membership.
 * `organizationOnboarding.service.ts` made an unowned tenant impossible to
 * CREATE by writing the owner membership before the organization; nothing
 * could PRODUCE one until memberships gained a lifecycle, and this is what
 * keeps that true.
 *
 * ADR-016 §3 already recorded why the state is unrecoverable rather than
 * merely untidy: an ownerless organization holds its unique slug forever with
 * nobody able to administer it, and no adoption path exists or is planned,
 * because "let an authenticated user claim an ownerless organization" is an
 * account-takeover primitive.
 *
 * Named specifically because the caller can act on it — the resolution is
 * ownership transfer, which ADR-027 §7 declines to approximate with two
 * sequential writes in a database deliberately run without transactions.
 */
export class OrganizationOwnerProtectedError extends AppError {
  readonly httpStatus = 409;
  readonly code = "ORGANIZATION_OWNER_PROTECTED";
}

/**
 * A membership status change asked for a transition that does not exist
 * (ADR-029 §6).
 *
 * ONE error for every non-transition: suspending an already-suspended member,
 * reactivating an already-active one, and touching an `invited` membership in
 * either direction.
 *
 * A NO-OP IS REFUSED RATHER THAN ABSORBED, which is the debatable half and is
 * chosen deliberately. `PATCH` invites an idempotent reading, and
 * `conversationRepository.setStatus` takes exactly the opposite position for
 * conversations — "both transitions are idempotent, so there is no 'only if
 * currently open' precondition to express." The difference is what the field
 * means: a conversation's status is a workflow label, and a membership's
 * status is an ACCESS-CONTROL DECISION. Two managers working one roster, or
 * one manager on a stale page, are precisely the situations where answering
 * `200` would report a revocation that had already happened — or had not.
 *
 * `invited` shares this refusal rather than getting its own, because a manager
 * cannot resolve it in either direction: they can neither accept an invitation
 * on someone's behalf nor suspend access that was never granted (ADR-027 §3).
 *
 * Answered SPECIFICALLY, and safely so for ADR-027 §8's reason: `member.manage`
 * is strictly wider than `member.read` in the catalogue, so a caller who can
 * reach this route can already fetch the roster that shows every status this
 * message describes. It discloses nothing `GET …/members` would not.
 */
export class MemberStatusTransitionError extends AppError {
  readonly httpStatus = 409;
  readonly code = "MEMBER_STATUS_TRANSITION_INVALID";
}

/**
 * An ownership transfer named the acting owner's own membership
 * (ADR-028 §6.2).
 *
 * "Transfer to yourself" and "transfer to someone who is already the owner"
 * are the SAME condition rather than two: index B allows at most one owner per
 * organization, and `organization.transfer_ownership` is held only by `owner`,
 * so the one membership in this tenant whose role is `owner` is necessarily
 * the caller's own. One check covers both, and the message says the half the
 * caller can act on.
 *
 * Distinct from `MemberSelfModificationError` above, which ADR-027 §7b wrote
 * for a different question — "you may not change or remove your own
 * membership", whose remedy is "ask someone else". Here the caller is entitled
 * to act on their own membership; they simply chose the wrong recipient, and
 * the remedy is "choose a different member". One code covering both would be a
 * code no client could branch on.
 *
 * Answered specifically, and safely so for ADR-027 §8's reason applied one
 * step further: this permission is held only by `owner`, who also holds
 * `member.read`, so the caller can already fetch the roster that shows who the
 * owner is. It discloses nothing `GET …/members` would not.
 */
export class OwnershipTransferSelfTargetError extends AppError {
  readonly httpStatus = 409;
  readonly code = "OWNERSHIP_TRANSFER_SELF_TARGET";
}

/**
 * The member named by an ownership transfer cannot receive it (ADR-028 §6.3,
 * §6.4).
 *
 * ONE error for "the membership is not `active`" and for "the `User` behind it
 * does not exist, is not `active`, or has never verified its email" — the same
 * three-part gate `currentUser.service.ts`, `refresh.service.ts`,
 * `organizationOnboarding.service.ts` and `member.service.ts` each apply,
 * applied here to the recipient of a tenant.
 *
 * Collapsed into one refusal on purpose. Both mean "that person cannot receive
 * this", both have the same remedy — pick someone else, or fix their account
 * first — and separating them would let a caller distinguish "membership
 * suspended" from "account suspended" for no benefit they can act on.
 *
 * The check matters because handing a tenant to someone who cannot sign into
 * it manufactures an organization that is unowned in practice, which is the
 * state ADR-028 §8 exists to prevent, one step removed.
 *
 * 409 rather than 422: the instruction is processable and the target is real
 * and reachable — what is wrong is the target's current state, which is a
 * conflict with the request rather than an unprocessable entity.
 */
export class OwnershipTransferTargetInvalidError extends AppError {
  readonly httpStatus = 409;
  readonly code = "OWNERSHIP_TRANSFER_TARGET_INVALID";
}

/**
 * Ownership moved while this transfer was in flight (ADR-028 §8b, §9).
 *
 * Raised when the guarded demote matches no document — the caller was the
 * owner when `requireOrganization` read the membership and is not the owner by
 * the time the write runs — and when the guarded promote matches none, after
 * the demote has been compensated.
 *
 * This is the visible half of the concurrency design. Two simultaneous
 * transfers both attempt to demote the same single owner document; MongoDB's
 * per-document atomicity means exactly one matches, and the loser writes
 * nothing, never reaches the promotion, and answers this. That is what makes
 * "one transfer wins" a property of the database rather than of a comparison
 * that races.
 *
 * Names no user and no membership. Which request won is not this caller's
 * business, and a refusal is the wrong place to make a disclosure decision the
 * roster projection makes carefully elsewhere.
 *
 * Its message is one of the few that says what to do next, for the reason
 * `ConversationReopenConflictError`'s does: "reload and look again" is not
 * guessable from the word "conflict", and the state to reload is one the
 * caller's own team page already shows them.
 */
export class OwnershipTransferConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = "OWNERSHIP_TRANSFER_CONFLICT";
}

/**
 * A caller aimed a member operation at their own membership (ADR-027 §7b).
 *
 * Compared against `req.principal.userId` — the verified subject of the
 * access token — never against anything the request carried.
 *
 * Covers the owner, who §7a already protects, and the case §7a cannot see: an
 * admin demoting themselves out of `member.manage` in the same request, or
 * removing themselves, leaving a tenant whose only remaining manager may not
 * be reachable. Leaving an organization voluntarily is a different operation
 * with a different name, and it is not in this slice.
 */
export class MemberSelfModificationError extends AppError {
  readonly httpStatus = 409;
  readonly code = "MEMBER_SELF_MODIFICATION";
}
