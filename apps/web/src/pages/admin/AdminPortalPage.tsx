import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { AddAgentForm } from "@/features/admin/AddAgentForm";
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
 * It also shows no conversation CONTENT, because the API carries none. That
 * line is drawn in the payload rather than in this component, so a future
 * panel cannot render what a careless endpoint started sending.
 */

interface AdminPortalPageProps {
  /** The account the route guard confirmed holds the grant. */
  user: CurrentUser;
}

export function AdminPortalPage({ user }: AdminPortalPageProps) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const platform = usePlatformConsole();

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
            <p className="console__lede">
              Every tenant and every account on this deployment. Counts only — no conversation content reaches this
              page.
            </p>
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
