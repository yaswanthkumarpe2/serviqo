# ADR-019: The Customer Principal and Widget Visitor Identity

**Status:** Accepted
**Date:** 2026-08-23
**Phase:** 2 (first customer-facing slice)
**Implements:** [ADR-010](./010-principal-types-organization-users-and-customers.md) §4 (the `Customer` model), §6 (the visitor mechanism ADR-010 declined to design), §9 (the second rate-limiter class)
**Related:** [ADR-011](./011-login-and-session-issuance.md) §1–2 (access-token issuance), [ADR-015](./015-access-token-verification-and-current-user.md) §2–3, §6 (verification, algorithm pinning, one refusal), [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (organization creation), [ADR-017](./017-organization-context-and-rbac.md) §1 (identifiers come from the server), [ADR-018](./018-rate-limiting-and-security-headers.md) §3 (limiter classes), §9 (CORS deferred to this slice)

## Context

ADR-010 settled that Serviqo has exactly two principal types and that a
customer is not a `User`, not a `Membership`, not an RBAC role, and not a
`Session`. It then deliberately stopped:

> The visitor mechanism is deliberately **not designed here**. What is fixed
> is that it is a third thing, and that a future slice may not shortcut its
> way to a customer credential by extending either existing model.

This is that slice. It builds the `Customer` model, the public widget
identifier on `Organization`, the visitor credential, and one endpoint that
turns the first into the last. It builds no conversation, no message, no
socket, and no widget UI.

Eleven slices of staff authentication exist and none of them is reusable
here. The shape of the problem is inverted at every point: the caller is
anonymous, unauthenticated by design, arrives from an origin Serviqo does
not control, has no password to prove anything with, and must be served
within one tenant that they cannot be permitted to name.

## Decisions

### 1. Three identifiers, and none of them is the other two

ADR-010 §7 fixed that `organizationId` is "derived server-side from the
widget credential, never read from the request body". That requires three
distinct things to exist, and the failure mode this slice is most exposed to
is collapsing any two of them:

| | What it identifies | Who holds it | Secret? |
|---|---|---|---|
| `Organization._id` | the tenant | the server | no, but never sent by a client |
| `Organization.widgetKey` | *which tenant a public page belongs to* | the tenant's website, publicly | **no** — it is in page source |
| `Customer._id` | one visitor's record inside one tenant | the server | no |
| the widget token | *this browser is that customer* | the browser | **yes** — it is a credential |

The widget token is the only credential. It is the only one of the four that
proves anything, and it is the only one a client presents in order to *be*
someone.

The temptation this table exists to refuse: making `widgetKey` do double
duty as a credential (it cannot — it is published), or making `Customer._id`
the visitor credential (it cannot — a client-supplied customer id is an
impersonation primitive, and ADR-017 §1 already refused the staff version of
exactly this).

There is deliberately **no fourth identifier** — no `visitorId`, no
`deviceId`, no browser fingerprint. Continuity across page loads is what the
token is *for* (§6). Storing a separate device id would mean a second thing
that answers "which visitor is this", and two answers to one question is how
they come to disagree.

### 2. `Customer` fields, and the ones deliberately absent

```
organizationId  ObjectId  required, ref Organization
name            String    nullable, default null
email           String    nullable, default null, lowercased
lastSeenAt      Date      required, default now
createdAt       Date      timestamps
updatedAt       Date      timestamps
```

Six fields. Each is justified below, and the ones a reader would expect and
not find are justified too, because "we did not think of it" and "we decided
against it" must not look the same in six months.

**`organizationId` is required and is the tenant boundary.** ADR-010 §4 and
SECURITY.md §2 both fix this. It has no default and no nullable state: a
customer who belongs to no organization is not a thing this system can
represent.

**`name` and `email` are optional and nullable.** ADR-010 §4 called this "the
sharpest structural difference from `User`". An anonymous visitor has neither,
and must still get a session (§7). They are stored as `null` rather than
omitted so the two states — "never supplied" and "supplied as empty" — cannot
both exist.

**`email` is NOT unique, in any form, and NOT a lookup key.** See §5. This is
the single most consequential field decision in this ADR.

**`lastSeenAt` is included, and `updatedAt` is not a substitute.** The
distinction is between *presence* and *modification*. Today they would hold
the same value, because this slice is the collection's only writer — but the
moment an agent edits a customer's name, or the AI's
`collectCustomerDetails` writes to one, `updatedAt` starts meaning "someone
changed this record" while the question that still needs answering is "was
this visitor here". A drive-by visit creates a document; without a presence
field, nothing distinguishes an abandoned anonymous record from a live one,
and no retention policy can ever be written against the collection that will
grow fastest in the system. One field now, or an un-backfillable field later.

**Deliberately absent:**

- **`status`.** `User` and `Organization` have one because they can be
  disabled or suspended, which is an action someone takes. Nothing suspends a
  customer — the tenant-level control is suspending the organization (§9),
  and per-conversation controls belong to the conversation.
- **`ipAddress`, `userAgent`, and any fingerprint.** `Session` stores these
  because a staff member reviewing their own devices needs to recognise them
  (ADR-004). A customer has no such screen and never will, so this would be
  visitor tracking data collected for no consumer — the definition of a
  liability rather than a feature.
- **`passwordHash`, `sessionId`, `role`, `permissions`.** ADR-010 §1 and §2.
  A customer authenticates nothing and holds no position in the tenant.
- **`conversationId` or any conversation pointer.** That relationship is
  ADR-010 §7's, owned by the model that does not exist yet, and pointing at
  it from here would put the join on the wrong side.

### 3. One index, and why the obvious second one is wrong

**`{ organizationId: 1 }` is created.**

Every query against this collection carries `organizationId` as a predicate,
by SECURITY.md §2 and by §4 below — so it is the one prefix every present and
future read shares. It is created now rather than when the first listing
query arrives (the sequence `membership.model.ts` index C followed) for a
reason specific to this collection: `Customer` is the only collection whose
row count grows with *visitor traffic* rather than with staff headcount. An
index added after that growth is an index build on the largest collection in
the system, and the cost of adding it now is one index on an empty
collection.

**No index on `email`, compound or otherwise.** Nothing queries by email
(§5), and an index would be the first half of writing the query that must not
exist.

**No unique constraint at all.** ADR-010 §4 requires that any uniqueness be
"per-organization and compound — never global". This model satisfies that by
having no uniqueness key: there is no attribute of a customer that is
required to be distinct, because two anonymous visitors are genuinely two
customers and two visits by one person who supplied the same email are also
two customers unless the token says otherwise (§5, §6). The prohibition
ADR-010 §4 wrote is against a *global* unique index, and it is honoured
by construction rather than by care.

**The `_id` index serves the one lookup this slice performs**, which is
`{ _id, organizationId }` — both keys in one query (§4).

### 4. Tenant scoping is a query predicate, never a comparison

`customerRepository.findByIdAndOrganization(customerId, organizationId)`
issues `findOne({ _id, organizationId })`.

Not `findById` followed by `customer.organizationId === expected`. This is
the rule `membership.repository.ts` wrote for `findByUserAndOrganization`
and the reasoning transfers unchanged: a comparison written by hand has
failure modes that are all quiet — an `ObjectId` compared to a `string` with
`===` is always false, and a comparison someone forgets is always true.

There is no `findAll`, no `findByEmail`, and no unscoped `find`. Every read
method on the repository takes `organizationId` as a mandatory argument, so
"fetch all customers then filter in memory" is not a thing a caller can
express against this repository, rather than a thing they are asked not to
do.

### 5. Email is stored, and is NEVER an identity lookup

If a visitor supplies `ada@example.com` and the server responded by finding
an existing customer with that address and issuing a token for it, then
**email would be the visitor credential** — and anyone who typed a known
address would inherit that person's identity, and (once conversations exist)
their history. That is an account-takeover primitive reachable from an
unauthenticated public endpoint by typing a guess.

So: a supplied email is **written to the customer this request already
identifies**, and is never read to find one.

This also settles the enumeration question ADR-010 §5 flagged in advance:

> ADR-007 §1's enumeration tradeoff is scoped to staff. […] It is **not** a
> licence to disclose whether a given website visitor has ever contacted a
> tenant.

Because no lookup by email happens, no response can differ based on whether
an address is known — the oracle does not exist to be leaked. Registration's
specific `409 EMAIL_ALREADY_EXISTS` has no counterpart here and never will.

**Normalization** matches `user.model.ts` exactly: `trim` plus `toLowerCase`,
applied by the schema on assignment. Not because a lookup needs to match — no
lookup exists — but because one address stored two ways in one tenant is a
data defect regardless, and the platform should canonicalize the same way in
both collections.

**Validation** is Zod at the boundary, with the same control-character
rejection `auth.validation.ts` and `organization.validation.ts` apply, and
the same reasoning: these values reach an agent's screen, an export, and
eventually an email envelope, where a bare CR is a header-injection
primitive.

**Supplied values only ever add.** An absent `name` on a resumed session does
not clear a stored one — a widget that forgot to send a field must not be
able to erase what the visitor typed a minute earlier.

### 6. The visitor credential is a stateless token, and it is what makes a session resumable

`POST /api/v1/widget/session` accepts an **optional** `visitorToken`: the
widget token issued to this browser previously.

- **Presented, valid, and bound to the same organization** → the customer it
  names is reused, `lastSeenAt` is updated, and a fresh token is issued.
- **Absent, expired, malformed, forged, or bound to a different
  organization** → a new anonymous `Customer` is created.

The second branch is the whole cross-tenant control, and it is deliberately
*not* an error. A browser holding tenant A's token and then visiting tenant
B's website is completely ordinary, and the correct outcome is that A's token
buys nothing in B — a new B customer — rather than a refusal that would tell
the caller their token was recognised. A token from A is not "rejected" in B;
it is *not applicable*, which is a stronger property.

**This is why there is no fourth identifier (§1).** The token already binds a
browser to a customer, cryptographically, with an organization claim the
server minted. A stored `visitorId` would be a second, weaker answer to the
same question.

**Why stateless rather than a stored session record.** ADR-010 §6 ruled out
reusing `Session` and `AccountToken`, and building a third database-backed
credential with rotation and reuse detection would be ADR-004's machinery
rebuilt for a principal that does not have ADR-004's problem. A widget
token's entire authority is "you are this one customer in this one tenant",
which is the smallest authority in the system. The cost is stated plainly in
§13: it cannot be revoked before it expires.

**TTL: 24 hours.** ADR-010 §6 required a visitor credential to "survive an
entire conversation and probably a return visit". A support conversation can
span a working day, and a token that expires mid-conversation would silently
create a *second* customer for the same person — the worst available failure,
because it looks like it worked. Twenty-four hours is the same number
`EMAIL_VERIFICATION_TOKEN_TTL_MS` uses and is the shortest value that clears
the "entire conversation" bar. A return visit next week gets a new customer;
durable long-term visitor identity needs a revocable stored credential and is
a later decision (§14).

### 7. Anonymous is the default path, not a fallback

A request carrying nothing but a valid `widgetKey` receives a customer and a
token. No name, no email, no prior token, no origin header required by
policy in every configuration (§10).

This is stated as a decision because it is the requirement most likely to be
eroded by a later "small" addition — a required email field to "reduce spam",
a required name to "personalise" — and each of those turns a support widget
into a form nobody fills in. ADR-010 §1 says a customer "registers nothing
and logs into nothing"; requiring an identifying attribute before a visitor
can ask a question is registration with the label filed off.

### 8. The widget token is a separate credential system, sharing no key with staff

| | Staff access token | Widget token |
|---|---|---|
| Secret | `JWT_ACCESS_SECRET` | **`JWT_WIDGET_SECRET`** |
| `aud` | `serviqo-dashboard` | **`serviqo-widget`** |
| `iss` | `serviqo` | `serviqo` |
| `alg` | HS256, pinned | HS256, pinned |
| `sub` | `User._id` | **`Customer._id`** |
| other claims | `sid` (session) | **`org` (organization)** |
| TTL | 15 minutes | 24 hours |
| Verifier | `verifyAccessToken` | `verifyWidgetToken` |

**Two independent controls separate them, and either alone would be
sufficient.** The audience is what ADR-010 §5 required and paid for a slice
in advance:

> It costs one claim now and cannot be retrofitted onto tokens already
> issued.

The distinct secret is the second, and it is the stronger of the two: a staff
token does not fail widget verification because its `aud` is wrong, it fails
because the signature does not verify at all. Belt and braces is the correct
posture for the one boundary in this system whose failure is a visitor
holding staff authority.

**`iss` is deliberately the same string.** One system issues both, and
inventing a second issuer would be a lie about the topology to make a table
look more different. The audience is the discriminator; that is what audience
is for.

**`JWT_WIDGET_SECRET` must not equal `JWT_ACCESS_SECRET`, and this is
enforced at boot**, not documented. A deployment that sets both to the same
value would have the audience claim as its only remaining separation, which
is a configuration error that produces no symptom until it produces the worst
one. `lib/env` refuses to start the process.

**The claim set carries no PII and no authorization.** No email, no name, no
role, no permissions — for the reasons `accessToken.ts` already states (a JWT
is signed, not encrypted, and reaches logs and error trackers), and
additionally because this token lives in a page Serviqo does not control,
on a device Serviqo does not own, handed to anyone who opens that page
(ADR-010 §8).

**The verifier enforces, in one call:** the pinned HS256 algorithm (ADR-015
§3 — an unpinned verifier honours `alg: "none"`), the signature under the
widget secret, `iss`, `aud`, `exp`/`nbf`, that `sub` is a 24-character hex
ObjectId, and that `org` is one too. It returns `null` for every failure
rather than distinguishing them, exactly as `verifyAccessToken` does and for
ADR-015 §2's reason.

**Organization binding is checked twice**: the token must carry an `org`
claim, and the caller must independently prove the same organization by
presenting its `widgetKey`. The token's claim is never trusted to *select* a
tenant — it is only compared against the tenant the widget key resolved
(§6). This is ADR-010 §7's "derived server-side from the widget credential,
never read from the request body" applied to the one field that would
otherwise look like a legitimate exception.

### 9. `widgetKey`: a public identifier that is not a credential

```
widgetKey       String    nullable, default: generated, partial-unique
allowedOrigins  [String]  default []
```

**Format: `wk_` followed by 43 base64url characters** — 32 bytes from
`randomBytes`. Each property is required by something:

- **Cryptographically random**, so it cannot be guessed into. Not derived
  from the name, the slug, or `_id` — a key derived from a public slug would
  be a public key, and one derived from `_id` would put an internal
  identifier into every tenant's page source, where it becomes an input to
  every future id-guessing attempt.
- **base64url** (RFC 4648 §5) so it is safe in a URL, a header, and an HTML
  attribute without escaping — the three places it will live.
- **The `wk_` prefix** makes the value self-describing in a log or a support
  ticket, and greppable by secret-scanning tooling. It costs three
  characters.
- **Unique**, by a database index rather than by a check (§9a).

**It is an identifier, not a credential, and the difference is load-bearing.**
It is *designed* to be public: it appears in the tenant's own page source,
readable by anyone who visits their website. Holding one lets a caller create
a customer in that tenant — nothing more. It grants no staff access, no read
of any existing customer, no conversation, and no organization data. That is
why the rate limiter (§11) rather than secrecy is what bounds its abuse, and
why the session response deliberately returns no tenant data (§12).

**Generated by a schema default, not by the onboarding service.** This
differs from `slug`, which the service generates, and the difference is the
point: a slug needs collision retry and reserved-word policy, which is
business logic and belongs above persistence (`organization.model.ts` says
so). A widget key needs neither — 256 bits of entropy makes the retry branch
one that never executes — so it is an identifier in exactly the sense that
`_id` is, and Mongoose defaulting `_id` is the same shape. The invariant
gained is that **every organization created from now on has one**, through
every creation path including tests, with nothing to remember.

### 9a. Existing organizations keep working, and the unique index is partial

An organization written before this slice has no `widgetKey`. Two things
follow, and the second is the one that would have broken production.

**Nothing about it breaks.** Widget lookup is *by* widget key
(`findByWidgetKey`), so a key-less organization is simply not reachable
through the widget. It is not damaged: staff login, refresh, logout,
`/me`, organization context, and RBAC neither read nor write this field.
"No widget yet" is a correct and inert state.

**The unique index must be partial, or a second key-less organization cannot
be written at all.** MongoDB indexes a missing field as `null`, so a plain
`unique: true` would treat every pre-existing organization as colliding with
every other one on the value `null` — the index build itself would fail on
any database holding two of them. The index is therefore:

```js
{ widgetKey: 1 }, { unique: true, partialFilterExpression: { widgetKey: { $type: "string" } } }
```

which constrains only documents that actually have one. Same instrument
`membership.model.ts` index B used to mean "at most one owner", applied here
to mean "unique among those that exist".

**No backfill migration is written.** Serviqo has no migration runner, and
inventing one to populate a field whose absence breaks nothing would be the
larger change. Generating a key for an existing organization is the
widget-installation slice's job, at the moment a staff member asks for their
embed snippet — which is also the moment anyone would notice.

### 10. The allowed-origin policy, stated as a rule

`allowedOrigins` holds **origins** — `scheme://host[:port]` — not URLs.
Validation rejects anything carrying a path, query, fragment, or userinfo,
anything that is not `http:` or `https:`, and anything containing a wildcard.
Values are normalized through `new URL(value).origin`, which lowercases the
scheme and host and drops a default port, so `HTTPS://Shop.Example.com:443`
and `https://shop.example.com` cannot both be stored as distinct entries that
mean the same thing.

**Wildcards are prohibited, in every spelling.** Neither `*` nor
`https://*.example.com` is accepted. A wildcard subdomain is precisely as
strong as the weakest subdomain a tenant has ever pointed at a third-party
service, and dangling-subdomain takeover is common enough that "any host
under our domain" is not a boundary. A tenant with fifty storefronts lists
fifty origins; that is a configuration-surface problem, not a reason to widen
a security control.

**The request-time rule:**

| `Origin` header | `allowedOrigins` | Outcome |
|---|---|---|
| present, matches an entry | non-empty | **allowed** |
| present, no match | any | refused |
| present, `null` or unparseable | any | refused |
| present | empty | refused |
| **absent** | any | **allowed** |

The last row is the one that needs defending. An absent `Origin` means the
caller is not a browser making a cross-origin request — it is `curl`, a
server, a native app, or a test. Refusing it would buy nothing: a non-browser
caller can set `Origin` to any value it likes, so the header only constrains
the one caller that cannot lie about it. The list exists to stop **a browser
on an unapproved website** from embedding a tenant's widget, and against that
threat the header is always present and always truthful, because browsers set
it on cross-origin `POST` and refuse to let script override it.

An empty `allowedOrigins` therefore means "no website may embed this widget",
not "every website may" — the default is closed. A newly created organization
starts with an empty list and can be exercised by non-browser callers
(including this slice's own tests) while being embeddable nowhere.

**The `Origin` header never selects a tenant.** It is compared against a list
the server already loaded, using a tenant already resolved from the widget
key. This is the concrete meaning of "do not silently trust an Origin
supplied by the customer": the value is a claim to be checked, never an input
to a lookup.

### 11. A sixth rate-limiter class, which ADR-010 §9 ordered in advance

`widgetSession` joins the five ADR-018 §3 classes, built by the same
`lib/rateLimit` factory with the same store, the same envelope, the same
`Retry-After` headers, and the same logging. It is not an ad-hoc limiter, and
the security gate is not bypassed — the endpoint sits under `/api/v1`, so the
`global` per-IP bound applies to it as well.

ADR-010 §9 required this in advance:

> Two limiter classes, not one. Staff endpoints face a small, known
> population and are additionally protected by per-account lockout. Customer
> endpoints are high-volume, anonymous, and unauthenticated by design.

**Why not reuse `credential`.** Ten per fifteen minutes is derived from
`LOGIN_MAX_FAILED_ATTEMPTS` — a *guessing* bound for a password. Nothing is
guessed here; there is no secret to guess. Applied to a public widget it
would take one small office behind one NAT to exhaust a tenant's visitors,
which is a self-inflicted outage rather than a defence.

**Why not reuse `session`.** Sharing a bucket would let widget traffic
exhaust a staff member's refresh budget, and staff traffic exhaust a
tenant's visitors — coupling two populations that have nothing to do with
each other, in a product where one of them is the customer.

**60 per 15 minutes, keyed by IP.** The numbers are taken from the `session`
class rather than invented, because the endpoint has the same shape:
unauthenticated, IP-keyed, exactly one database write per call, and no secret
being guessed. A visitor needs one session per browser per token lifetime, so
sixty covers a shared NAT of ordinary size while bounding an anonymous
document-creating loop to four per minute.

**Keyed by IP and never by `widgetKey`.** A per-key counter would make one
busy tenant's own visitors a shared outage, and would hand anyone who read a
tenant's page source a denial-of-service tool aimed at that tenant — the same
failure ADR-018 §5 refused when it declined to key the credential class by
email address.

### 12. One refusal, one message, and a response that carries no tenant data

Every failure — unknown widget key, suspended organization, disallowed
origin, absent origin under a policy that required one — is
`403 WIDGET_SESSION_REFUSED` with one message. The reason is logged and never
sent, exactly as ADR-009 §1, ADR-011 §3, ADR-012 §3, ADR-015 §6 and ADR-017
§6 each did in turn.

Distinguishing "unknown key" from "suspended organization" would confirm to a
prober which keys are real, which is tenant enumeration through the front
door. "Disallowed origin" is the tempting exception — it is genuinely useful
to a tenant installing the widget on a new domain — and it is refused with
the rest, because it also confirms the key is valid to anyone who scraped one.
Installation diagnostics belong in the dashboard, where the caller is already
authenticated and already knows the tenant exists.

**403 rather than 404.** The endpoint's existence is public by construction —
it is named in every tenant's page source — so answering 404 would be
pretending a demonstrably present route is absent, an opacity that buys
nothing. 403 with a single message discloses nothing further. It is not 401,
because there is nothing to authenticate as: the widget key is an identifier,
and there is no `WWW-Authenticate` challenge that would mean anything.

A malformed or absent `widgetKey` is a `400 VALIDATION_ERROR` from
`validateBody`, like any other shape failure. That distinction is safe: it
depends only on the submitted string's form, never on whether any tenant
exists.

**The success response carries the minimum:**

```json
{ "token": "…", "expiresInSeconds": 86400,
  "customer": { "id": "…", "name": null, "email": null } }
```

No organization id, no organization name, no slug, no status, no widget
configuration, no allowed origins, no session internals, no `__v`, no
`createdAt`. The token binds the organization already, so the client has no
use for its id and no business holding one. `customer.id` is the caller's own
identifier — the subject of the token they are holding — so it discloses
nothing to the party receiving it, and it is the handle that makes a support
report actionable. `name` and `email` are echoed as stored, so a widget
renders what was actually persisted rather than what it hoped was.

**The token is never logged**, at any level, on any path — issued, presented,
valid, or rejected. Neither is the widget key, which identifies a tenant, nor
a customer's name or email. What is logged is the event name, the
organization id, the customer id, and the refusal reason: server-side
identifiers an operator can act on, and nothing a person typed.

### 13. CORS is still not introduced, and this is not the slice that can

ADR-018 §9 named this slice as CORS's owner. It is deferred once more,
deliberately, and the reason is specific rather than schedule pressure.

**A preflight cannot know the tenant.** A cross-origin `POST` with
`Content-Type: application/json` triggers an `OPTIONS` preflight, and a
preflight carries **no request body** — so it carries no `widgetKey`, so the
server cannot resolve which organization's `allowedOrigins` to check against,
so it cannot answer with a per-tenant `Access-Control-Allow-Origin`. Every
resolution to that is a transport design decision — put the key in the path
or a query parameter, or shape the request to avoid preflight entirely — and
each one is a choice about the widget's wire protocol, which is the widget
slice's to make with the client in front of it.

Introducing CORS now would mean guessing that protocol and then either
living with the guess or changing a security header's contract later.

**What this slice does establish is the server-side decision**, which is the
part that actually enforces anything: origins are validated when configured
(§10), and checked on every request (§10), and a disallowed origin is refused
before any customer is created. That control is complete and tested. What is
absent is only the response header that would let a browser *read* the
answer — and no browser client exists to read it.

Concretely: **no `cors` dependency, no `Access-Control-Allow-Origin` in any
value including `*`, and no change to the staff header policy.**
`crossOriginResourcePolicy: same-origin` stays global; ADR-018 §9's note that
`/api/v1/widget/*` will need `cross-origin` stands, unactioned, for the same
slice that solves the preflight.

### 14. What this slice does not do

- **No `Conversation`, no `Message`, no Socket.IO, no agent inbox, no
  ticketing, no AI.** ADR-010 §7 and §9 bind those; none is started.
- **No widget UI.** No chat bubble, no chat window, no embed script, no
  customer dashboard. No frontend change of any kind.
- **No CORS** (§13).
- **No staff surface for `widgetKey` or `allowedOrigins`.** Nothing reads a
  widget key back to the tenant that owns it, and nothing lets a tenant
  configure their origins. Both are the widget-installation slice's, and the
  field is inert until then (§9a). This is a real gap and is listed as such
  rather than smuggled in as a "small" addition to `GET /organizations/:id`.
- **No token revocation.** A widget token is valid until it expires, up to 24
  hours, and nothing can shorten that (§6). The authority at stake is one
  customer's own identity in one tenant, which is the smallest in the system,
  and the exposure window is bounded by the TTL. A revocable credential needs
  a stored session record, and building ADR-004's machinery for a principal
  that does not have ADR-004's problem is the trade this ADR declines. It
  becomes reconsiderable when conversations exist and a token grants read
  access to message history.
- **No customer-facing portal.** ADR-010 §10 already fixed that this requires
  a new ADR, and nothing here reaches it.
- **No `Customer` deletion, merge, or GDPR erasure path.** Anonymous-first
  identity makes "which records are this person" a real question, and it is
  not answerable before conversations exist.

## Consequences

- ADR-010's two deliberate gaps — the `Customer` model (§4) and the visitor
  mechanism (§6) — are closed. Serviqo now genuinely carries two identity
  systems, with the ongoing cost ADR-010 accepted in advance: two credential
  formats, two verifiers, two secrets, two rate-limit strategies.
- The audience claim ADR-010 §5 paid for eleven slices early is now
  load-bearing rather than ceremonial, and is joined by a second, stronger
  control: distinct signing keys (§8).
- `JWT_WIDGET_SECRET` is a required environment variable with no default. An
  existing deployment will not boot until it is set — which is the intended
  behaviour for a signing key, matching `JWT_ACCESS_SECRET`'s precedent, and
  is a deployment note rather than a defect.
- Every organization created from now on carries a widget key it did not ask
  for (§9). Existing ones do not, and are unharmed (§9a).
- SECURITY.md §6 and §11's "CORS — the widget slice owns this" is amended
  rather than closed: the server-side origin decision ships, the header does
  not, and §13 says exactly what remains.
- A sixth rate-limit class exists. ADR-018 §3's table is extended, and its
  rule that every number is either derived or explicitly justified is
  preserved (§11).
- The first tenant-owned resource model exists, so SECURITY.md §2's
  "repository-layer enforcement" stops being aspirational and becomes a
  pattern with one implementation (§4) that `Conversation` and `Ticket`
  inherit.
- The widget key is unreachable by the tenant that owns it until the
  installation slice ships (§14). This is the sharpest limitation of this
  slice and is the reason the next one exists.
