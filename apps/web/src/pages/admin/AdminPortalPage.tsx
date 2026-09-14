import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { AddAgentForm } from "@/features/admin/AddAgentForm";
import { AgentInbox } from "@/features/inbox/AgentInbox";
import { TeamManagement } from "@/features/team/TeamManagement";
import { useCurrentUser } from "@/features/auth/useCurrentUser";
import { usePlatformConsole } from "@/features/admin/usePlatformConsole";
import { useAuth } from "@/features/auth/useAuth";

import type { CurrentUser } from "@/features/auth/authApi";
import type { PlatformOrganizationSummary, PlatformUserSummary } from "@/features/admin/adminApi";

import "./AdminPortalPage.css";

/**
 * The operations console (ADR-032 §12).
 *
 * Read-only, and that is the whole slice rather than a stage of it. It answers
 * the questions an operator actually has on a live platform — how many tenants
 * exist, which of them can receive widget traffic, which accounts are stuck
 * unverified, how much conversation volume is flowing — and it cannot change
 * any of them. Disabling an account and deleting a tenant each deserve their
 * own audit trail and their own argument; shipping them beside a dashboard
 * would smuggle them in without either.
 *
 * The PLATFORM API it reads (`/api/v1/admin`) still carries no conversation
 * content — that line is drawn in the payload and is unchanged. What ADR-035
 * §5 adds is a second source: the console also reads the TENANT endpoints for
 * an organization this admin OWNS, which is how the Chats and Team views work.
 *
 * That distinction is the whole justification. An admin does not see a
 * tenant's conversations because they are a platform admin; they see them
 * because they hold an `owner` membership in that organization, and the server
 * authorizes those reads through `requireOrganization` and `requirePermission`
 * exactly as it would for any other owner. A platform admin with no membership
 * in a tenant still sees nothing but counts.
 */

/** The console's sections. `overview` is what ADR-032 shipped; the rest are ADR-035 §5. */
const CONSOLE_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "chats", label: "Chats" },
  { id: "team", label: "Team" },
  { id: "accounts", label: "Accounts" },
] as const;

type ConsoleView = (typeof CONSOLE_VIEWS)[number]["id"];

/**
 * What each section actually shows.
 *
 * Per-view rather than one sentence for the page, because the page's original
 * line — "counts only, no conversation content reaches this page" — stopped
 * being true the moment ADR-035 §5 added the Chats view. A standing claim about
 * what a page does not contain has to be withdrawn when it starts containing
 * it; leaving it up would have been a false statement about privacy, which is
 * the worst kind to leave lying around.
 */
const LEDE: Record<ConsoleView, string> = {
  overview:
    "Every tenant and every account on this deployment. Counts only — no conversation content reaches this view.",
  chats:
    "Conversations in the organization you own, read through the same tenant API an agent uses — not through the platform API, which carries no message content.",
  team: "The roster of the organization you own.",
  accounts: "Every account on this deployment, and the one control that creates an agent.",
};

interface AdminPortalPageProps {
  /** The account the route guard confirmed holds the grant. */
  user: CurrentUser;
}

export function AdminPortalPage({ user }: AdminPortalPageProps) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const platform = usePlatformConsole();

  /*
    The organizations this admin actually belongs to. The Chats and Team views
    read TENANT endpoints, which are authorized by membership — so the tenant
    they operate on is the one `/me` says they own, never one picked out of the
    platform-wide list. An admin with no membership anywhere sees the counts and
    is told why the rest is empty.
  */
  const { memberships } = useCurrentUser();
  const ownedOrganization = memberships[0] ?? null;

  const [view, setView] = useState<ConsoleView>("overview");
  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /* Unlisted pages stay out of the index. Same reasoning as the sign-in page. */
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);

    return () => {
      meta.remove();
    };
  }, []);

  /** Left/Right move between sections, Home/End jump to the ends. WAI-ARIA's tab pattern. */
  function handleNavKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = CONSOLE_VIEWS.length - 1;
    let next: number | null = null;

    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;

    if (next === null) return;

    event.preventDefault();
    setView(CONSOLE_VIEWS[next]!.id);
    navRefs.current[next]?.focus();
  }

  /**
   * Not awaited, and that is the point (ADR-013): `signOut` clears the session
   * before it returns, so leaving is immediate and the revocation settles on
   * its own.
   *
   * Lands on the PRIVATE sign-in page rather than the public one. An operator
   * signing out of the console is between two console sessions, and sending
   * them to `/login` would make getting back in a matter of remembering an
   * unlisted address.
   */
  function handleSignOut() {
    void signOut();
    navigate("/control/login", { replace: true });
  }

  const { overview } = platform;

  return (
    <div className="console">
      <header className="console__bar">
        <div className="console__brand">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          <span className="console__brandName">Serviqo</span>
          <span className="console__tag">Operations</span>
        </div>

        <nav className="console__nav" role="tablist" aria-label="Console">
          {CONSOLE_VIEWS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => {
                navRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              /* Only the selected item takes Tab; the arrows move within the bar. */
              tabIndex={view === entry.id ? 0 : -1}
              className={view === entry.id ? "console__navLink console__navLink--active" : "console__navLink"}
              onClick={() => setView(entry.id)}
              onKeyDown={(event) => handleNavKeyDown(event, index)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="console__barRight">
          <span className="console__who">{user.name}</span>
          <Button variant="secondary" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="console__main">
        <section className="console__head">
          <div>
            <p className="console__eyebrow">Platform</p>
            <h1 className="console__title">Everything, everywhere</h1>
            <p className="console__lede">{LEDE[view]}</p>
          </div>

          <div className="console__headActions">
            {/*
              The timestamp matters more here than on most pages: an
              operations console is the kind of thing left open on a second
              monitor, and figures with no read time are figures nobody can
              trust during an incident.
            */}
            {platform.loadedAt !== null && (
              <span className="console__stamp">
                Read at{" "}
                {platform.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={platform.refresh} disabled={platform.isRefreshing}>
              {platform.isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </section>

        {platform.error !== null && (
          <div className="console__alert" role="alert">
            {platform.error}
          </div>
        )}

        {platform.isLoading ? (
          <p className="console__loading" role="status">
            Loading the platform…
          </p>
        ) : (
          <>
            {view === "overview" && <>
            <section aria-labelledby="console-totals-heading">
              <h2 className="console__sectionTitle" id="console-totals-heading">
                Totals
              </h2>
              <div className="console__stats">
                <StatCard label="Organizations" value={overview?.totals.organizations} />
                <StatCard label="Staff accounts" value={overview?.totals.users} />
                <StatCard label="Customers" value={overview?.totals.customers} />
                <StatCard label="Conversations" value={overview?.totals.conversations} />
                <StatCard label="Messages" value={overview?.totals.messages} />
              </div>
            </section>

            <div className="console__split">
              <section aria-labelledby="console-accounts-heading">
                <h2 className="console__sectionTitle" id="console-accounts-heading">
                  Account health
                </h2>
                <div className="console__stats console__stats--compact">
                  <StatCard label="Verified" value={overview?.users.verified} />
                  {/*
                    The number an operator is usually here for. An unverified
                    account cannot sign in at all (ADR-030), so this is the
                    count of people who tried to join and could not.
                  */}
                  <StatCard label="Unverified" value={overview?.users.unverified} tone="warning" />
                  <StatCard label="Disabled" value={overview?.users.disabled} />
                  <StatCard label="Platform admins" value={overview?.users.platformAdmins} />
                </div>
              </section>

              <section aria-labelledby="console-conversations-heading">
                <h2 className="console__sectionTitle" id="console-conversations-heading">
                  Conversation volume
                </h2>
                <div className="console__stats console__stats--compact">
                  <StatCard label="Open" value={overview?.conversations.open} />
                  <StatCard label="Closed" value={overview?.conversations.closed} />
                  <StatCard label="Unassigned" value={overview?.conversations.unassigned} tone="warning" />
                </div>
              </section>
            </div>

            <section aria-labelledby="console-tenants-heading">
              <div className="console__sectionHead">
                <h2 className="console__sectionTitle" id="console-tenants-heading">
                  Tenants
                </h2>
                <TruncationNote shown={platform.organizations.length} total={platform.organizationTotal} />
              </div>

              {platform.organizations.length === 0 ? (
                <p className="console__empty">No organizations exist on this deployment yet.</p>
              ) : (
                <div className="console__tableWrap">
                  <table className="console__table">
                    <thead>
                      <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Owner</th>
                        <th scope="col">Widget</th>
                        <th scope="col" className="console__num">
                          Members
                        </th>
                        <th scope="col" className="console__num">
                          Conversations
                        </th>
                        <th scope="col">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {platform.organizations.map((organization) => (
                        <OrganizationRow key={organization.id} organization={organization} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/*
              The console's one write (ADR-034 §7), placed directly above the
            </>}

            {view === "accounts" && <>
              account list it changes so the result of using it is visible
              without scrolling.
            */}
            <AddAgentForm onAgentAdded={platform.refresh} />

            <section aria-labelledby="console-users-heading">
              <div className="console__sectionHead">
                <h2 className="console__sectionTitle" id="console-users-heading">
                  Accounts
                </h2>
                <TruncationNote shown={platform.users.length} total={platform.userTotal} />
              </div>

              {platform.users.length === 0 ? (
                <p className="console__empty">No accounts exist on this deployment yet.</p>
              ) : (
                <div className="console__tableWrap">
                  <table className="console__table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Email</th>
                        <th scope="col">Kind</th>
                        <th scope="col">State</th>
                        <th scope="col" className="console__num">
                          Organizations
                        </th>
                        <th scope="col">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {platform.users.map((account) => (
                        <UserRow key={account.id} account={account} isSelf={account.id === user.id} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            </>}

            {/*
              The two views that read TENANT endpoints rather than the platform
              API (ADR-035 §5).

              Both are the SAME components the agent workspace uses, given the
              organization this admin owns. Reusing them rather than building
              console-flavoured copies is what keeps one implementation of the
              inbox and one of the roster — a second inbox would be a second
              place for message handling to drift.

              Wrapped in a light surface because they were drawn for the
              workspace's canvas and this console is dark. The alternative,
              re-theming two large components, would be a lot of CSS to make
              them look like something they are not.
            */}
            {(view === "chats" || view === "team") &&
              (ownedOrganization === null ? (
                <p className="console__notice" role="status">
                  This admin account holds no membership in any organization, so there is no roster or conversation
                  list to show. The counts above still cover the whole platform.
                </p>
              ) : (
                <div className="console__embed">
                  {view === "chats" && (
                    <AgentInbox
                      key={`console-inbox-${ownedOrganization.organization.id}`}
                      organizationId={ownedOrganization.organization.id}
                    />
                  )}
                  {view === "team" && (
                    <TeamManagement
                      key={`console-team-${ownedOrganization.organization.id}`}
                      organizationId={ownedOrganization.organization.id}
                      role={ownedOrganization.role}
                      currentUserId={user.id}
                      onOrganizationContextStale={platform.refresh}
                    />
                  )}
                </div>
              ))}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One figure.
 *
 * `value` is optional because the overview request can fail on its own while
 * the two lists succeed — the partial-failure case `usePlatformConsole`
 * preserves. An em dash says "not known", which is honest; a zero would be a
 * fabricated fact, and on this page a fabricated zero is the difference
 * between "nothing is wrong" and "we could not tell".
 */
function StatCard({ label, value, tone }: { label: string; value?: number; tone?: "warning" }) {
  return (
    <article className="console__stat">
      <p className="console__statLabel">{label}</p>
      <p className={tone === "warning" && (value ?? 0) > 0 ? "console__statValue console__statValue--warn" : "console__statValue"}>
        {value ?? "—"}
      </p>
    </article>
  );
}

/** Says what a capped list is hiding, rather than letting it look complete. */
function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (shown >= total) {
    return <span className="console__count">{total} total</span>;
  }

  return (
    <span className="console__count">
      Showing {shown} of {total} — newest first
    </span>
  );
}

function OrganizationRow({ organization }: { organization: PlatformOrganizationSummary }) {
  /*
    Two independent facts about reachability, not one. A tenant with no key
    cannot be embedded at all; a tenant with a key and no allowed origins is
    embeddable by nobody — the safe-by-default empty state (ADR-019 §10) — and
    those are different repairs.
  */
  const widget = !organization.hasWidgetKey
    ? { label: "No key", tone: "warn" as const }
    : organization.allowedOriginCount === 0
      ? { label: "No origins", tone: "warn" as const }
      : { label: `${organization.allowedOriginCount} origin${organization.allowedOriginCount === 1 ? "" : "s"}`, tone: "ok" as const };

  return (
    <tr>
      <td>
        <span className="console__strong">{organization.name}</span>
        <span className="console__sub">/{organization.slug}</span>
      </td>
      <td>
        {organization.owner === null ? (
          /*
            A real state and not an error: ADR-016 §3 accepts an organization
            whose owning membership write failed. Flagged rather than left
            blank, because a tenant nobody owns is precisely what an operator
            is here to find.
          */
          <span className="console__flag">No active owner</span>
        ) : (
          <>
            <span className="console__strong">{organization.owner.name}</span>
            <span className="console__sub">{organization.owner.email}</span>
          </>
        )}
      </td>
      <td>
        <span className={widget.tone === "warn" ? "console__pill console__pill--warn" : "console__pill"}>
          {widget.label}
        </span>
      </td>
      <td className="console__num">{organization.memberCount}</td>
      <td className="console__num">{organization.conversationCount}</td>
      <td className="console__sub">{formatDate(organization.createdAt)}</td>
    </tr>
  );
}

function UserRow({ account, isSelf }: { account: PlatformUserSummary; isSelf: boolean }) {
  return (
    <tr>
      <td>
        <span className="console__strong">{account.name}</span>
        {/* Marks the reader's own row, so an operator can see themselves in the list. */}
        {isSelf && <span className="console__sub">you</span>}
      </td>
      <td className="console__mono">{account.email}</td>
      <td>
        <span className="console__pill">{account.kind === "agent" ? "Agent" : "Customer"}</span>
      </td>
      <td>
        {account.status === "disabled" ? (
          <span className="console__pill console__pill--warn">Disabled</span>
        ) : account.emailVerifiedAt === null ? (
          <span className="console__pill console__pill--warn">Unverified</span>
        ) : (
          <span className="console__pill">Active</span>
        )}
        {account.platformRole === "admin" && <span className="console__pill console__pill--admin">Admin</span>}
      </td>
      <td className="console__num">{account.membershipCount}</td>
      <td className="console__sub">{formatDate(account.createdAt)}</td>
    </tr>
  );
}

/**
 * Dates as the reader's locale writes them.
 *
 * Guarded rather than trusted: these strings come off the wire, and
 * `toLocaleDateString` on an invalid date renders the literal text "Invalid
 * Date" into the table. Falling back to the raw value at least shows an
 * operator what the server actually sent.
 */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
