import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";
import { AgentInbox } from "@/features/inbox/AgentInbox";
import { CreateOrganizationForm } from "@/features/organizations/CreateOrganizationForm";
import { OrganizationSwitcher } from "@/features/organizations/OrganizationSwitcher";
import { WidgetInstallation } from "@/features/organizations/WidgetInstallation";
import { TeamManagement } from "@/features/team/TeamManagement";

import type { ActiveOrganizationContext } from "@/features/organizations/OrganizationSwitcher";

import "./DashboardPage.css";

/**
 * The workspace shell.
 *
 * Three things on this page are REAL. The identity comes from
 * `GET /auth/me` (ADR-015); the organization context and widget installation
 * come from the organization endpoints (ADR-017, ADR-020); and, as of
 * ADR-025, the inbox reads this tenant's actual conversations and messages
 * and sends actual replies.
 *
 * The METRICS at the bottom are still SAMPLE VALUES, labelled as such in the
 * UI. `Conversation` and `Message` now exist — what is missing is anything
 * that aggregates them — so the note beside those figures says only that
 * nothing computes them yet, rather than the older and now-false claim that
 * nothing on this page reads real data. CONTRIBUTING.md requires demo data
 * to say what it is rather than imply a working feature, and it equally
 * requires a working feature not to be described as absent.
 */

interface StatCard {
  label: string;
  value: string;
  hint: string;
}

const SAMPLE_STATS: StatCard[] = [
  // The conversations model exists as of ADR-022 and the inbox reads it; what
  // is still missing is an aggregate to count against, so this stays "—".
  { label: "Total conversations", value: "—", hint: "Needs a conversation metrics endpoint" },
  { label: "Open tickets", value: "—", hint: "Needs the ticketing slice" },
  { label: "Waiting customers", value: "—", hint: "Needs the queue and presence slices" },
];

export function DashboardPage() {
  const { session, signOut, signOutAllDevices } = useAuth();
  const { user, memberships, isLoading, error } = useCurrentUser();
  const navigate = useNavigate();

  const [activeOrganization, setActiveOrganization] = useState<ActiveOrganizationContext | null>(null);

  // ProtectedRoute guarantees a session before this renders; the guard keeps
  // the component honest rather than asserting non-null.
  if (session === null) return null;

  /**
   * Not awaited, and that is the point (ADR-013): `signOut` clears the session
   * before it returns, so leaving is immediate and the request to revoke it
   * settles on its own. Only the sign-in state is touched — nothing else on
   * the page is reset.
   */
  function handleSignOut() {
    void signOut();
    navigate("/login", { replace: true });
  }

  /**
   * Ends every session, everywhere (ADR-014). Same shape as the button above,
   * and reaches /login the same way — the only difference is how much it
   * revokes on the server.
   */
  function handleSignOutAllDevices() {
    void signOutAllDevices();
    navigate("/login", { replace: true });
  }

  return (
    <div className="dash">
      <header className="dash__bar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <BrandMark />
          </span>
          Serviqo
        </div>
        <div className="dash__barRight">
          {/*
            Nothing stands in for the name while it loads. A placeholder that
            reads like a person — "there", the login response's copy — would be
            fake identity, which is the thing this slice removed.
          */}
          {user === null ? (
            <span className="dash__who dash__who--loading" aria-hidden="true" />
          ) : (
            <span className="dash__who">{user.name}</span>
          )}
          {/*
            The wider action is a plain link-style control rather than a second
            button of equal weight: it ends sessions on devices that are not in
            front of the person clicking, so it should not sit one mis-click
            away from the ordinary one.
          */}
          <button type="button" className="dash__signOutAll" onClick={handleSignOutAllDevices}>
            Sign out of all devices
          </button>
          <Button variant="secondary" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="dash__main">
        {/*
          Three states, and the loading one shows no identity at all rather
          than a name taken from somewhere else. `aria-busy` tells a screen
          reader the region is still filling in, and `role="status"` announces
          it when it does without stealing focus.
        */}
        <section className="dash__welcome" aria-busy={isLoading}>
          <p className="eyebrow">Workspace</p>
          {isLoading ? (
            <div className="dash__identityLoading" role="status">
              <span className="dash__skeleton dash__skeleton--title" />
              <span className="dash__skeleton dash__skeleton--email" />
              <span className="dash__srOnly">Loading your account…</span>
            </div>
          ) : user !== null ? (
            <>
              <h1 className="dash__title">Welcome, {user.name}</h1>
              <p className="dash__email">{user.email}</p>
            </>
          ) : (
            /*
              Reached only for a failure that is NOT a 401 — the network, or a
              response this client could not read. A 401 signs the user out and
              ProtectedRoute redirects, so this branch never renders for one.
            */
            <p className="dash__identityError" role="alert">
              {error ?? "Could not load your account."}
            </p>
          )}
        </section>

        {/*
          Organization context (ADR-017 §10), then creation. Both are real and
          sit above the sample metrics deliberately: a workspace with no
          organization has exactly one useful action, and burying it under
          placeholder figures would invert that.

          Rendered only once `/me` has settled — a switcher that appears empty
          and then fills in reads as "you have no organizations", which is the
          one thing it must not say while it does not yet know.
        */}
        {!isLoading && user !== null && (
          <OrganizationSwitcher memberships={memberships} onActiveOrganizationChange={setActiveOrganization} />
        )}

        {/*
          Keyed by organization id so switching tenants remounts this section
          fresh (ADR-020) rather than reconciling one tenant's widget key and
          origins into a component that just finished rendering another's.

          The key is PREFIXED with the section's own name, and every keyed
          section below does the same. These are siblings, and React requires
          keys to be unique among siblings — three sections sharing the bare
          organization id made React warn that it could duplicate or omit
          children, which for sections that must be torn down on a tenant
          switch is exactly the guarantee being relied on here.
        */}
        {activeOrganization !== null && (
          <WidgetInstallation
            key={`widget-${activeOrganization.organizationId}`}
            organizationId={activeOrganization.organizationId}
          />
        )}

        {/*
          The agent inbox (ADR-025 §11) — the first section on this page that
          reads real tenant data.

          Keyed by organization id for a sharper reason than the section
          above: switching tenants must DISCARD the inbox's conversations,
          unread counts, selected thread, and open socket, not reconcile them.
          React tears down the subtree on a key change, which is the only way
          to be certain no message from the previous tenant can land in the
          new one's list. Filtering by organizationId in an effect would be
          the "rely only on frontend filtering" CONTRIBUTING.md forbids.
        */}
        {activeOrganization !== null && (
          <AgentInbox
            key={`inbox-${activeOrganization.organizationId}`}
            organizationId={activeOrganization.organizationId}
          />
        )}

        {/*
          Team management (ADR-027 §16).

          Keyed by organization id for the same reason the two sections above
          are: switching tenants must DISCARD one organization's roster rather
          than reconcile it into a component that just finished rendering
          another's. React tears down the subtree on a key change, which is the
          only way to be certain no row from the previous tenant survives.

          The role it receives is the one the SERVER confirmed for this
          organization on this page load, and `user.id` is the account `/me`
          reported — so the section can mark the reader's own row and withhold
          its controls without the client deciding anything about standing. A
          hidden control is an affordance, never a boundary: the server
          re-proves `member.read` and `member.manage` on every request.
        */}
        {activeOrganization !== null && (
          <TeamManagement
            key={`team-${activeOrganization.organizationId}`}
            organizationId={activeOrganization.organizationId}
            role={activeOrganization.role}
            currentUserId={user?.id ?? null}
          />
        )}

        <CreateOrganizationForm />

        <section aria-labelledby="dash-stats-heading">
          <div className="dash__statsHead">
            <h2 className="h3" id="dash-stats-heading">
              Today
            </h2>
            <span className="badge badge--neutral">SAMPLE DATA</span>
          </div>

          <div className="dash__stats">
            {SAMPLE_STATS.map((stat) => (
              <article className="dash__stat card pad" key={stat.label}>
                <p className="dash__statLabel">{stat.label}</p>
                <p className="dash__statValue">{stat.value}</p>
                <p className="dash__statHint">{stat.hint}</p>
              </article>
            ))}
          </div>

          <p className="dash__note">
            These figures are placeholders — nothing computes them yet. The inbox above is real: it reads this
            organization&rsquo;s conversations and messages.
          </p>
        </section>
      </main>
    </div>
  );
}
