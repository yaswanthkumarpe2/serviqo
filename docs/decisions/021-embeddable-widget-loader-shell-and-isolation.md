# ADR-021: The Embeddable Widget Loader — Shell, Isolation, and the Cross-Origin Session Call

**Status:** Accepted
**Date:** 2026-08-24
**Phase:** 2 (embeddable widget shell slice)
**Closes:** [ADR-020](./020-widget-installation-configuration-surface.md) §6's named gap — "there is no loader script, no `/widget/loader.js` route, and no customer-facing widget UI of any kind"; [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §13 — "a preflight cannot know the tenant […] each [resolution] is a choice about the widget's wire protocol, which is the widget slice's to make with the client in front of it." This is that slice.
**Related:** [ADR-019](./019-customer-principal-and-widget-visitor-identity.md) §6 (resumable visitor token), §8 (widget token shape), §10 (allowed-origin policy); [ADR-018](./018-rate-limiting-and-security-headers.md) §9 ("`/api/v1/widget/*` will need `cross-origin`"); [ADR-010](./010-principal-types-organization-users-and-customers.md) §5, §8

## Context

ADR-019 built the endpoint (`POST /api/v1/widget/session`) and ADR-020 built the
staff surface that hands out a `widgetKey` and an embed snippet:

```html
<script src="{origin}/widget.js" data-serviqo-widget-key="wk_…" async></script>
```

Both explicitly stopped short of the artifact that snippet names. ADR-020 §6
was precise about why: "there is no loader script … a server field purporting
to be 'the embed snippet' would imply a working artifact that does not exist
yet." This slice builds that artifact — the file the snippet's `src` resolves
to, and everything it does once a third-party page executes it.

Two things make this slice different from every one before it. First, its
code runs somewhere Serviqo does not control: a tenant's website, alongside
that page's own scripts and CSS, sharing nothing by default but the DOM.
Second, calling `POST /api/v1/widget/session` from that page is a genuine
cross-origin browser request — and ADR-019 §13 declined to answer that,
deliberately, because the answer is "a choice about the widget's wire
protocol," which needed the client in front of it. This ADR is that choice.

## Decisions

### 1. No second server: the loader ships as a static asset beside the dashboard

`middleware/securityHeaders.ts` already states the deployment shape this
slice inherits: "`apps/web` is served by Vite in development and would be a
static host in production — no HTML leaves this [API] server." The API
server is a JSON-only process and stays one; it gains no static file route
and no new listener.

`apps/web` gains a **second Vite build entry** — `vite.widget.config.ts`,
building `src/widget/main.ts` in IIFE format to a single dependency-free
file, output to `public/widget.js`. Vite's `public/` directory is copied
verbatim into `dist/` by the dashboard's own `vite build`, so `widget.js`
ships as a sibling of `index.html` with no change to how the dashboard is
deployed. `npm run build` (in `apps/web`) is amended to build the widget
bundle first, so `dist/widget.js` exists whenever `dist/` does. The file
lands in `public/widget.js` only at build time and is `.gitignore`d — it is
generated output, not source, the same distinction `dist/` already draws for
everything else in this repository.

This is also what makes ADR-020 §6's `window.location.origin` correct
without a new environment variable: the origin the dashboard is served from
is the same static host `widget.js` now ships from, because they are the
same build output.

**Why not a route on the API server.** `securityHeaders()` configures Helmet
for "a JSON API, and nothing else" — no HTML, no static-asset caching
headers, no MIME handling. Serving a JS file from that process would mean
either weakening its CSP for one route or duplicating a static-file
pipeline Express does not otherwise need. The web app's own build already
has one.

### 2. No framework dependency

`src/widget/` imports nothing from `src/app`, `src/features`, or
`src/components` — not `react`, not the design system, not the dashboard's
`fetch` wrapper. It is written in vanilla TypeScript against DOM APIs.

An embeddable widget's first performance constraint is the page it loads
into, which is not Serviqo's and did not budget for it. Bundling React would
roughly quadruple the artifact for a UI of one button and one panel. The
dashboard's own component patterns are not reachable from here for the same
reason `widgetToken.ts` shares nothing with `accessToken.ts` (ADR-019 §8):
sharing code across the staff/customer boundary is how the two sides start
depending on each other by accident. Styling is a hand-written CSS string
(§4) using the values `PROJECT_CONTEXT.md` §20 already fixes (Canvas,
Surface, Text, Brand Emerald), not the Tailwind pipeline the dashboard
build uses — pulling Tailwind's reset into a page Serviqo does not own would
fight the isolation §3 exists to provide.

### 3. Shadow DOM, not an iframe

The loader creates one host element, calls `attachShadow({ mode: "open" })`
on it, and renders the launcher and panel entirely inside that shadow root,
with a single `<style>` element scoped to it.

**What this buys, both directions.** A shadow root is a separate DOM tree
for CSS purposes: the host page's stylesheets do not match elements inside
it (no descendant selector crosses the boundary), and the widget's own rules
do not leak out through element/class selectors a tenant's page might
coincidentally also use. Neither side can break the other by accident.

**Why not an iframe.** An iframe would isolate more — a separate `window`,
a separate JS realm, a real navigation boundary — none of which this slice
needs. There is no host-page script this widget must be defended against
running inside it (the threat an iframe answers), and there is no document
to navigate. What an iframe would cost: cross-frame `postMessage` for every
interaction, manual height/width synchronization so the panel does not
render clipped or scrolled, and a second HTML document this API server
would have to serve — reopening §1's "no second server" question for no
isolation this slice's threat model needs. Shadow DOM gives the CSS and DOM
encapsulation that is actually required, at none of that cost. An iframe is
not ruled out permanently — a future slice that renders agent-authored HTML
inside a message, for instance, changes the threat model and may need one —
but nothing here requires it.

**Graceful absence.** `attachShadow` is unsupported only on browsers old
enough that a tenant's own site has usually already dropped them; the loader
checks for it and does nothing at all if it is missing, rather than falling
back to unscoped DOM it cannot isolate. A missing widget is a worse outcome
for one visitor than a broken host page for every one of a tenant's
visitors.

### 4. The script tag is the only configuration surface, and supplies two things

```html
<script src="https://dashboard.example/widget.js" data-serviqo-widget-key="wk_…" async></script>
```

The loader reads `document.currentScript` — valid during synchronous
execution of a classic script, `async` or not, per the current
specification — falling back to `document.querySelector("script[data-serviqo-widget-key]")`
for the rare case a page's own tooling clears `currentScript` before this
runs. From that one element it derives **two** independent facts:

- **The widget key**, from `dataset.serviqoWidgetKey` — unchanged from
  ADR-020's snippet.
- **The API's origin**, from `new URL(scriptEl.src).origin` — the origin
  `widget.js` was itself loaded from.

The second is what makes a relative `fetch("/api/v1/widget/session")`
wrong and why it is not used: a relative URL resolves against the *host
page's* origin (the tenant's site), not against wherever `widget.js` came
from, because the fetch executes as part of that page's document. Deriving
the API origin from the script's own `src` — rather than a hardcoded host or
a new build-time environment variable — is the same move ADR-020 §6 already
made ("no environment variable is introduced to name a widget-script host:
there is no host to name yet") applied to the loader's own configuration:
the one fact already present (where this file was fetched from) is reused
rather than duplicated into a second setting that could disagree with it.
It is also what keeps development and production identical in code: in dev
the dashboard and its proxy both live at `:5173`, so a script served from
there yields that origin; in production it yields whatever origin actually
served the file. Nothing in `src/widget/` reads `import.meta.env` or names
`localhost`.

**No widget key, or a script element that cannot be found at all:** the
loader does nothing — no launcher, no error banner on the host page, one
`console.warn` naming the missing attribute and nothing else. A misconfigured
embed is a tenant's mistake to fix in their page source, not a thing that
should paint an error onto their visitors' screens.

### 5. Closing ADR-019 §13's gap: minimal, per-route CORS — not a security change

ADR-019 §13 left the server-side origin decision complete
(`decideOrigin`/`allowedOrigins`, checked on every request, unchanged by this
slice) and withheld only the one thing that makes a cross-origin response
*readable* by the page that requested it: `Access-Control-Allow-Origin`. Its
stated reason for not building this itself was that a **preflight** carries
no body, so it cannot know which tenant's allowlist to answer with.

The resolution: **the preflight does not need to know.** Answering a
preflight with "yes, attempt this" grants nothing by itself — the
tenant-specific decision still happens where ADR-019 built it, inside
`widgetSession.service.ts`, using the `widgetKey` the actual `POST` body
carries. Reflecting the caller's `Origin` is therefore safe at both stages,
for a reason ADR-019 §10 already established about the header itself: "the
header only constrains the one caller that cannot lie about it." A refused
origin still gets `403 WIDGET_SESSION_REFUSED` with the same opaque body
(ADR-019 §12, untouched); this slice only lets the calling page's script
*see* that refusal — or that success — instead of the request silently
failing at the network layer with nothing for the widget to render.

Concretely, `widget.routes.ts` gains one middleware and one route, mounted
on this router **only**:

- `Access-Control-Allow-Origin: <the request's Origin>`, reflected verbatim
  when the header is present, and **never `*`** — set on every response this
  router produces, success or refusal alike, so a refusal is exactly as
  readable as a success (distinguishing them by header presence would itself
  leak information ADR-019 §12 withholds).
- `Vary: Origin`, so nothing between this server and a browser caches one
  tenant's answer and serves it to another's page.
- `Access-Control-Allow-Credentials` is **never sent.** The widget token
  travels in the JSON response body and is never a cookie (§6), so credentialed
  CORS is not merely unneeded here — sending it alongside a reflected origin
  is the specific combination that turns "readable by this one caller" into
  "readable with ambient browser credentials attached," which this endpoint
  has none of to protect but which must not become a habit copied into a
  future one that does.
- `OPTIONS /session` answers the preflight generically: `204`,
  `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: Content-Type`,
  a short `Access-Control-Max-Age`. It performs no database lookup and
  resolves no tenant — there is nothing in a preflight to resolve one from.
- `Cross-Origin-Resource-Policy: cross-origin`, overriding the global
  `same-origin` `securityHeaders()` sets for the rest of the API — exactly
  the carve-out ADR-018 §9 named in advance ("`/api/v1/widget/*` will need
  `cross-origin`") and exactly scoped to where it named it. Staff endpoints
  keep `same-origin`; nothing about `securityHeaders.ts` changes.

**What stays exactly as ADR-019 left it:** `decideOrigin`, the
`allowedOrigins` list, the `widgetSession` rate-limiter class, the opaque
`403`, and the rule that the `Origin` header is "a claim to be checked,
never an input to a lookup." This slice adds a header that controls whether
a browser may *read* an answer the server was always going to give; it does
not change which answer that is.

**Why `application/json` rather than reshaping the request to dodge
preflight entirely** (the other option ADR-019 §13 named — a `text/plain`
body, avoiding the preflight altogether). Handling one generic `OPTIONS`
route is less surface than a second, hand-rolled body parser that
diverges from `express.json()` and `validateBody` for exactly one route, and
the preflight itself costs nothing worth avoiding: it resolves no tenant and
touches no database.

### 6. Token handling: `sessionStorage`, namespaced, never logged

The widget token ADR-019 §8 issued is kept in the browser's `sessionStorage`,
under a key namespaced by the widget key
(`serviqo_widget_token::<widgetKey>`), read once at first open to attempt
resumption and written back after every successful session response.

**Why not a bare in-memory variable.** ADR-019 §6 built the resumable
visitor token specifically so a return visit — or a reload mid-conversation
— reconnects to the same `Customer` rather than silently creating a second
one, calling a token that expires mid-conversation "the worst available
failure, because it looks like it worked." A value held only in a JS closure
is lost on every navigation and every reload, which would make that design
unreachable from the one client that is supposed to exercise it.

**Why not `localStorage`.** The task's own instruction states the default
correctly: prefer memory- or session-scoped handling over persistent storage
unless the architecture requires otherwise, and nothing here requires
otherwise. `sessionStorage` is cleared when the tab closes, which bounds the
token's practical exposure window tighter than its 24-hour `exp` claim does,
at the cost this ADR accepts deliberately: a visitor who closes the tab and
returns tomorrow gets a new anonymous `Customer`, exactly as ADR-019 §6
already specified for that case ("a return visit next week gets a new
customer; durable long-term visitor identity … is a later decision").

**Namespaced by widget key**, not a single fixed key, because a device that
visits two tenants' sites must not let one tenant's stored token be read as
if it belonged to the other — `sessionStorage` is already origin-scoped by
the browser (each tenant site has its own), so this matters only for the
same tenant embedding on two different pages of their own site sharing one
tab's session storage, where it costs nothing and removes a hypothetical
collision.

**Never `console.log`, never assigned to `window`, never included in an
error message.** The loader's error paths report only that a request
failed, matching `widget.session.refused`'s own posture of naming no reason
to the caller (ADR-019 §12) — the widget has even less reason to expose
detail than the server does, since its console is the tenant's own site,
readable by anyone with devtools open.

### 7. The session call is lazy: first open, not page load

`widget.js` mounts the launcher button immediately and unconditionally.
`POST /widget/session` is not called until a visitor opens the panel for
the first time.

ADR-019 §7 fixed that anonymous access is "the default path, not a
fallback" — this extends the same posture one step further: a visitor who
never opens the widget never causes a `Customer` document, and never spends
budget from the `widgetSession` rate-limiter class (ADR-019 §11) that a
future, more deliberate visitor on the same connection might need. Given
that ADR-019 §11 sized that budget for "one session per browser per token
lifetime" rather than for page views, calling it on every page load across
a tenant's site would be the more expensive default for no benefit — nothing
is rendered from the session response before the panel is opened anyway.

### 8. UI states, and the one write the widget makes to a resumed customer

The panel has four states, matching what `widgetSession.service.ts` can
actually return:

- **Loading** — shown from the moment the panel opens until the session
  request settles.
- **Ready** — the session succeeded. Copy is exactly the task's own
  specification: "How can we help?" / "Chat is ready." / "Our support team
  is ready to assist you." A collapsed, optional "Share your name and
  email" control sits below it — filling it and submitting calls
  `POST /widget/session` again, this time with the stored `visitorToken`
  plus `name`/`email`, which `widgetSession.service.ts` resolves as a
  **resume** (ADR-019 §6) that updates the same `Customer` rather than
  creating a second one. Nothing about this is required: ADR-019 §5's rule
  that a supplied value only ever adds, never a lookup key, is respected by
  construction — the widget never reads it back to find anyone.
- **Error** — the request failed, whether refused (`403`) or a transport
  failure. One message, matching the server's own refusal posture: "We're
  having trouble connecting right now. Please try again shortly." with a
  retry action. No status code, no error code, and no server message text
  is rendered — `WIDGET_SESSION_REFUSED`'s body already withholds the
  reason (ADR-019 §12), and the widget adds nothing back.
- **Unavailable** — `attachShadow` missing, or no widget key found (§4);
  nothing renders, so there is no visible state at all, listed here only for
  completeness.

No message composer, no message list, no send action exists anywhere in
this UI. ADR-019 §14's list ("no `Conversation`, no `Message`, no Socket.IO
… no widget UI") is extended by the same boundary in the one direction
this slice touches: a UI now exists, and it still sends nothing a
conversation would need to exist first.

### 9. Idempotent mount, and cleanup as a first-class return value

`initWidget(config)` is the one function that does DOM work, and it is
written to return a `{ destroy() }` handle rather than mutating module-level
state that only it can undo. The bootstrap entry point (`main.ts`) guards
its one call with a marker attribute on `document.body`
(`data-serviqo-widget-mounted`) so a page that includes the snippet twice —
a common copy-paste accident — mounts once. Structuring the mount function
this way, rather than as a top-level side effect, is what makes it directly
unit-testable under `jsdom` without loading the IIFE bundle, and is the seam
a future page-navigation-aware host (a single-page tenant site that injects
the script once but tears down and re-renders its own DOM) would use to
mount and unmount cleanly — not a need this slice has, but a cost of zero to
leave open.

### 10. What this slice does not do

Unchanged from ADR-019 §14, restated because this is the slice that could
most easily have quietly started on them:

- **No `Conversation`, no `Message`, no Socket.IO, no agent inbox, no
  ticketing, no AI.** The widget's "ready" state is the entire feature
  surface; nothing behind it exists yet.
- **No message composer or send action**, even a disabled or "coming soon"
  one — that would render a promise this slice does not keep.
- **No CORS change outside `/api/v1/widget/*`.** The staff API's headers,
  `crossOriginResourcePolicy: same-origin` included, are untouched.
- **No new environment variable.** The widget's API origin is derived from
  its own script tag (§4); nothing configures it separately.
- **No revocable widget token, no key rotation history change.** Both remain
  exactly as ADR-019 §14 and ADR-020 §5 left them.

## Consequences

- The embed snippet ADR-020 shipped now does something: `widget.js` exists,
  is served from the same static host as the dashboard, and a page carrying
  the snippet renders a working launcher and panel.
- `POST /api/v1/widget/session` is reachable from a genuine third-party
  origin for the first time. The security boundary that decides whether it
  should be is exactly the one ADR-019 built and this slice did not touch;
  what changed is only whether a browser may read the answer.
- `/api/v1/widget/*` now diverges from the rest of the API in two header
  policies (`Access-Control-Allow-Origin`, `Cross-Origin-Resource-Policy`),
  both scoped to that one router and both named in advance by ADR-018 §9 and
  ADR-019 §13 as this slice's to make.
- Serviqo carries a second, independent frontend build artifact
  (`apps/web/dist/widget.js`) alongside the dashboard's own, with its own
  Vite config, its own bundle-size discipline, and no dependency on the
  dashboard's component tree.
- The widget's only persisted state is one `sessionStorage` entry per tenant
  widget key, holding a token that already could not be revoked (ADR-019
  §14) and now additionally does not survive a closed tab — a narrower
  exposure window than the token's own `exp` claim provides on its own.
