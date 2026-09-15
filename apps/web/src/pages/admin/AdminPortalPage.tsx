import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { updateOrganizationStatus } from "@/features/admin/adminApi";
import { ChatLinkActions } from "@/features/admin/CopyLinkButton";
import { CreateOrganizationPanel } from "@/features/admin/CreateOrganizationPanel";
import { InviteMemberPanel } from "@/features/admin/InviteMemberPanel";
import { consoleWriteError } from "@/features/admin/consoleErrors";
import { usePlatformConsole } from "@/features/admin/usePlatformConsole";
import { useAuth } from "@/features/auth/useAuth";
import { AgentInbox } from "@/features/inbox/AgentInbox";
import { TeamManagement } from "@/features/team/TeamManagement";
import {
  ArrowLeftIcon,
  ChatIcon,
  HeadsetIcon,
  OrganisationIcon,
  PauseIcon,
  PeopleIcon,
  PlayIcon,
  ShieldIcon,
} from "@/features/workspace/workspaceIcons";

import type { CurrentUser } from "@/features/auth/authApi";
import type { PlatformOrganizationSummary, PlatformUserSummary } from "@/features/admin/adminApi";

import "./AdminPortalPage.css";

/**
 * The operations console: the super admin's surface (ADR-032, ADR-039).
 *
 * Super admin → organisations → their admins and agents → anonymous customers.
 * This page is the top of that hierarchy. It creates organisations (each with
 * an owner and a customer chat link), suspends and reactivates them, and opens
 * any organisation's chats and team.
 *
 * Opening an organisation reads the TENANT endpoints — the same inbox and
 * roster its own staff use — authorised by the platform grant rather than a
 * membership (ADR-039 §5). The server logs every such request.
 */

const CONSOLE_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "organisations", label: "Organisations" },
  { id: "accounts", label: "Accounts" },
] as const;

type ConsoleView = (typeof CONSOLE_VIEWS)[number]["id"];

const LEDE: Record<ConsoleView, string> = {
  overview: "Every organisation and account on this deployment, in figures.",
  organisations:
    "Create organisations, hand out their customer chat links, and step into any organisation's chats and team.",
  accounts: "Every staff account on this deployment, and whether it can sign in.",
};

type OrganisationTab = "chats" | "team" | "invite";

interface AdminPortalPageProps {
  /** The account the route guard confirmed holds the grant. */
  user: CurrentUser;
}

export function AdminPortalPage({ user }: AdminPortalPageProps) {
  const { signOut, authorizedFetch } = useAuth();
  const navigate = useNavigate();
  const platform = usePlatformConsole();

  const [view, setView] = useState<ConsoleView>("overview");
  const [openOrganizationId, setOpenOrganizationId] = useState<string | null>(null);
  const [organisationTab, setOrganisationTab] = useState<OrganisationTab>("chats");
  const [statusPendingId, setStatusPendingId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
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
    selectView(CONSOLE_VIEWS[next]!.id);
    navRefs.current[next]?.focus();
  }

  function selectView(next: ConsoleView) {
    setView(next);
    setOpenOrganizationId(null);
  }

  /** Lands on the private sign-in page, so getting back in is not a matter of memory. */
  function handleSignOut() {
    void signOut();
    navigate("/control/login", { replace: true });
  }

  function openOrganisation(organizationId: string, tab: OrganisationTab = "chats") {
    setOpenOrganizationId(organizationId);
    setOrganisationTab(tab);
  }

  function toggleStatus(organization: PlatformOrganizationSummary) {
    const next = organization.status === "active" ? "suspended" : "active";
    setStatusPendingId(organization.id);
    setStatusError(null);

    updateOrganizationStatus(authorizedFetch, organization.id, next)
      .then(() => platform.refresh())
      .catch((caught: unknown) => setStatusError(consoleWriteError(caught, "Could not change that organisation.")))
      .finally(() => setStatusPendingId(null));
  }

  const { overview } = platform;
  const openOrganization =
    openOrganizationId === null ? null : (platform.organizations.find((entry) => entry.id === openOrganizationId) ?? null);

  return (
    <div className="console">
      <header className="console__bar">
        <div className="console__brand">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          <span className="console__brandName">Serviqo</span>
          <span className="console__tag">
            <ShieldIcon aria-hidden="true" width={13} height={13} />
            Super admin
          </span>
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
              tabIndex={view === entry.id ? 0 : -1}
              className={view === entry.id ? "console__navLink console__navLink--active" : "console__navLink"}
              onClick={() => selectView(entry.id)}
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
            {view === "overview" && (
              <>
                <section aria-labelledby="console-totals-heading">
                  <h2 className="console__sectionTitle" id="console-totals-heading">
                    Totals
                  </h2>
                  <div className="console__stats">
                    <StatCard label="Organisations" value={overview?.totals.organizations} />
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
                      <StatCard label="Unverified" value={overview?.users.unverified} tone="warning" />
                      <StatCard label="Disabled" value={overview?.users.disabled} />
                      <StatCard label="Super admins" value={overview?.users.platformAdmins} />
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
              </>
            )}

            {view === "organisations" && openOrganization === null && (
              <>
                <CreateOrganizationPanel onCreated={platform.refresh} />

                <section aria-labelledby="console-tenants-heading">
                  <div className="console__sectionHead">
                    <h2 className="console__sectionTitle" id="console-tenants-heading">
                      Organisations
                    </h2>
                    <TruncationNote shown={platform.organizations.length} total={platform.organizationTotal} />
                  </div>

                  {statusError !== null && (
                    <p className="console__alert" role="alert">
                      {statusError}
                    </p>
                  )}

                  {platform.organizations.length === 0 ? (
                    <p className="console__empty">No organisations yet. Create the first one above.</p>
                  ) : (
                    <div className="console__tableWrap">
                      <table className="console__table">
                        <thead>
                          <tr>
                            <th scope="col">Organisation</th>
                            <th scope="col">Customer chat link</th>
                            <th scope="col">Owner</th>
                            <th scope="col" className="console__num">
                              Staff
                            </th>
                            <th scope="col" className="console__num">
                              Chats
                            </th>
                            <th scope="col">
                              <span className="console__srOnly">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {platform.organizations.map((organization) => (
                            <OrganizationRow
                              key={organization.id}
                              organization={organization}
                              isStatusPending={statusPendingId === organization.id}
                              onOpen={(tab) => openOrganisation(organization.id, tab)}
                              onToggleStatus={() => toggleStatus(organization)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}

            {view === "organisations" && openOrganization !== null && (
              <OrganisationDetail
                organization={openOrganization}
                currentUserId={user.id}
                tab={organisationTab}
                onTab={setOrganisationTab}
                onBack={() => setOpenOrganizationId(null)}
                onChanged={platform.refresh}
              />
            )}

            {view === "accounts" && (
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
                            Organisations
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
            )}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One organisation, opened: its chats, its team, and inviting people into it
 * (ADR-039 §5). Keyed by organisation so switching tears the inbox's socket
 * down rather than re-pointing it.
 */
function OrganisationDetail({
  organization,
  currentUserId,
  tab,
  onTab,
  onBack,
  onChanged,
}: {
  organization: PlatformOrganizationSummary;
  currentUserId: string;
  tab: OrganisationTab;
  onTab: (tab: OrganisationTab) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const tabs: { id: OrganisationTab; label: string; icon: React.ReactNode }[] = [
    { id: "chats", label: "Chats", icon: <ChatIcon aria-hidden="true" width={15} height={15} /> },
    { id: "team", label: "Team", icon: <PeopleIcon aria-hidden="true" width={15} height={15} /> },
    { id: "invite", label: "Invite", icon: <HeadsetIcon aria-hidden="true" width={15} height={15} /> },
  ];

  return (
    <section className="console__detail" aria-labelledby="console-detail-heading">
      <button type="button" className="console__back" onClick={onBack}>
        <ArrowLeftIcon aria-hidden="true" />
        All organisations
      </button>

      <div className="console__detailHead">
        <span className="console__orgMark" aria-hidden="true">
          <OrganisationIcon />
        </span>
        <div className="console__detailTitle">
          <h2 className="console__title console__title--sm" id="console-detail-heading">
            {organization.name}
          </h2>
          <span className="console__linkRow">
            <span className="console__mono">{organization.widgetUrl}</span>
            <ChatLinkActions url={organization.widgetUrl} label={organization.name} />
          </span>
        </div>
        <StatusPill status={organization.status} />
      </div>

      {organization.status !== "active" ? (
        <p className="console__notice" role="status">
          This organisation is suspended. Its chat link and workspace are closed until you reactivate it.
        </p>
      ) : (
        <>
          <div className="console__subnav" role="tablist" aria-label={`${organization.name} sections`}>
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={tab === entry.id ? "console__navLink console__navLink--active" : "console__navLink"}
                onClick={() => onTab(entry.id)}
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "invite" ? (
            <InviteMemberPanel organizationId={organization.id} organizationName={organization.name} onInvited={onChanged} />
          ) : (
            <div className="console__embed">
              {tab === "chats" && <AgentInbox key={`console-inbox-${organization.id}`} organizationId={organization.id} role="admin" />}
              {tab === "team" && (
                <TeamManagement
                  key={`console-team-${organization.id}`}
                  organizationId={organization.id}
                  role="admin"
                  currentUserId={currentUserId}
                  onOrganizationContextStale={onChanged}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  return status === "active" ? (
    <span className="console__pill">Active</span>
  ) : (
    <span className="console__pill console__pill--warn">Suspended</span>
  );
}

/**
 * One figure. An em dash says "not known" when the overview failed on its own,
 * which is honest where a zero would be a fabricated fact.
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

function OrganizationRow({
  organization,
  isStatusPending,
  onOpen,
  onToggleStatus,
}: {
  organization: PlatformOrganizationSummary;
  isStatusPending: boolean;
  onOpen: (tab: OrganisationTab) => void;
  onToggleStatus: () => void;
}) {
  const isActive = organization.status === "active";

  return (
    <tr>
      <td>
        <span className="console__strong">{organization.name}</span>
        <span className="console__sub">
          <StatusPill status={organization.status} />
        </span>
      </td>
      <td>
        <span className="console__linkRow">
          <span className="console__mono console__truncate">/widget/{organization.slug}</span>
          <ChatLinkActions url={organization.widgetUrl} label={organization.name} />
        </span>
      </td>
      <td>
        {organization.owner === null ? (
          // Repairable from Open → Invite, which can name an owner.
          <span className="console__flag">No active owner</span>
        ) : (
          <>
            <span className="console__strong">{organization.owner.name}</span>
            <span className="console__sub">{organization.owner.email}</span>
          </>
        )}
      </td>
      <td className="console__num">{organization.memberCount}</td>
      <td className="console__num">{organization.conversationCount}</td>
      <td>
        <span className="console__rowActions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpen("chats")}
            disabled={!isActive}
            aria-label={`Open ${organization.name}`}
          >
            Open
          </Button>
          <button
            type="button"
            className="console__iconButton"
            onClick={onToggleStatus}
            disabled={isStatusPending}
            aria-label={isActive ? `Suspend ${organization.name}` : `Reactivate ${organization.name}`}
            title={isActive ? "Suspend" : "Reactivate"}
          >
            {isActive ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          </button>
        </span>
      </td>
    </tr>
  );
}

function kindLabel(account: PlatformUserSummary): string {
  if (account.platformRole === "admin" || account.kind === "admin") return "Super admin";
  if (account.kind === "agent") return "Staff";
  return "Legacy customer";
}

function UserRow({ account, isSelf }: { account: PlatformUserSummary; isSelf: boolean }) {
  return (
    <tr>
      <td>
        <span className="console__strong">{account.name}</span>
        {isSelf && <span className="console__sub">you</span>}
      </td>
      <td className="console__mono">{account.email}</td>
      <td>
        <span className={account.platformRole === "admin" ? "console__pill console__pill--admin" : "console__pill"}>
          {kindLabel(account)}
        </span>
      </td>
      <td>
        {account.status === "disabled" ? (
          <span className="console__pill console__pill--warn">Disabled</span>
        ) : account.emailVerifiedAt === null ? (
          <span className="console__pill console__pill--warn">Unverified</span>
        ) : (
          <span className="console__pill">Active</span>
        )}
      </td>
      <td className="console__num">{account.membershipCount}</td>
      <td className="console__sub">{formatDate(account.createdAt)}</td>
    </tr>
  );
}

/** Dates as the reader's locale writes them, falling back to the raw value. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
