# Serviqo — Design Direction v2

**Status:** proposal for approval. No implementation until signed off.
**Supersedes:** v1 (navy / electric blue / marketing-led landing page).

---

## 0. What changed and why

v1 designed a *website*. v2 designs a *product* that happens to have a website.

The failure of v1 wasn't the colour alone — it was that the landing page was built out of marketing furniture (huge headline, floating mockup, feature cards) with the product shrunk into a decorative card. In v2 the product screens are designed first, and the landing page is assembled from real product surfaces at real density. Nothing on the marketing site is drawn that doesn't exist in the app.

Three rules govern everything below.

**Rule 1 — One green.**
Emerald is the only chromatic colour in the product. It appears in exactly four roles:
1. the primary action
2. the active selection rail (nav item, conversation row)
3. live / online presence
4. unread

Nowhere else. No emerald backgrounds, no emerald headings, no emerald icons in feature lists. Everything else is warm neutral. This is what makes "use colour sparingly" enforceable instead of aspirational — any emerald pixel that isn't one of those four things is a bug.

**Rule 2 — Filled is human, outlined is machine.**
Your §9 requires AI to never be mistaken for a person. Rather than give AI its own hue (which would break Rule 1), AI is distinguished by *treatment*: human messages are filled surfaces; AI is always an outlined surface on white, with a mono label. The same rule extends to suggestion cards, automation previews and auto-applied tags — anything the machine produced is outlined and labelled, anything a human sent is filled.

**Rule 3 — Borders, not shadows.**
Structure comes from 1px hairlines and background steps. Shadow is reserved for things that genuinely float (dropdown, dialog, toast, widget). This is what separates a mature operational tool from a card-based SaaS dashboard, and it's what lets the agent workspace go dense without becoming noisy.

---

## 1. Colour palette

### Neutrals — warm, very slightly green-shifted

The neutrals are not pure grey. They carry a trace of the brand hue (roughly 80–120° hue at 2–6% saturation), so the off-white reads warm-organic rather than cold-blue, and emerald sits on it without looking pasted on.

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#F7F8F5` | Page background, app shell background |
| `surface` | `#FFFFFF` | Cards, panels, message surfaces, inputs |
| `surface-sunk` | `#F1F3EE` | Inbox column, table headers, customer bubble, code blocks |
| `surface-hover` | `#F3F5F1` | Row hover, ghost button hover |
| `border` | `#E4E7E0` | Default hairline — the workhorse |
| `border-strong` | `#CDD2C8` | Input border, divider needing emphasis |
| `text` | `#17211D` | Primary text, headings |
| `text-secondary` | `#66716B` | Labels, metadata, secondary copy |
| `text-tertiary` | `#8B948D` | Timestamps, placeholders, disabled |
| `text-inverse` | `#F2F5F0` | Text on dark and on emerald |

### Dark surfaces — charcoal-green, not navy

| Token | Hex | Use |
|---|---|---|
| `dark` | `#14201B` | Dark landing sections, dark-mode canvas |
| `dark-2` | `#1B2A24` | Elevated dark surface |
| `dark-3` | `#23342C` | Dark hover |
| `dark-border` | `#2C3D35` | Hairline on dark |

### Brand — emerald

| Token | Hex | Use |
|---|---|---|
| `emerald-50` | `#EFF6F1` | Agent message fill, selected row tint |
| `emerald-100` | `#DCEBE2` | Mint — badges, subtle fills, chart secondary |
| `emerald-200` | `#B9D7C6` | Chart fill, AI card border |
| `emerald-400` | `#3F9873` | Chart mid, hover on dark |
| `emerald-600` | `#14684A` | **Primary.** Buttons, links, active rail |
| `emerald-700` | `#0F5239` | Primary hover / pressed |
| `emerald-900` | `#07301F` | Text on mint fills |

`emerald-600` on white is ~7.1:1 — passes AA for body text and AAA for large. `text-inverse` on `emerald-600` is ~6.9:1.

### Semantic — deliberately warm, deliberately quiet

| Token | Hex | Fill | Use |
|---|---|---|---|
| `success` | `#1E9E6A` | `#E6F5EE` | Online, delivered, resolved, SLA healthy |
| `warning` | `#B0700F` | `#FBF0DD` | SLA at risk, waiting on customer |
| `danger` | `#BE4034` | `#FAEAE8` | SLA breach, urgent, destructive, offline error |
| `neutral` | `#5E6B7A` | `#EFF1F3` | Closed, archived, informational — a desaturated slate, the one non-green accent, used only for "no longer active" states |

**On the green-on-green problem.** Brand emerald (`#14684A`) and status success (`#1E9E6A`) are the same family, which is a real risk in a product where green means both "our brand" and "everything is fine". Three mitigations, all mandatory:

1. **Different weight and shape.** Brand green only ever appears as a *filled control* or a *2px rail*. Status green only ever appears as an *8px dot* or a *tinted pill*. They never occupy the same visual role.
2. **Status is never colour alone.** Every status carries a text label or icon (§53 of the original spec). `● Online`, not `●`.
3. **Priority never uses green at all.** Low priority is `neutral`, not green — so the priority ramp reads neutral → amber → red with no brand collision.

### Channel colours — none

Channel indicators (web, widget, email, WhatsApp, Telegram, API) are **monochrome glyphs in `text-tertiary`**, not brand-coloured logos. A multi-channel inbox that colours each channel turns into a rainbow within a week. Channel identity comes from the glyph shape.

---

## 2. Typography

### Families

| Role | Family | Where |
|---|---|---|
| Product UI | **Inter** (variable) | The entire application. Every screen an agent, admin or customer touches. |
| Marketing display | **Source Serif 4** | Marketing headlines only (h1/h2 on the landing page, section titles). Never inside the product. |
| Data / mono | **IBM Plex Mono** | Ticket IDs, SLA timers, timestamps in audit logs, metric readouts, API snippets, section eyebrows. |

**Why a serif at all.** Your brief asks for trust, maturity, human and premium. A serif headline on warm off-white delivers all four instantly and — importantly — is the single most reliable way to stop the landing page reading as another AI-generated grotesque SaaS page. It is confined to marketing so it never costs us density where density matters.

**Why Inter in the product.** This is software people stare at for eight hours. Inter has the best-tested tabular figures, dense small sizes, and i18n coverage of any free UI face. Distinctiveness in the product should come from layout and restraint, not from a characterful UI font that becomes tiring at 13px.

**Fallback if you'd rather not use a serif:** Instrument Sans at 500 for display, everything else unchanged. Say the word and I'll swap it.

### Scale

Two scales, because marketing and product have different jobs.

**Product scale** — base 14px / 20px line height. Density is a feature.

| Size | Line | Weight | Use |
|---|---|---|---|
| 11 | 16 | 500 | Mono eyebrows, uppercase labels (tracking `.08em`) |
| 12 | 16 | 400/500 | Timestamps, metadata, badges |
| 13 | 18 | 400/500 | Conversation preview, table cells, sidebar fields |
| **14** | **20** | **400/500** | **Base.** Message text, body, inputs, nav |
| 15 | 22 | 500 | Conversation header name, card titles |
| 18 | 24 | 500 | Screen titles |
| 22 | 28 | 500 | Page headers |
| 30 | 36 | 500 | Metric values (tabular) |

**Marketing scale** — base 17px / 28px.

| Size | Line | Family | Weight |
|---|---|---|---|
| 44–52 | 1.08 | Source Serif 4 | 500, tracking `-0.015em` |
| 32–36 | 1.15 | Source Serif 4 | 500 |
| 22 | 1.3 | Inter | 500 |
| 17 | 1.65 | Inter | 400 |
| 11 | 1.4 | IBM Plex Mono | 500, uppercase, tracking `.1em` |

Hero headline caps at **52px**, not 68. Per your §4: the text must not own the screen.

### Numerals

`font-variant-numeric: tabular-nums` globally on the product. Every count, timer, SLA clock and metric must not shift width as it ticks. This is a one-line rule that separates real operational software from mockups.

---

## 3. Component design language

### Spacing and geometry

- **Base unit 4px.** Scale: 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96.
- **Radius:** 4 (badge, chip, small input) · 6 (button, input, select) · 8 (card, panel, dropdown) · 10 (dialog, widget) · 12 (widget launcher / avatar squircle) · full (presence dot, pill, avatar).
  No radius above 12px anywhere in the product. Your "giant rounded cards" note is enforced by the token ceiling.
- **Elevation:**
  `xs` `0 1px 2px rgba(23,33,29,.05)` — resting card, rarely used
  `sm` `0 2px 6px rgba(23,33,29,.07)` — dropdown, popover
  `md` `0 8px 24px rgba(23,33,29,.10)` — dialog, command palette
  `lg` `0 16px 48px rgba(23,33,29,.14)` — chat widget panel
  In-app panels use **borders, not shadows**. Only floating layers cast.

### Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `fast` | 150ms | `cubic-bezier(.2,0,.2,1)` | Hover, focus, colour change |
| `base` | 200ms | `cubic-bezier(.2,.8,.3,1)` | Dropdown, tooltip, message arrival |
| `slow` | 250ms | `cubic-bezier(.2,.8,.3,1)` | Drawer, dialog, panel slide |

Message arrival: 180ms, `translateY(6px)` → 0 plus fade. No scale, no bounce.
Typing dots: 1.2s loop, 3px travel.
Presence transition: 150ms colour cross-fade, never a pulse or ping in the workspace (a room full of pulsing dots is exhausting). Pulse is allowed once, on the marketing page only.
`prefers-reduced-motion` removes all of it and shows final states.

### Buttons

| Variant | Fill | Border | Text |
|---|---|---|---|
| Primary | `emerald-600` | none | `text-inverse` |
| Secondary | `surface` | `border-strong` | `text` |
| Ghost | transparent | none | `text-secondary` → `text` on hover, `surface-hover` bg |
| Danger | `surface` | `danger` | `danger` — solid red fill only inside a confirm dialog |

Heights: 28 (compact/toolbar) · 32 (default in product) · 36 (forms, dialogs) · 44 (marketing CTA).
**One primary per view.** In the agent workspace the primary is the Send button. Nothing else on that screen is emerald-filled.

### Inputs

32px (compact) / 36px (default). `surface` background, `border-strong`, radius 6. Focus = 1px `emerald-600` border + `0 0 0 3px rgba(20,104,74,.12)` ring. Placeholder is `text-tertiary` and shows a real example ("Search conversations, tickets, people…") rather than repeating the label.

### Badges

Height 20, radius 4, 11px mono uppercase, tracking `.06em`.

- **Priority:** `Urgent` danger fill · `High` warning fill · `Medium` surface-sunk · `Low` surface-sunk with `text-tertiary`. Each carries a leading glyph (▲▲ / ▲ / ■ / ▼) so priority survives greyscale and colour-blindness.
- **Status:** tinted fill matching semantic role, always with the word.
- **Channel:** no fill, monochrome glyph + label.
- **AI:** outlined only — 1px `emerald-200` border on white with a spark glyph. Never filled. (Rule 2.)

### Avatars

Squircle (radius 8) at 24 / 28 / 32 / 40. Initials in 500 weight on one of six **desaturated** backgrounds derived from the neutral ramp plus two muted earth tones — no bright random hues. Presence dot 8px, bottom-right, 2px `surface` ring.

### Message bubbles

| Sender | Align | Surface | Border | Radius |
|---|---|---|---|---|
| Customer | left | `surface-sunk` | none | 10, 3 on bottom-left |
| Agent | right | `emerald-50` | none | 10, 3 on bottom-right |
| AI | left | `surface` | 1px `emerald-200` | 10, 3 on bottom-left |
| System | centre | none | hairline rules either side | — |

Max width 68% (agent workspace) / 82% (customer chat). Text 14/20. Meta line below at 11px mono in `text-tertiary`: time, then `✓` sent, `✓✓` delivered, `✓✓` in `emerald-600` read. AI bubbles carry a 11px mono `SERVIQO AI` label above the text with a spark glyph — always, never once per thread.

System events are 11px mono uppercase, centred, `text-tertiary`, with 1px rules on either side: `──── conversation assigned to ananya rao ────`.

### Conversation row (inbox)

64px tall, 12px vertical padding, hairline bottom border. Selected state = `emerald-50` background + 2px `emerald-600` left rail. Hover = `surface-hover`. Layout:

```
[avatar 32] Name ·············· channel glyph  2m
            Last message, truncated to one line   ▲ HIGH  (3)
```

Unread: name goes 500 weight, count pill in `emerald-600`. Everything else stays quiet.

### Tables

Row height 40 (compact 36). Hairline row borders, no zebra striping, no vertical borders. Header row `surface-sunk`, 11px mono uppercase `text-secondary`, sticky. Numeric columns right-aligned and tabular. Row hover `surface-hover`, entire row is the click target.

### Dropdowns, dialogs, tooltips, tabs

- **Dropdown:** `surface`, 1px border, radius 8, shadow `sm`, 4px padding, items 32px, 13px. Opens in 200ms with 4px translate.
- **Dialog:** 480 / 560 / 720 width, radius 10, shadow `md`, backdrop `rgba(23,33,29,.32)`. Title 18/500, body 14, actions bottom-right, primary on the right.
- **Tooltip:** `dark` fill, `text-inverse`, 12px, radius 4, 6/8 padding, 400ms delay.
- **Tabs:** underline style only — 2px `emerald-600` bottom border on the active tab, `text-secondary` → `text`. No pill tabs, no filled tabs.

### Empty states and skeletons

- **Empty state:** 20px `text` headline naming the space, 14px `text-secondary` line, one action. An invitation, not an apology. *"Nothing assigned to you / New conversations routed to your departments will appear here. / Take one from Unassigned"* — never "No data".
- **Skeleton:** `surface-sunk` blocks, radius 4, a 1.4s opacity pulse between .55 and 1. **No shimmer sweep** — shimmer is the single most reliable "AI-generated dashboard" tell. Skeletons mirror the exact layout they replace, including row heights.
- **Toast:** bottom-right (bottom-centre on mobile), `surface`, 1px border, shadow `sm`, 14px, 4s. Leading semantic glyph. Errors get a Retry action inline. 250ms slide.

### Connection quality (§20)

A single strip beneath the conversation header, 28px tall, animating in at 200ms.

- Connected: **no indicator.** Silence is the healthy state.
- Reconnecting: `warning` fill, `Reconnecting…` with a 3-dot mono ellipsis.
- Offline: `danger` fill, `You're offline. Messages will send when the connection returns.`
- Recovered: `success` fill, `Connected`, auto-dismiss after 2s.

Queued messages sit in the thread at 55% opacity with a mono `queued` meta and a Retry affordance after 10s.

---

## 4. Landing page wireframe

Structure follows your §22 exactly. The rule throughout: **every section shows a real product surface**; no section is three icon cards.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ◆ SERVIQO   Product ▾  Solutions ▾  AI Agent  Integrations  Resources ▾  Pricing│
│                                                        Sign in   [Get started]  │  64px, canvas bg,
└────────────────────────────────────────────────────────────────────────────────┘   hairline on scroll

        ─ mono eyebrow ─  REAL-TIME CUSTOMER SERVICE PLATFORM

        Customer support, connected.                        ← Source Serif, 52px
                                                              max-width 640px
        Talk to customers. Resolve issues. Build better
        relationships. Serviqo brings live conversations,
        AI assistance, tickets and your support team into
        one organised workspace.                            ← Inter 17px, 60ch

        [Start supporting customers]  [Explore the platform]

        Real-time messaging · AI + human support · Built for teams   ← 12px mono

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  THE DEMONSTRATION — full-bleed panel, 1240px, canvas→surface step       │
   │                                                                          │
   │   ┌─ CUSTOMER ────────┐   ·······│·······   ┌─ SUPPORT TEAM ───────────┐│
   │   │ ◆ Acme Support    │      one conversation │ INBOX │ CONVERSATION    ││
   │   │ ● Online          │      two views        │       │                 ││
   │   ├───────────────────┤                       ├───────┼─────────────────┤│
   │   │ AI  Hi! How can   │  ←── same message ──→ │Yaswant│ Yaswanth Kumar  ││
   │   │     we help?      │      appears in both  │Payment│ ● Online        ││
   │   │                   │      panes at the     │2m HIGH│                 ││
   │   │      My payment   │      same instant     │       │ AI  Hi! How can ││
   │   │      didn't apply │                       │Priya  │     we help?    ││
   │   │                   │                       │Refund │                 ││
   │   │ AI  I can check   │                       │7m     │  My payment…    ││
   │   │     that for you  │                       │       │                 ││
   │   │  ·····typing·····│                       │       │ ─ assigned ─    ││
   │   ├───────────────────┤                       ├───────┴─────────────────┤│
   │   │ [+] Type…      ➤  │                       │ Type a reply…        ➤  ││
   │   └───────────────────┘                       └─────────────────────────┘│
   │        390px wide                                    ~760px wide          │
   └──────────────────────────────────────────────────────────────────────────┘

   ── UNIFIED INBOX ──────────────────────────────────────────────────────────
   Copy left (max 44ch) │ Real inbox column at real density, 6 rows,
                        │ filter chips live: All · Mine · Unassigned · AI Handling
                        │ channel glyphs visible on every row

   ── AI + HUMAN ─────────────────────────────────────────────────────────────
   Conversation excerpt showing the handoff: AI bubbles (outlined) → system
   event → agent bubble (filled). Right: the private AI brief panel.
   Caption: "Serviqo AI drafts. A person decides."

   ── TICKETING ──────────────────────────────────────────────────────────────
   Ticket panel as it appears inside the conversation sidebar — not a form.
   #SRV-10482 · In Progress · High · Billing · Ananya Rao · SLA 18m remaining

   ── AUTOMATION ─────────────────────────────────────────────────────────────
   The WHEN / IF / THEN rule card, rendered as the real builder.

   ── KNOWLEDGE BASE ─────────────────────────────────────────────────────────
   In-conversation article search: agent types "/kb payment", results inline.

   ── ANALYTICS ──────────────────────────────────────────────────────────────
   Two-tone chart (emerald-600 / emerald-200) + four metric readouts.
   Deliberately restrained — one chart, not a dashboard wall.

   ── WEBSITE WIDGET ─────────────────────────────────────────────────────────
   A faux browser frame with the launcher bottom-right and the panel open.
   Three lines of install snippet in mono beneath.

   ── SECURITY & RELIABILITY ─────────────────────────────────────────────────
   Dark section (#14201B). Six items, hairline-separated rows, no cards.
   One audit-log line in mono as proof.

   ── INTEGRATIONS ───────────────────────────────────────────────────────────
   Monochrome channel glyphs in a single row. Roadmap items labelled honestly.

   ── FINAL CTA ──────────────────────────────────────────────────────────────
   Dark band. Serif headline, two buttons, demo credentials in mono.

   ── FOOTER ─────────────────────────────────────────────────────────────────
   5 columns, 13px links, hairline top border.
```

**Navigation detail.** Product and Solutions open a mega-panel, not a list: 2 columns, each item is title + one-line description + monochrome glyph.

```
┌ PRODUCT ─────────────────────────────────┬ SOLUTIONS ────────────────┐
│ Live Chat        Talk in real time       │ Customer support          │
│ Team Inbox       One queue, every channel│ Technical support         │
│ Ticketing        Follow-through with SLAs│ E-commerce                │
│ AI Support Agent Answers the routine ones│ SaaS                      │
│ Automation       Routing and rules       │ Financial services        │
│ Knowledge Base   Answers people can find │                           │
│ Analytics        What your queue is doing│                           │
└──────────────────────────────────────────┴───────────────────────────┘
```

---

## 5. Agent workspace wireframe

The most important screen. Four columns, designed as an operational surface — no cards, no page padding, no rounded panels floating in space. Panels are separated by hairlines and meet the viewport edges.

**Widths:** nav 216 · inbox 336 · conversation flex (min 480) · customer 320. Total minimum 1352px for four columns.

```
┌─────────────┬──────────────────────┬────────────────────────────────┬────────────────────┐
│ ◆ Serviqo   │ Inbox                │ ● Yaswanth Kumar               │ Yaswanth Kumar     │
│             │ [⌕ Search…]      [⚙] │   Online · Billing · ▣ Widget  │ Customer since 2024│
│ ▸ Inbox  20 ├──────────────────────┼────────────────────────────────┤                    │
│   Tickets 8 │ All Mine Unassigned  │ ──────── Today ────────        │ ⌁ TICKET           │
│   People    │ Waiting  AI  Priority│                                │ #SRV-10482         │
│   Knowledge │──────────────────────│ CUSTOMER                       │ Payment not credit.│
│   Reports   │▌◍ Yaswanth K.  ▣  2m │ My payment was deducted but my │ In Progress · High │
│             │  Payment not credited│ wallet still shows zero.       │ Billing · Ananya   │
│             │  ▲ HIGH          (2) │ 12:41                          │ ◷ SLA 18m left     │
│             │──────────────────────│                                │ [View ticket]      │
│             │ ◍ Priya M.     ✉  7m │ ┌ SERVIQO AI ─────────────────┐│────────────────────│
│             │  Refund request      │ │ I found a matching article  ││ ⌁ SERVIQO AI       │
│             │  ■ MEDIUM            │ │ on payment reconciliation.  ││ Summary            │
│             │──────────────────────│ │ Would you like me to walk   ││ ₹2,400 paid, not   │
│             │ ◍ Daniel K.    ◆ 18m │ │ you through it?             ││ reflected in wallet│
│             │  SSO configuration   │ └─────────────────────────────┘│                    │
│             │  ▼ LOW               │ 12:41                          │ Intent             │
│             │──────────────────────│                                │ Payment reconcil.  │
│             │ ◍ Marco S.     ▣ 24m │ ── conversation assigned to ── │ Sentiment          │
│             │  Plan change         │ ──────  ananya rao  ────────── │ Concerned          │
│             │  ■ MEDIUM            │                                │ Confidence 92%     │
│             │                      │                     AGENT      │                    │
│             │                      │ I've checked your transaction. │ Suggested reply    │
│             │                      │ Let me verify with billing.    │ ┌────────────────┐ │
│             │                      │                12:43 ✓✓        │ │ Preview…       │ │
│             │                      │                                │ └────────────────┘ │
│             │                      │                                │ [Insert reply]     │
│─────────────│                      │────────────────────────────────│ Knowledge used     │
│ ◍ Ananya R. │                      │ Reconnecting…        (warning) │ Payment Recon. Pol.│
│ ● Available │                      │────────────────────────────────│────────────────────│
│         [▾] │                      │ [+][☺][/] Type a reply…    [➤] │ ⌁ PROFILE          │
│             │                      │ ⌐ Reply  ⌐ Internal note       │ Email · Phone · ID │
│             │                      │                                │ Tags: VIP Payment  │
│             │                      │                                │ 14 conversations   │
└─────────────┴──────────────────────┴────────────────────────────────┴────────────────────┘
```

Decisions worth calling out:

- **Reply vs Internal note is a tab under the composer**, not a toggle or a mode. The composer background changes to `warning` tint in note mode so it is impossible to send an internal note to a customer by accident. Server enforces it regardless (§21 of the original spec).
- **The right column is stacked panels, not tabs.** Ticket, AI, Profile, History in that order — because that's the order an agent needs them. Each collapses; state persists per agent.
- **Agent presence control lives at the bottom of the nav**, next to their own name, because it's about them, not about the queue.
- **Channel glyph sits on the conversation row and in the header**, monochrome. One inbox, many doors.
- **No dashboard on the agent's home.** Opening Serviqo as an agent lands you in the inbox with the oldest waiting conversation pre-selected. Agents don't want a welcome screen.
- **Density:** 64px conversation rows, 40px table rows, 20px badges, 32px controls. Roughly 12 conversations visible at 900px height without scrolling.

**Keyboard.** `⌘K` command palette · `j/k` move through inbox · `⌘↵` send · `⌘⇧N` internal note · `⌘⇧A` assign · `e` resolve · `/` knowledge search. An eight-hour tool that requires a mouse is a broken tool.

---

## 6. Customer chat wireframe

Two forms of the same surface: full-page (mobile-first, at `/support`) and the embeddable widget. Neither shows a single enterprise control.

### Full page / mobile

```
┌──────────────────────────────────┐
│ ← ◆  Customer Support            │  56px header, surface,
│      ● Online · replies instantly│  hairline bottom
├──────────────────────────────────┤
│                                  │
│ ─────── Today ───────            │
│                                  │
│ ┌ SERVIQO AI ──────────────────┐ │  outlined = machine
│ │ Hello 👋 Welcome to Acme     │ │
│ │ Support. How can we help?    │ │
│ └──────────────────────────────┘ │
│ 12:38                            │
│                                  │
│ [Track an order] [Payment issue] │  quick replies:
│ [Technical] [Talk to someone]    │  36px pills, secondary
│                                  │
│              ┌─────────────────┐ │
│              │ I need help with│ │  filled emerald-50
│              │ my payment.     │ │  = the customer
│              └─────────────────┘ │
│                     12:40 ✓✓     │
│                                  │
│ ┌ SERVIQO AI ──────────────────┐ │
│ │ I'll help with that. Can you │ │
│ │ share the transaction ID?    │ │
│ └──────────────────────────────┘ │
│                                  │
│ ─── connecting you with billing ─│  system, centred mono
│ ─── ananya joined ───────────────│
│                                  │
│ ┌──────────────────────────────┐ │  filled surface-sunk
│ │ ◍ Hi Yaswanth, I've got your │ │  = a human
│ │   transaction open now.      │ │
│ └──────────────────────────────┘ │
│   Ananya · Billing · 12:43       │
│                                  │
├──────────────────────────────────┤
│ [+]  Type your message…    [🎤][➤]│  56px composer,
└──────────────────────────────────┘  safe-area padded
```

**Deliberate omissions from the customer view:** no ticket number, no priority, no SLA timer, no department picker, no status dropdown, no agent rating widget mid-conversation. The customer sees a conversation. Everything operational is on the other side of the glass.

The customer *does* see: who they're talking to and whether that's a person or the assistant, whether it's online, whether their message sent, and how to attach a file. Nothing else.

**Attachments:** `+` opens photo / file / document. Voice message is press-and-hold on the mic. Upload shows a determinate progress ring on the bubble, not a separate modal.

### Widget (§7)

```
    Website                                    ┌─────────────────────────┐
                                               │ ◆ Acme Support      – ✕ │  emerald-600 header
                                               │ ● We're online          │  ONLY place the brand
                                               ├─────────────────────────┤  colour fills a surface
                                               │ Hi Yaswanth 👋          │
                                               │ How can we help today?  │
                     ┌───┐                     │                         │
                     │ 💬│  ← 56px launcher,   │ [Track an order]        │  quick actions,
                     └───┘    emerald-600,     │ [Payment issue]         │  full-width, 40px,
                              radius 12,       │ [Technical support]     │  secondary style
                              shadow lg        │ [Talk to someone]       │
                                               │                         │
                                               │ ─ Recent ─              │
                                               │ ◍ Ananya · 2d           │  past conversations
                                               │   Refund processed      │  if identified
                                               ├─────────────────────────┤
                                               │ [+] Type a message… [➤] │
                                               ├─────────────────────────┤
                                               │      Powered by Serviqo │  11px, tertiary
                                               └─────────────────────────┘
                                                 380 × 600, radius 10,
                                                 shadow lg, 24px from edge
```

Launcher shows an unread count badge. Opens 250ms with 8px translate + fade, origin bottom-right. On mobile it becomes a full-screen sheet with a drag-handle, never a shrunken 380px panel.

---

## 7. Admin wireframe

Deliberately a different shape from the agent workspace, so nobody confuses configuring the product with operating it. Two columns, top page header, content max-width 1080. Settings-application feel: forms, tables, hairlines.

```
┌────────────────────┬──────────────────────────────────────────────────────────┐
│ ◆ Serviqo  Admin   │  Routing                                    [Save changes]│
│                    │  How conversations reach the right team.                  │
│ Overview           ├──────────────────────────────────────────────────────────┤
│ Team               │  Assignment  ·  Departments  ·  Business hours  ·  Queue  │  underline tabs
│ Departments        │──────────────────────────────────────────────────────────│
│ ▸ Routing          │                                                          │
│ Automation         │  ASSIGNMENT METHOD                                       │  11px mono
│ AI Agent           │  ○ Manual — a supervisor assigns each conversation       │
│ Knowledge          │  ● Automatic — Serviqo picks an available agent          │
│ Channels           │                                                          │
│ SLA                │  Order of consideration        (drag to reorder)         │
│ Analytics          │  ⠿ 1  Department match                                   │
│ Security           │  ⠿ 2  Skill match                                        │
│ Audit Logs         │  ⠿ 3  Lowest active conversation count                   │
│ Settings           │  ⠿ 4  Round robin                                        │
│                    │                                                          │
│                    │  Maximum concurrent conversations per agent   [  6  ]    │
│                    │  Reassign if unanswered after               [ 90 ] sec   │
│                    │                                                          │
│                    │  ─────────────────────────────────────────────────────   │
│                    │  DEPARTMENTS                              [Add department]│
│                    │  ┌──────────────┬────────┬──────────┬────────┬─────────┐ │  40px rows,
│                    │  │ Department   │ Agents │ Open      │ SLA    │         │ │  hairlines,
│                    │  │ Billing      │ 6      │ 24        │ Tier 1 │  Edit   │ │  no zebra
│                    │  │ Technical    │ 9      │ 41        │ Tier 1 │  Edit   │ │
│                    │  │ Refunds      │ 3      │ 12        │ Tier 2 │  Edit   │ │
│                    │  └──────────────┴────────┴──────────┴────────┴─────────┘ │
└────────────────────┴──────────────────────────────────────────────────────────┘
```

### Automation builder (§16)

Rules are read as sentences, not built on a node canvas. A node graph is the wrong tool for support routing — it's harder to scan, harder to audit, and nobody debugs a support rule at 2am by dragging boxes.

```
┌──────────────────────────────────────────────────────────────┐
│  Rule name  [ Route billing to specialists           ]  ●On  │
├──────────────────────────────────────────────────────────────┤
│  WHEN                                                        │  11px mono,
│  ┌────────────────────────────────────────────────────────┐  │  text-secondary
│  │ A new conversation arrives                        ▾    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  IF   all of these are true                            ▾     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Department        is       Billing              ▾   ✕  │  │
│  │ Customer language is       English              ▾   ✕  │  │
│  └────────────────────────────────────────────────────────┘  │
│  [+ Add condition]                                           │
│                                                              │
│  THEN                                                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ➤ Assign to        Billing Team                 ▾   ✕  │  │
│  │ ➤ Send message     Welcome — billing template   ▾   ✕  │  │
│  │ ➤ Allow AI to      answer first                 ▾   ✕  │  │
│  └────────────────────────────────────────────────────────┘  │
│  [+ Add action]                                              │
├──────────────────────────────────────────────────────────────┤
│  Matched 214 conversations in the last 7 days   [Save rule]  │  dry-run preview
└──────────────────────────────────────────────────────────────┘
```

The dry-run count is the feature that makes this trustworthy — you see what a rule *would have* done before enabling it.

### Analytics (§17)

Restrained. Four metric readouts in a hairline-separated row, then **one** chart at a time with a selector — never a wall of tiles. Charts use `emerald-600` for the primary series and `emerald-200` for comparison, `neutral` for a benchmark line. No legends where a direct label will do. No pie charts.

```
Conversations  1,284      Resolution  92.4%      First response  00:41      CSAT  4.7
+8% vs last week          +1.2pt                 −6s                        ▲ 0.1

[Volume ▾]  [Last 7 days ▾]                                    [Export CSV]
 ▁▃▅▇█▆▄▂▃▅▇█▆▄  ← single emerald series, hairline gridlines, no fill gradient
```

AI-specific metrics get their own row because they answer a different question: **AI resolution rate**, **human handoff rate**, **handoff reason breakdown**, **AI-assisted first response time**.

---

## 8. AI agent interaction flow

The whole flow rests on one commitment: **the assistant drafts, a person decides.** It has no write access to anything consequential.

```
CUSTOMER OPENS CHAT
        │
        ▼
┌─────────────────────┐
│ Serviqo AI greets   │  outlined bubble, labelled SERVIQO AI
│ + quick actions     │  customer can skip straight to "Talk to someone"
└─────────┬───────────┘
          ▼
    Customer describes the problem
          │
          ▼
┌─────────────────────────────────────────┐
│ AI classifies: intent · sentiment ·     │  never shown to the customer
│ department · confidence                 │
└─────────┬───────────────────────────────┘
          │
    ┌─────┴──────────────────────────────────────┐
    │                                            │
 CONFIDENT + SAFE                        ESCALATE — any one of:
    │                                     · confidence below threshold
    ▼                                     · negative / very negative sentiment
┌────────────────────┐                    · customer asks for a person
│ AI answers, cites  │                    · sensitive intent: refund, payment,
│ a KB article       │                      account deletion, security, legal,
└────────┬───────────┘                      anything touching money or identity
         │                                · business hours: none — AI still
   Resolved?                                escalates, into a ticket
    │        │                                     │
   yes       no ────────────────────────────────► ▼
    │                                    ┌──────────────────────────────┐
    ▼                                    │ AI: "I'd like one of our     │
┌──────────────┐                         │ payment specialists to take  │
│ CSAT prompt  │                         │ a closer look. I'm           │
│ ★★★★★        │                         │ transferring you now — you   │
└──────────────┘                         │ won't need to explain again."│
                                         └──────────┬───────────────────┘
                                                    ▼
                                    ── connecting you with billing support ──
                                                    │
                                    ┌───────────────┴────────────────┐
                                    │ agent available?               │
                                    │  yes → ── ananya joined ──     │
                                    │  no  → queue position + ETA,   │
                                    │        or ticket + email if    │
                                    │        outside business hours  │
                                    └───────────────┬────────────────┘
                                                    ▼
                              ┌──────────────────────────────────────────┐
                              │ AGENT'S PRIVATE BRIEF (right column)     │
                              │ never visible to the customer            │
                              │                                          │
                              │ Summary    "Customer reports a ₹2,400    │
                              │            payment not reflected in      │
                              │            their wallet."                │
                              │ Intent     Payment reconciliation        │
                              │ Sentiment  Concerned                     │
                              │ Suggested  Verify transaction status     │
                              │ action                                   │
                              │ Suggested  [Preview] [Insert reply]      │
                              │ reply      ← inserts into composer,      │
                              │              never sends                 │
                              │ Knowledge  Payment Reconciliation Policy │
                              │ used                                     │
                              │ Confidence 92%                           │
                              └──────────────────────────────────────────┘
```

**Guardrails, restated as product behaviour:**

- `Insert reply` puts text in the composer and focuses it. There is no "send" path from any AI surface. The agent must press Send.
- The assistant cannot issue refunds, change passwords, delete accounts, read payment credentials, close a critical ticket, or change a ticket's priority. It *suggests* classification and priority; a human applies them, and applied-from-AI is recorded in the ticket activity trail.
- Every AI artefact is stamped: which model, which knowledge sources, what confidence, at what time. It appears in the audit log alongside human actions.
- Confidence is shown to **agents and admins only**. Showing a customer "92% confident" invites them to distrust a correct answer.
- If the assistant is disabled for an organisation, every one of these surfaces disappears cleanly — no empty panels, no disabled buttons. The AI column is optional by architecture.

---

## 9. Responsive strategy

Breakpoints: `360 · 640 · 768 · 1024 · 1280 · 1440`.

### Customer chat and widget — mobile-first

| Width | Behaviour |
|---|---|
| ≥768 | Widget panel 380×600, anchored bottom-right, 24px inset |
| <768 | Full-screen sheet, 100dvh, drag handle, `env(safe-area-inset-bottom)` on the composer |
| 360 | Bubbles to 88% max width, quick-reply pills wrap to full width, composer 52px |

The composer is anchored with `dvh` units so it survives the mobile keyboard. The thread scroll container keeps the last message pinned on keyboard open. Attachments use the native picker.

### Agent workspace — desktop-first, but genuinely responsive

Not a shrunken four-column layout. Each breakpoint is a different information architecture.

| Width | Layout |
|---|---|
| ≥1440 | Four columns: nav 216 · inbox 336 · conversation flex · customer 320 |
| 1280–1439 | Three columns. Customer panel becomes a right drawer, opened by the header avatar, 320 wide, 250ms slide, overlays the conversation |
| 1024–1279 | Nav collapses to a 56px icon rail with tooltips. Inbox 300. Customer stays a drawer |
| 768–1023 | **Two panes:** inbox (340) + conversation. Nav becomes an overlay drawer from the hamburger. Customer is a drawer |
| <768 | **List → detail stack.** One pane at a time. Inbox is the root; tapping a conversation pushes the thread with a back button; the customer panel is a bottom sheet. Bottom tab bar: Inbox · Tickets · Search · Me |

The mobile agent view is scoped deliberately: read, reply, assign, resolve, add a note. Configuration, analytics and bulk actions are desktop-only and say so rather than rendering a broken table.

### Admin — responsive, low priority

Two columns above 1024. Below that the nav collapses to a top select and content goes single-column. Wide tables get a horizontal scroll container with the first column sticky, never a card-per-row transformation.

### Accessibility floor (non-negotiable, applies everywhere)

- Every status carries text or an icon, never colour alone.
- Focus is always visible: 1px `emerald-600` + 3px 12%-alpha ring.
- Full keyboard operation of the agent workspace, including the composer, inbox navigation and all dialogs.
- Live regions announce incoming messages and connection changes.
- Contrast: 4.5:1 body, 3:1 UI boundaries and large text.
- `prefers-reduced-motion` disables all transitions and animation.
- Target size 44px on all touch surfaces.

---

## 10. Open decisions for you

1. **Serif or not** for marketing display — Source Serif 4 (recommended) vs Instrument Sans.
2. **Emerald depth** — `#14684A` as specified, or one step brighter at `#17805A` if it reads too conservative in the swatches.
3. **Agent mobile scope** — is read/reply/assign/resolve the right cut, or do you want tickets fully editable on mobile too?
4. **Widget header** — emerald-filled (as drawn, the only filled-brand surface in the system) or white with a hairline. Filled is warmer and more identifiable on a third-party site; white is more restrained.
5. **Dark mode** — build it into the token layer now (recommended, roughly 15% extra work) or defer to Phase 7?

---

## 11. What gets built once approved

In order, nothing skipped:

1. `packages/ui` token layer — colour, type, spacing, radius, shadow, motion as CSS variables plus a Tailwind theme.
2. Primitives — button, input, select, badge, avatar, tooltip, dropdown, dialog, tabs, table, toast, skeleton, empty state.
3. Support components — message bubble, conversation row, presence dot, channel glyph, SLA timer, AI card.
4. A component gallery route so the system can be reviewed in one place before any screen is assembled.
5. Screens, in this order: customer chat → widget → agent workspace → admin → landing page.

The landing page is built **last**, from the finished components. That inversion is the main structural fix from v1.
