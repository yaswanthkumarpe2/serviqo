# ADR-038: One Chat Link per Organisation

**Status:** Accepted
**Date:** 2026-09-14
**Phase:** 5 (Widget), 6 (Conversations)
**Amends:** [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §1 (no stored visitor identifier) and §10 (every session origin must be on the tenant's list); [ADR-021](./021-embeddable-widget-loader-shell-and-isolation.md) §6 (the visitor token lives in `sessionStorage`)
**Related:** [ADR-010](./010-principal-types-organization-users-and-customers.md) §4 (uniqueness among customers is per-organisation and compound); [ADR-020](./020-widget-installation-configuration-surface.md) §2 (widget keys minted on demand); [ADR-022](./022-persistent-conversations-and-messages.md) §1 (every query carries the organisation); [ADR-024](./024-widget-realtime-chat-client.md) (the widget's open sequence); [ADR-037](./037-customers-never-authenticate.md) (customers never sign in)

## Context

ADR-037 settled that customers never sign in. What it left open is how a
customer reaches an organisation at all.

Until now the only way was the embed: a `<script>` tag on the organisation's
own website, restricted to origins it listed. That works for an organisation
with a website it controls, and for nobody else. It also cannot be pasted into
an email, a WhatsApp reply, a receipt or a QR code.

Serviqo needs one link per organisation that a customer can open and start
talking:

```
https://serviqo.com/widget/centralservice
```

Most of what that link needs already existed: anonymous customers scoped to an
organisation (ADR-019), a widget key per organisation (ADR-020), and a chat
client that opens a session, finds the conversation and receives replies live
(ADR-024). Four things were missing:

- a stable address for each organisation;
- a way for a page on Serviqo's own origin to open a session;
- a way for a returning customer to find their conversation once the one-day
  token has expired;
- a place for staff to find the link.

## Decisions

### 1. The link is the slug, and the slug never changes

The link is `${CLIENT_URL}/widget/<slug>`, built by one function,
`buildWidgetUrl`. The slug is already unique, URL-safe (`SLUG_PATTERN`), and
generated when the organisation is created, so every organisation has a link
from the moment it exists and none has to be configured.

**The slug is now `immutable` on the model.** A link gets printed, bookmarked
and pasted into places Serviqo never sees. Renaming an organisation changes its
`name` and must never break every link to it. No route has ever updated a slug;
this makes that a property of the model rather than an accident of the routes.

**The link is not a credential.** It resolves to a widget key, and the widget
key opens an anonymous session, the same as the embed. Anyone may hold the link,
which is what it is for.

### 2. A public lookup, one slug at a time, and Serviqo's own origin is allowed

```
GET /api/v1/widget/organizations/:slug   →   { name, widgetKey }   |   404
```

The hosted page uses this to learn which organisation it is. It returns the name
to display and the key to open a session with. Neither is secret: the widget key
already appears in every embedding page's source (ADR-019 §9). The response does
not include the organisation's id, status, allowed origins, or anything about its
staff.

- An unknown, malformed or suspended slug gets **one identical 404**.
- **There is no listing route.** Someone can still try slugs to learn which
  organisations exist, but an organisation handing its customers a link is not
  trying to be unfindable. The new IP-keyed `widgetDirectory` limiter
  (120 per 15 minutes) bounds that probing without spending the budget visitors
  need to open sessions.
- An organisation created before widget keys existed gets one minted on this
  lookup (ADR-020 §2).

**Serviqo's own origin is always an allowed session origin.** `decideOrigin`
accepts the origin of `CLIENT_URL` in addition to the organisation's list.
Without this, every organisation would have to add Serviqo to its embed list
before its own link worked.

This loosens nothing an attacker can use. The Origin check exists to stop a
third-party *page* embedding a tenant's widget, and Serviqo's own page is not a
third party. A non-browser caller could already send any Origin it liked.

### 3. A visitor key, so a customer can come back

The widget token lasts a day and cannot be revoked (ADR-019 §14). Before this
ADR, a customer who returned the next day became a new anonymous customer with
an empty thread. For people who never sign in, that is losing the conversation.

A new visitor now also receives a **visitor key**:

- 256 bits from `generateSecret`, returned **once**, on the response that minted
  it, and never again.
- The browser stores it. The server stores only its SHA-256, in
  `Customer.visitorKeyHash`, which is `select: false` and stripped when the
  document is serialised.
- A session request may carry `visitorKey`. The server tries a valid token first,
  then the key, then creates a new anonymous customer. A key that matches nothing
  leads to a new customer, never to an error, exactly as a foreign token does.
- **The key lookup always carries `organizationId`.** A key from organisation A
  presented through organisation B's widget matches nothing, and the visitor
  becomes a new customer in B.
- A customer created before this ADR who resumes by token gets a key attached
  then. The attach only succeeds while no key is set, so of two tabs racing, only
  the key the database actually stored is handed out.

This amends ADR-019 §1, which ruled out a stored visitor identifier on the
grounds that two answers to "which visitor is this" would drift apart. This is
not a device id or a fingerprint. It answers the question the same way the
token does, by proving possession of a secret, and it is issued by the same
session call.

**Uniqueness.** The collection's one uniqueness constraint is the index on
`{ organizationId, visitorKeyHash }`. It is compound, as ADR-010 §4 requires, and
partial, so every customer without a key is exempt. Nothing a visitor types is
unique or indexed.

**Storage.** The widget now uses `localStorage` for both the token and the key,
replacing ADR-021 §6's `sessionStorage`, which forgot a customer whenever the tab
closed. The cost is that a shared computer keeps the conversation reachable for
the next person at that browser, which is true of every chat that remembers its
visitor. A token the server refuses is still cleared; the key is kept, because
an expired token is the usual reason for a refusal and the key is what recovers
from it.

### 4. Every member sees the link

`GET /organizations/:id` returns `widgetUrl`. That read requires only
`organization.read`, which agents hold, so every member of an organisation can
see and copy its link. The workspace shows it on the first view and again in
Settings.

`GET /organizations/:id/widget-config` returns `widgetUrl` as well, beside the
embed key and allowed origins that only `organization.manage` can see. The URL is
always built by the server, so a link copied from the workspace is exactly the
link the server will resolve.

### 5. Phone number, optional like name and email

`Customer.phone` is optional, validated only loosely (digits, spaces, common
punctuation, an optional `+`, 5–32 characters), and never used as a lookup key,
for the reason `email` is not: anyone can type one. It is offered in the widget's
existing optional details control, next to name and email, and shown to agents
in the inbox. Nothing requires it.

### 6. The hosted page is the embed, presented as a page

`/widget/:slug` is a public route outside every guard. It looks up the slug, then
mounts the widget core with `presentation: "page"`: open from the start, no
launcher bubble, no close button, not a modal dialog, and Escape does nothing.

It is deliberately **the same code** as the embed. Session, visitor key,
conversation, history, socket, de-duplication, and recovery from a closed
conversation are not reimplemented. A second chat client for the hosted page
would be a second place for any of them to be subtly wrong.

The lookup is sent with `credentials: "omit"`, so a staff session in the same
browser never accompanies a customer's request.

A link that leads nowhere shows "This chat isn't available". A server that
cannot be reached shows a retry.

## Consequences

- Every organisation has a working customer chat link from the moment it is
  created, with nothing to configure.
- A customer can come back days later, on the same browser, to the same
  conversation, still without an account. On a different browser or after
  clearing site data they are a new customer. That is accepted: anything that
  followed a person across browsers would be an identity, and customers do not
  have one.
- The embed keeps working unchanged, apart from remembering visitors across tab
  closes.
- An organisation's slug can never be changed. Renaming it a second way would
  need a redirect table, and that would be its own decision.
