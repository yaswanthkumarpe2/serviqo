# ADR-020: Widget Installation — a Staff Configuration Surface for `widgetKey` and `allowedOrigins`

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (widget installation slice)
**Closes:** [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §14's named gap — "No staff surface for `widgetKey` or `allowedOrigins`. […] Both are the widget-installation slice's, and the field is inert until then."
**Implements:** [ADR-017](./017-organization-context-and-rbac.md) §7's `organization.manage` permission — defined with no endpoint since the slice that added it
**Related:** [ADR-016](./016-organization-onboarding-and-the-first-membership.md) §3 (resolve access by loading the `Organization`), [ADR-018](./018-rate-limiting-and-security-headers.md) §3 (limiter classes)

## Context

ADR-019 built a `widgetKey` and an `allowedOrigins` list that only the
database could see. Nothing let a tenant read the key its own website needs,
and nothing let a tenant say which websites may use it. ADR-019 §14 named
this precisely and declined to close it in the same slice: "the field is
inert until then." This is that slice.

`organization.manage` already exists in `ROLE_PERMISSIONS`
(`memberships/permissions.ts`), granted to `owner` and `admin`, with the
comment "Change the organization: rename, settings, suspend. No endpoint yet
(ADR-017 §8)." Widget installation is exactly a tenant setting, so this slice
is that permission's first enforcer rather than a new one. No permission is
added.

## Decisions

### 1. Three endpoints, one permission, one path prefix

```
GET  /api/v1/organizations/:organizationId/widget-config
PUT  /api/v1/organizations/:organizationId/widget-config/origins
POST /api/v1/organizations/:organizationId/widget-config/rotate-key
```

All three sit behind `requireAccessToken` → `requireOrganization` →
`requirePermission("organization.manage")`, the same order ADR-017 §2 fixed
and the same permission for read and write alike. There is no
`organization.manage:read` split: a role that may not change the widget
configuration has no legitimate reason to read the live key either — reading
it is the first step toward installing or sharing it, which is exactly the
action the permission gates. `supervisor` and `agent` see neither. Contrast
`GET /organizations/:organizationId`, which stays behind `organization.read`
because every member legitimately needs to confirm which tenant they are in.

Nested under `/organizations/:organizationId` rather than given a new
top-level prefix, because this is organization configuration, not a new
domain — the same reasoning `organization.routes.ts` already applies to
`GET /organizations/:organizationId`. It is a sibling of that route, not a
member of the public `/api/v1/widget/*` namespace ADR-019 §8 reserved for
unauthenticated customer traffic; sharing a path segment with that namespace
would blur a boundary ADR-010 §5 drew on purpose.

**Rate limiting reuses the existing authenticated classes** —
`authenticatedRead` for the `GET`, `authenticatedWrite` for the two writes —
mounted before `requireOrganization`, matching `GET /organizations/:id`'s
placement so a caller cannot spend database lookups probing organization ids
they have no membership in. No new limiter class: these are staff endpoints
with the same shape ADR-018 §3 already covers, and inventing a seventh class
for two more routes under an existing one would be a distinction with no
threat model behind it.

### 2. `GET` mints a key on first read, closing ADR-019 §9a's deferred step

ADR-019 §9a assigned this precisely: "Generating a key for an existing
organization is the widget-installation slice's job, at the moment a staff
member asks for their embed snippet — which is also the moment anyone would
notice." `GET /widget-config` is that moment. `organizationRepository`
gains `ensureWidgetKey`, which loads the organization and mints a key via
`generateWidgetKey()` only if `widgetKey` is still `null`, then persists it
before the read returns. A newly-created organization already has one
(ADR-019 §9's `pre("save")` hook) and this call is then a no-op read; only an
organization created before Slice 20 is ever mutated here.

This is a read endpoint that sometimes writes. That is accepted rather than
split into "read" and "provision" endpoints, because the write is not a
choice a caller makes — it is idempotent, invisible in its result (the caller
always sees a key), and splitting it would just relocate the same mint to a
second call every legacy organization's first visit would still have to make.

### 3. Origin updates replace the list; the schema normalizes and rejects duplicates before persistence sees them

`PUT .../origins` takes `{ allowedOrigins: string[] }` and replaces the
stored list wholesale — there is no `POST .../origins/add` or `DELETE
.../origins/:origin`. A tenant's origin list is small (ADR-019 §10's own
example is fifty), so "send the list you want" is both simpler for a client
to reason about and immune to a lost `DELETE` leaving a stale entry active.
The frontend's add/remove controls compute the next array locally and PUT
the whole thing, the same shape `replaceAllowedOriginsSchema` expects.

**Validation normalizes each entry with the exact `normalizeOrigin` ADR-019
§10 defined**, imported from `widgetConfig.ts` rather than re-implemented —
this is the one function that decides what an origin is, and a second
implementation at the HTTP boundary would be a second place for that
definition to drift from the model's own setter. A malformed entry — a path,
a query, a fragment, userinfo, a non-`http(s)` scheme, or any wildcard — is
rejected at the boundary with a field-level issue (`allowedOrigins.<index>`),
before any database call.

**Duplicates are rejected, not silently deduplicated**, checked *after*
normalization so `https://Shop.example.com` and `https://shop.example.com/`
are caught as the same entry rather than stored as two spellings of one
origin — precisely what ADR-019 §10 canonicalizes to prevent. Silent
deduplication was considered and rejected: a client that sent a duplicate by
mistake deserves to see why its list changed, and a boundary that quietly
edits a caller's input is a boundary a caller cannot trust to store what it
sent.

**The bound is fifty entries**, taken verbatim from ADR-019 §10's own
example ("a tenant with fifty storefronts lists fifty origins") rather than
invented — the same rule `config/constants.ts`'s header states for every
number in this codebase: derived from an existing commitment or explicitly
justified.

**An empty list is accepted and means closed**, unchanged from ADR-019 §10:
this endpoint is how a tenant reaches that state deliberately, not a case
this slice treats specially.

### 4. Origin writes load, assign, and `save()` — never `findByIdAndUpdate`

`organizationRepository.replaceAllowedOrigins` and `rotateWidgetKey` both
load the document, assign the field, and call `.save()`, rather than issuing
an update query. This is a correctness requirement, not a style preference:
`allowedOrigins`'s schema-level `set` transform (the second application of
`normalizeOrigin`, and the one `organization.model.ts` actually enforces) and
its `validate` function both run when a `Document` is assigned and saved —
`Model.findByIdAndUpdate` does not apply SchemaType setters to its update
document, so writing through it here would let the model's own defence
against two spellings of one origin go silently unexercised on this one
write path while every other path (creation, and this same request's Zod
boundary) still runs it. The pattern matches `organizationOnboarding.service`,
which already loads-then-persists rather than issuing raw update queries
inside its transaction-shaped ordering.

`replaceAllowedOrigins` also mints a widget key if one is still absent, in
the same document load — so a legacy organization whose staff configures
origins before ever opening the "read" tab still gets a complete response,
and a key is minted exactly once regardless of which of the two write-behind
paths (read, or origin update) reaches it first.

### 5. Rotation overwrites the one stored value; there is no key history

`rotateWidgetKey` mints a fresh key with the same `generateWidgetKey()`
ADR-019 §9 already built and writes it over the old one on the same
`Organization` document. There is no `previousWidgetKeys` array, no
grace-period double-validity, and no revocation list.

**This is what makes "the old key stops working immediately" true by
construction rather than by a check.** `findByWidgetKey` (ADR-019 §1) is the
only way any request — staff or widget — resolves a tenant from a key. The
moment the `save()` in this call commits, that query for the old value
returns nothing for the same reason a key-less legacy organization returns
nothing (ADR-019 §9a): the value simply is not in the collection anymore.
There is no cache and no second store to invalidate, so there is no window in
which both keys work — a property a list-of-valid-keys design would have had
to construct deliberately and this one gets for free.

**No overlap window is offered on purpose.** A tenant mid-migration between
two sites might prefer both keys valid for an hour; that is explicitly not
supported, matching the posture ADR-019 §14 already took toward the widget
token itself ("nothing can shorten \[the TTL] for a token already issued …
a revocable credential needs a stored session record, and building ADR-004's
machinery for a principal that does not have ADR-004's problem is the trade
this ADR declines"). A `widgetKey` is simpler than a widget token — it is
not a credential — and a rotation history is exactly that machinery, aimed
at a value that does not need it: rotation is rare, deliberate, and staff-
initiated, not a per-session credential refresh.

**The response after rotation carries the new key and nothing about the
old one** — not its value, not its last-four characters, not a timestamp
naming when it stopped working. There is nothing to display that helps an
operator and everything to display that would be a second copy of a value
this slice otherwise refuses to log (§7).

### 6. The embed snippet is composed by the frontend from the widget key alone; no server field is added for it

The server's contract is unchanged from what `GET /widget-config` already
returns: `widgetKey`. The frontend renders a copyable snippet built from that
key and `window.location.origin` — the origin the dashboard itself is being
served from in the browser — never a hardcoded host.

This is deliberately as far as this slice goes. Phase 20 ("Embeddable chat
widget") has not shipped: there is no loader script, no `/widget/loader.js`
route, and no customer-facing widget UI of any kind (ADR-019 §14, "No widget
UI. No chat bubble, no chat window, no embed script"). A server field
purporting to be "the embed snippet" would imply a working artifact that does
not exist yet, which is exactly what CONTRIBUTING.md's "No Fake
Functionality" section forbids labelling as available. The rendered snippet
is a `<script>` tag carrying a `data-serviqo-widget-key` attribute and a
`src` pointed at the current origin — the shape a real loader will read once
one exists — and the dashboard labels it explicitly as inert until that
slice ships, the same way `DashboardPage`'s sample metrics are labelled
rather than presented as real. No environment variable is introduced to name
a widget-script host: there is no host to name yet, and inventing
`PUBLIC_WIDGET_SCRIPT_URL` ahead of the artifact it would point at is exactly
the speculative infrastructure this codebase declines elsewhere.

### 7. Logging carries identifiers and counts; never a key, an origin list, or a token

Every write logs an event name, the organization id, and the acting user id.
`organization.widget_key_rotated` logs nothing else — not the old key, not
the new one. `organization.allowed_origins_updated` logs `originCount`
rather than the origins themselves, matching the minimal-safe-fields
convention `requirePermission` and `lib/rateLimit` already apply: an operator
needs to know a change happened and who made it, not to have a second copy
of tenant configuration sitting in the log stream. This is stricter than the
value's own sensitivity classification requires — ADR-019 §9 calls the key
public and the origins are tenant-authored hostnames, neither a secret — and
is chosen anyway because a log line is a place data lands without anyone
deciding to put it there, and the narrower default costs nothing here.

### 8. What this slice does not do

- **No new permission.** `organization.manage` already existed with this
  exact endpoint named as its future occupant (ADR-017 §7).
- **No widget loader script, no embed script, no customer-facing widget UI.**
  Phase 20's territory, untouched (§6).
- **No key-rotation history, grace period, or multi-key validity.** A single
  stored value, by design (§5).
- **No change to `allowedOrigins`'s validation rules.** `normalizeOrigin` and
  `isValidOrigin` are reused unchanged from ADR-019 §10; this slice is a new
  caller, not a new rule.
- **No CORS change.** ADR-019 §13's reasoning is untouched — this slice adds
  no browser-facing endpoint under `/api/v1/widget/*` and does not revisit
  the preflight problem.
- **No audit log or settings-history UI.** The structured log line (§7) is
  what exists; a queryable history is a later, larger feature.

## Consequences

- ADR-019 §14's gap is closed: a tenant can read its widget key, configure
  which websites may use it, and rotate it if it leaks — the three actions
  that gap explicitly named as missing.
- `organization.manage` now has its first enforcer, proving the permission
  ADR-017 §7 defined five slices in advance actually gates something.
- The widget key's threat model is unchanged: it remains a public identifier,
  bounded by the origin allowlist and the `widgetSession` rate limiter
  (ADR-019 §11), not by secrecy. Rotation is the tenant's remedy for a key
  that ended up somewhere they did not intend, exercised through staff
  authentication and `organization.manage` rather than through any new
  control.
- The embed snippet shown to staff today references an artifact (the loader
  script) that does not exist. That gap is explicit and labelled, and is
  closed by Phase 20, not by this slice.
