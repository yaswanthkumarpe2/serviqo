import { Button } from "@/components/ui/Button";

import { ChatIcon, ClockIcon, CodeIcon, PeopleIcon } from "./workspaceIcons";

import type { WorkspaceOverviewState } from "./useWorkspaceOverview";
import type { InboxConversation } from "@/features/inbox/inboxApi";
import type { WorkspaceView } from "./workspaceViews";

/**
 * The workspace landing view (ADR-033 §4).
 *
 * Presentation only — every figure and every row comes from
 * `useWorkspaceOverview`, which derives them from one real request
 * (CONTRIBUTING.md: "No business logic in JSX").
 *
 * Every number on this page is REAL, and where a number cannot be exact the
 * page says so rather than rounding the truth. The server pages
 * conversations, so a tenant past one page gets "25+" and a footnote instead
 * of a confident total — the alternative is a figure that is quietly wrong
 * for exactly the tenants big enough to care.
 *
 * What is deliberately ABSENT is as considered as what is here. There is no
 * "avg. response time" card, because computing it needs per-message timing
 * the API does not expose and no figure at all beats a plausible invented
 * one. There is no notification centre, because nothing generates
 * notifications yet.
 */

interface WorkspaceOverviewProps {
  overview: WorkspaceOverviewState;
  onNavigate: (view: WorkspaceView) => void;
  /** Opens a specific conversation in the chats view. */
  onOpenConversation: (conversationId: string) => void;
}

export function WorkspaceOverview({ overview, onNavigate, onOpenConversation }: WorkspaceOverviewProps) {
  const { counts, isComplete } = overview;

  /** "25" when the page is the whole tenant, "25+" when more exist behind it. */
  const figure = (value: number) => (isComplete || value === 0 ? String(value) : `${value}+`);

  return (
    <>
      {overview.isForbidden ? (
        /*
          The reader's role lacks `conversation.read`. Its own state, not an
          error: retrying cannot help, and the rest of the workspace — their
          team, the widget — is still theirs to use.
        */
        <p className="ws__notice" role="status">
          Your role does not include access to this organization&rsquo;s conversations. Everything else in the
          workspace is still available to you.
        </p>
      ) : overview.error !== null ? (
        <p className="ws__alert" role="alert">
          {overview.error}
        </p>
      ) : (
        <>
          <section className="ws__section" aria-labelledby="ws-quick-heading">
            <div className="ws__sectionHead">
              <h2 className="ws__sectionTitle" id="ws-quick-heading">
                Quick access
              </h2>
              {/*
                Refresh lives here rather than beside the greeting: it reloads
                THESE figures, and a control sitting next to a person's name
                reads as refreshing their account.
              */}
              <button
                type="button"
                className="ws__link"
                onClick={overview.reload}
                disabled={overview.isRefreshing}
              >
                {overview.isRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            <div className="ws__quick">
              <QuickCard
                icon={<ChatIcon aria-hidden="true" />}
                label="My chats"
                meta={overview.isLoading ? "—" : `${figure(counts.mine)} assigned to you`}
                onClick={() => onNavigate("chats")}
              />
              <QuickCard
                icon={<ClockIcon aria-hidden="true" />}
                label="Open"
                meta={overview.isLoading ? "—" : `${figure(counts.open)} awaiting a reply`}
                onClick={() => onNavigate("chats")}
              />
              <QuickCard
                icon={<PeopleIcon aria-hidden="true" />}
                label="Contacts"
                meta={overview.isLoading ? "—" : `${figure(counts.contacts)} people`}
                onClick={() => onNavigate("contacts")}
              />
              <QuickCard
                icon={<CodeIcon aria-hidden="true" />}
                label="Install"
                meta="Widget snippet"
                onClick={() => onNavigate("settings")}
              />
            </div>
          </section>

          <div className="ws__columns">
            <section className="ws__panel" aria-labelledby="ws-recent-heading">
              <div className="ws__panelHead">
                <h2 className="ws__sectionTitle" id="ws-recent-heading">
                  Recent conversations
                </h2>
                {overview.conversations.length > 0 && (
                  <button type="button" className="ws__link" onClick={() => onNavigate("chats")}>
                    View all
                  </button>
                )}
              </div>

              {overview.isLoading ? (
                <p className="ws__muted" role="status">
                  Loading conversations…
                </p>
              ) : overview.conversations.length === 0 ? (
                /*
                  The state a new workspace is actually in, and the one the
                  mockup never showed. It names the reason the list is empty
                  and points at the action that changes it, rather than
                  rendering invented rows to look busy.
                */
                <div className="ws__empty">
                  <p className="ws__emptyTitle">No conversations yet</p>
                  <p className="ws__muted">
                    They appear here the moment a visitor writes in from your website. Install the widget to open
                    that door.
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => onNavigate("settings")}>
                    Install the widget
                  </Button>
                </div>
              ) : (
                <ul className="ws__convoList">
                  {overview.conversations.slice(0, 6).map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      onOpen={() => onOpenConversation(conversation.id)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="ws__panel" aria-labelledby="ws-activity-heading">
              <div className="ws__panelHead">
                <h2 className="ws__sectionTitle" id="ws-activity-heading">
                  This organization
                </h2>
              </div>

              <div className="ws__stats">
                <Stat value={overview.isLoading ? "—" : figure(counts.total)} label="Conversations" />
                <Stat value={overview.isLoading ? "—" : figure(counts.open)} label="Open" />
                <Stat value={overview.isLoading ? "—" : figure(counts.closed)} label="Closed" />
                <Stat value={overview.isLoading ? "—" : figure(counts.unassigned)} label="Unassigned" />
              </div>

              {/*
                The footnote that keeps the figures honest. Shown only when
                the server said there is another page, which is the only case
                where these are counts rather than totals.
              */}
              {!overview.isLoading && !overview.isComplete && (
                <p className="ws__note">
                  Counted over the most recent conversations — this organization has more than one page of them.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function QuickCard({
  icon,
  label,
  meta,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ws__quickCard" onClick={onClick}>
      <span className="ws__quickIcon">{icon}</span>
      <span className="ws__quickLabel">{label}</span>
      <span className="ws__quickMeta">{meta}</span>
    </button>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="ws__stat">
      <div className="ws__statValue">{value}</div>
      <div className="ws__statLabel">{label}</div>
    </div>
  );
}

/**
 * One conversation, as a row.
 *
 * A button rather than a link: it selects a thread inside the app, it does not
 * navigate to an address, and a link to `#` is a promise the URL does not
 * keep.
 */
function ConversationRow({ conversation, onOpen }: { conversation: InboxConversation; onOpen: () => void }) {
  const title = conversationTitle(conversation);

  return (
    <li>
      <button type="button" className="ws__convo" onClick={onOpen}>
        <span className="ws__convoAvatar" aria-hidden="true">
          {initials(title)}
        </span>
        <span className="ws__convoBody">
          <span className="ws__convoTop">
            <span className="ws__convoName">{title}</span>
            <span className="ws__convoTime">{relativeTime(conversation.lastMessageAt)}</span>
          </span>
          <span className="ws__convoPreview">
            {conversation.status === "closed" ? "Closed" : conversation.assignedTo === null ? "Unassigned" : "Assigned"}
            {" · "}
            {conversation.customer?.email ?? "no address given"}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * A conversation's display name — the customer's, or an honest stand-in.
 *
 * The same three-step fallback the inbox uses, and deliberately the same
 * wording: one conversation must not be "Anonymous visitor" in one panel and
 * "Unknown" in another.
 */
function conversationTitle(conversation: InboxConversation): string {
  const customer = conversation.customer;
  if (customer === null) return "Unknown customer";
  return customer.name ?? customer.email ?? "Anonymous visitor";
}

/** Up to two letters, for the avatar. Never more — three is a word, not a mark. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/**
 * "2m", "18m", "4h", "Yesterday", then a date.
 *
 * Guarded rather than trusted: the string comes off the wire, and
 * `toLocaleDateString` on an invalid date renders the literal "Invalid Date"
 * into the row.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 172_800) return "Yesterday";
  return new Date(then).toLocaleDateString();
}
