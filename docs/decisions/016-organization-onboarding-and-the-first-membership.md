# ADR-016: Organization Onboarding and the First Membership

**Status:** Accepted
**Date:** 2026-08-17
**Phase:** 2 (Organization onboarding slice)
**Closes:** [ADR-015](./015-access-token-verification-and-current-user.md) §9's prerequisite — the reason `/me` carries no organization
**Implements:** [ADR-002](./002-phase-2-authentication-architecture.md) §3 (Membership is the single source of ownership truth)
**Related:** [ADR-003](./003-domain-first-server-modules.md) (module layout), [ADR-004](./004-refresh-token-rotation-and-reuse-detection.md) §8 (per-request organization resolution), [ADR-010](./010-principal-types-organization-users-and-customers.md) (principal types), [ADR-007](./007-registration-flow-and-account-enumeration.md) §13 (the deployment gate)

## Context

Sixteen slices in, Serviqo has authenticated staff users and no tenants.
`Organization` and `Membership` have existed as persistence-only models
since Slices 4 and 5 — models, repositories, and their own tests — and
**nothing in the application ever creates either document**. A grep for
every reference to `organizationRepository`, `membershipRepository`,
`OrganizationModel`, and `MembershipModel` returns only those files.

That gap is load-bearing in a way that is easy to miss. `ADR-015` §9
omitted organization and role from `/me` because "nothing creates a
`Membership` yet, so the field would be null for every caller", and
deferred the question here. Everything customer-facing depends on it more
sharply still: a customer contacts *an organization*, a conversation is
routed to *an organization*, and an agent receives it through a
*Membership*. None of that can be built — or honestly verified — against a
database in which no organization can exist.

This slice creates the first tenant. It is deliberately small: one
endpoint, one transaction-shaped operation, and no team management,
invitations, or organization settings.

Two things make it harder than it looks. `Organization` and `Membership`
are two documents that must become real together, and MongoDB gives no
free way to do that here. And the slug is the first user-controlled value
in Serviqo that becomes part of a URL namespace.

## Decisions

### 1. One endpoint, authenticated, and the creator is the owner

`POST /api/v1/organizations`, behind `requireAccessToken`. The request body
carries a name and nothing else. The organization is created and the
calling user becomes its `owner` in the same operation.

Ownership is not a parameter. The body cannot name an owner, and there is
no `ownerUserId` field to send — the owner is `req.principal.userId`,
derived from a signature Serviqo produced (ADR-015 §11). A creation
endpoint that accepted an owner id would let any authenticated user mint a
tenant owned by someone else, which is an account-takeover primitive
dressed as a convenience.

There is no permission check, deliberately. Creating an organization is not
an action *inside* an organization, so there is no tenant to be a member
of and no role to require. It is the one authenticated write in Serviqo
that RBAC cannot govern, because it is what brings the first RBAC subject
into existence. `requireOrganization` and `requirePermission` (ADR-015 §13)
govern everything that comes after.

### 1a. The account is re-checked before anything is written

`requireAccessToken` verifies a token and nothing else (ADR-015 §7: "a valid
signature identifies a user; it does not entitle them"). The service
therefore re-loads the `User` and applies the same three-part gate
`currentUser.service.ts` and `refresh.service.ts` apply — exists, `active`,
verified — deliberately identical so the three cannot drift about who
Serviqo still serves.

Required rather than defensive, for two independent reasons:

**A disabled staff member would otherwise keep creating tenants** for the
remaining life of their access token — up to fifteen minutes (ADR-015 §8).
Creating a tenant is not a read; it is the most consequential write an
authenticated user can perform, and it is the one place that window is worth
closing.

**`membership.model.ts` states the requirement directly.** Its header says
referential integrity is not enforced by the schema, and that "verifying
that the referenced User and Organization exist is the future business/
service layer's job, before it asks persistence to create the
relationship." A membership pointing at a deleted user is precisely the
phantom record ADR-010 §2 warned produces authorization bugs later.

The refusal is the same generic 401, saying nothing about why (ADR-015 §6).

### 2. A user may own more than one organization

No cap, no "you already have an organization" refusal. ADR-010 §3 fixed
that "a person may work for several organizations" and that `User`
deliberately carries no `organizationId`; a one-org-per-user rule would
contradict the model and would have to be undone by the invitations slice
anyway.

The cost is recorded rather than hidden: an authenticated user can create
organizations in a loop. That is a rate-limiting concern, and rate limiting
is the next slice (ADR-007 §13's deployment gate already forbids exposing
this surface publicly until it exists). It is not solved with a business
rule that the product does not actually want.

### 3. Atomicity comes from write ordering, not from a transaction

**This is the central decision of the slice.**

The invariant that matters is:

> An `Organization` must never exist without exactly one `owner`
> `Membership`.

An ownerless organization is unrecoverable in a way that is worth being
precise about. It permanently holds a unique slug; no one can administer
it, because administering it requires a membership nobody can grant; and
there is no code path — none is planned — by which a later request could
adopt it, since "let an authenticated user claim an ownerless
organization" is an account-takeover primitive.

The obvious tool is a multi-document transaction. It is rejected:

**MongoDB transactions require a replica set.** The development database
this project runs against is a standalone `mongod` (`hello.setName` is
absent), and `tests/setup.ts` plus every integration suite use
`MongoMemoryServer`, which is likewise standalone. A transaction-based
implementation would typecheck, would pass under `MongoMemoryReplSet`, and
would then throw `Transaction numbers are only allowed on a replica set
member or mongos` the first time anyone created an organization locally.
Shipping code whose happy path cannot run on the developer's own machine
is worse than shipping code with a documented weaker guarantee. This is the
same reasoning ADR-002 §7–19 applied to Redis: authentication has no Redis
dependency, and onboarding gains no replica-set dependency.

**Instead, the writes are ordered so the harmful partial state is
unreachable:**

1. The `organizationId` is generated in application code — `new
   Types.ObjectId()` — rather than by the database on insert.
2. The **owner `Membership` is written first**, pointing at that id.
3. The **`Organization` is written last**, with that `_id`.

Because the organization is the final write, there is no interleaving in
which it exists and its owner does not. The invariant is structural rather
than enforced, which is the same property ADR-014 §5 preferred when it
made logout-all's scope come "from the query, not from a check".

This is **ordering, not atomicity**, and the difference is real: the
*inverse* partial state — a `Membership` referencing an `Organization` that
does not exist — is reachable, if the process dies between the two writes.
That is accepted because it is inert:

- It grants nothing. Resolving organization access requires loading the
  `Organization`, which returns `null`.
- It burns no slug, so the user retries with the same name and succeeds.
- It occupies one row of a partial unique index for an `_id` that will
  never be issued again.

**Binding on the slice that writes `requireOrganization` (Slice 18):**
organization access must be resolved by loading the `Organization` and
checking it is `active` — never by finding a `Membership` alone. A
membership is a claim about a tenant, not proof the tenant exists. Written
here because this ADR is what makes that distinction possible.

When the `Membership` succeeds and the `Organization` write then fails, the
membership is deleted as a compensating action (§4). The orphan above is
the residue of the case where compensation itself cannot run.

### 4. The compensating delete, and why this path may have one

`registration.service.ts` refused compensating deletion in almost these
words — "Compensating deletion would put a destructive primitive on an
unauthenticated path to undo a recoverable state" (ADR-007 §3). Both
conditions that justified the refusal are inverted here:

| | Registration | Onboarding |
|---|---|---|
| Path | unauthenticated | authenticated |
| Partial state | a `User`, unverified | a `Membership` to a phantom tenant |
| Recoverable? | yes — resend verification | no self-service repair |

`membershipRepository.deleteById` is added for this, and is narrow on
purpose: it deletes one document by `_id`, the document this same request
created microseconds earlier. It is not a general `delete(filter)`, and it
cannot reach a membership the caller did not just create — the same
narrowness rule `userRepository` follows, where `markEmailVerified` and
`clearLoginFailures` exist but `update(id, patch)` deliberately does not.

Compensation is **best-effort and never masks the original error**. If the
delete fails, the failure is logged under its own event and the original
error still propagates, exactly as `login.service.ts` treats a failed
`clearLoginFailures`: the caller's outcome must not change because
bookkeeping did not.

### 5. Slugs are generated from the name; the client cannot choose one

`organization.model.ts` fixed this in advance. Its `normalizeSlug` does
"trim plus lowercase only" and explicitly refuses to turn arbitrary text
into a valid slug, recording that "slug generation from a name is business
logic for the future organization-creation/onboarding service, not this
layer" — including "generating one from a name, resolving collisions with
`-2`/`-3` suffixes". This is that service.

The request body therefore has one field. A client-supplied slug would add
a second identifier to validate, a second way to collide, and a way for a
caller to squat on names — for no benefit this slice needs. Choosing a
custom slug is an organization-settings feature, and settings do not exist.

Generation: NFKD-fold, strip diacritics, lowercase, replace every run of
non-alphanumerics with a single hyphen, trim hyphens, bound the length.
The result is then validated against the schema's own `SLUG_PATTERN`
rather than trusted — a generator and a validator that disagree is a
`ValidationError` at persistence, and the check is one line.

A name that yields nothing usable — `"~~~"`, `"图"` under an
ASCII-only fold — falls back to a generated base rather than failing. The
name is presentation data belonging to its owner (the reasoning
`auth.validation.ts` applies to person names); it should not have to be
ASCII to be a tenant.

### 6. Reserved slugs and taken slugs are the same condition

Reserved-slug enforcement is the other thing `organization.model.ts`
deferred here: "blocking slugs like `api`/`admin`/`login` that might
collide with application routes".

Both are handled by one predicate — a candidate is unavailable if it is
reserved **or** already stored — and unavailability advances to the next
candidate (`acme`, `acme-2`, `acme-3`, …). Treating them identically means
an organization named "Admin" gets `admin-2` rather than an error, which is
the correct outcome: the tenant's name is legitimate, only the URL segment
is spoken for.

The reserved list lives in the organizations module, not
`config/constants.ts`. That file's own ownership rule is that "a value
lives here when more than one layer needs it" — this list is read by one
service and nothing else.

The list covers current and reserved route segments (`api`, `admin`,
`app`, `auth`, `login`, `dashboard`, `widget`, `public`, `health`, …). It
includes `widget` and `public` deliberately: ADR-010 §5 reserved a customer
route namespace, and a tenant that took that slug first would collide with
it.

### 7. Collisions are resolved by the database, not by the probe

Candidate availability is checked with a read, and that read is **not** the
authority. Two concurrent requests can both find `acme-2` free; the unique
index on `slug` rejects one of them with error 11000, and that request
advances to the next candidate and retries.

This is the pattern `registration.service.ts` established for email — a
fast pre-check that avoids wasted work, with "the unique index is the final
authority" catching the race — and the reason `organization.repository.ts`
lets 11000 "propagate untouched" for a service to translate.

Attempts are bounded. Exhausting the bound raises a 409 rather than looping,
because an unbounded retry against a contended name is a request that never
returns.

### 8. Response and error surface

Success is `201` in the approved envelope, carrying the organization and
the caller's role in it. The role is included because it is the one fact
the client cannot derive: it just created something and is now the owner of
it.

Failures reuse the existing classes. `ValidationError` for a malformed
name, `InvalidAccessTokenError` (401) for an absent or bad credential —
raised by `requireAccessToken`, not by this module — and one new class:

`OrganizationSlugUnavailableError` (409, `ORGANIZATION_SLUG_UNAVAILABLE`),
raised only when §7's bounded retry is exhausted. It is added under
`lib/errors`'s stated rule that "only the error classes an existing slice
actually throws live here".

No generic enumeration concern applies. ADR-007 §1's tradeoff was about
*account* existence; organization slugs are public URL segments by
construction, and this endpoint is authenticated besides.

### 9. Logging

The module follows the existing structured convention: `event`, the ids an
operator correlates on, and the error's class rather than its message
(`authLogging.ts` — "a Mongo error's text can quote the offending
document").

Events: `organization.created`, `organization.slug_exhausted`,
`organization.creation_failed`, `organization.compensation_failed`.

The organization's **name is never logged.** It is user-submitted content,
it is not needed to triage anything, and log lines are the one place
tenant data leaks without anyone deciding to expose it. Ids are sufficient.

`AuthLogger` and `failureType` are imported from `modules/auth/authLogging`
rather than duplicated. The name is now slightly wrong for a
cross-domain utility; the file's own history says it was "extracted from
`emailVerification.ts` when login became a second consumer", and the same
rule says this pair moves to `lib/` when a third domain needs it. Moving it
now would churn nine auth files to rename a type.

### 10. Frontend scope

The dashboard gets a create-organization form and displays what it just
created. It does **not** list the caller's organizations, show a switcher,
or gate anything on membership — `/me` still returns no organization, and
inventing a client-side notion of "my organizations" before the server has
one would be exactly the fake state ADR-015 removed from this page.

The form is the minimum that demonstrates the endpoint end-to-end through
the real authenticated request path.

### 11. What this slice does not do

- **No `/me` change.** Membership and role on `/me`, and
  `requireOrganization`, are Slice 18. ADR-015 §9's deferral is *unblocked*
  by this slice, not closed by it.
- **No invitations or team management.** The second membership is a
  different flow with an email, a token, and an acceptance step. ADR-005 §2
  already excluded invitations from `AccountToken`.
- **No organization settings, rename, or slug change.** A slug change
  breaks URLs and needs a redirect story.
- **No deletion or transfer of ownership.** Transfer is two coordinated
  role flips that ADR-002 §3 designed the schema to make safe; it needs its
  own slice.
- **No rate limiting** (§2), which is Slice 19 and the one that lifts
  ADR-007 §13's gate.
- **No `Customer`, `Conversation`, widget, or Socket.IO.**

## Consequences

- Serviqo has tenants. `Organization` and `Membership` stop being
  unreachable schemas after twelve slices.
- The `{organizationId, role}` partial unique index is now load-bearing
  rather than theoretical: it is what makes "exactly one owner" a database
  guarantee instead of a service convention (ADR-002 §3).
- Slice 18 inherits one binding requirement from §3 — resolve organization
  access by loading the `Organization`, never by finding a `Membership`
  alone.
- The customer-facing work is unblocked. A widget key, a conversation's
  `organizationId`, and an agent's inbox all now have a real tenant to
  reference (ADR-010 §7).
- An `Organization` can be created without a transaction, at the cost of a
  documented, inert orphan in one crash window (§3). If Serviqo later runs
  on a replica set in every environment including development, this
  decision is worth revisiting — the write ordering stays correct either
  way, so a transaction would be an added guarantee rather than a rewrite.
- `membershipRepository` gains its first destructive method. It is narrow
  by `_id` and, per §4, may only ever be used to undo a write from the same
  request.
- Two organizations may share a display name. Names are not unique and are
  not intended to be; only slugs are, and §6 resolves collisions silently.
