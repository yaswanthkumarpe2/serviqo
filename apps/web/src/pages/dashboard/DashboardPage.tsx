import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";
import { AgentInbox } from "@/features/inbox/AgentInbox";
import { SavedRepliesSettings } from "@/features/inbox/SavedRepliesSettings";
import { OrganizationSwitcher } from "@/features/organizations/OrganizationSwitcher";
import { WidgetAppearanceSettings } from "@/features/organizations/WidgetAppearanceSettings";
import { WidgetInstallation } from "@/features/organizations/WidgetInstallation";
import { WidgetLinkCard } from "@/features/workspace/WidgetLinkCard";
import { TeamManagement } from "@/features/team/TeamManagement";
import { ContactsPanel } from "@/features/workspace/ContactsPanel";
import { WorkspaceOverview } from "@/features/workspace/WorkspaceOverview";
import { ChatIcon } from "@/features/workspace/workspaceIcons";
import { WORKSPACE_VIEWS } from "@/features/workspace/workspaceViews";
import { useWorkspaceOverview } from "@/features/workspace/useWorkspaceOverview";

import type { ActiveOrganizationContext } from "@/features/organizations/OrganizationSwitcher";
import type { WorkspaceView } from "@/features/workspace/workspaceViews";

import "./DashboardPage.css";

/**
 * The workspace (ADR-033).
 *
 * A product shell rather than a stack of sections: a top bar with primary
 * navigation, and one view at a time beneath it. What a signed-in person sees
 * first is a greeting, four things they can do, and the conversations waiting
 * for them — not a settings page with an inbox somewhere in the middle.
 *
 * Every figure on it is REAL. The overview derives its counts from this
 * tenant's actual conversations, and where the server's paging means a count
 * is not a total, the page says so (ADR-033 §4). There is no sample data
 * anywhere in this tree, and the two sections a mockup would have included —
 * notifications, and an average response time — are absent precisely because
 * nothing computes them.
 *
 * Who this is FOR is worth stating, because the layout resembles a customer
 * portal and is not one. Serviqo's customers never sign in (ADR-010 §5) —
 * they reach a tenant through the embedded widget. The person here is STAFF,
 * "my chats" are the conversations in their inbox, and "contacts" are the
 * visitors who wrote to them.
 */
export function DashboardPage() {
  const { session, signOut, signOutAllDevices } = useAuth();
  const { user, memberships, isLoading, error } = useCurrentUser();
  const navigate = useNavigate();

  const [activeOrganization, setActiveOrganization] = useState<ActiveOrganizationContext | null>(null);
  const [view, setView] = useState<WorkspaceView>("dashboard");

  /**
   * A conversation the overview asked the chats view to open.
   *
   * Held here rather than inside the inbox because the two are siblings: a row
   * clicked on the dashboard has to survive the switch to a view that has not
   * mounted yet. Cleared once handed over, so returning to My Chats later does
   * not silently reopen a thread from twenty minutes ago.
   */
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);

  /**
   * Bumped when something the server knows about the reader's standing has
   * changed and this page's copy is stale (ADR-028 §16).
   *
   * Its only writer today is a completed ownership transfer. The switcher
   * re-reads `GET /organizations/:id` when this changes, so the role every
   * section below is given comes back from the database on a fresh request.
   */
  const [organizationContextNonce, setOrganizationContextNonce] = useState(0);

  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // ProtectedRoute guarantees a session before this renders; the guard keeps
  // the component honest rather than asserting non-null.
  if (session === null) return null;

  /**
   * Not awaited, and that is the point (ADR-013): `signOut` clears the session
   * before it returns, so leaving is immediate and the request to revoke it
   * settles on its own.
   */
  function handleSignOut() {
    void signOut();
    navigate("/login", { replace: true });
  }

  /** Ends every session, everywhere (ADR-014). Same shape, wider blast radius. */
  function handleSignOutAllDevices() {
    void signOutAllDevices();
    navigate("/login", { replace: true });
  }

  /** Left/Right move between nav items, Home/End jump to the ends. WAI-ARIA's tab pattern. */
  function handleNavKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = WORKSPACE_VIEWS.length - 1;
    let next: number | null = null;

    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;

    if (next === null) return;

    event.preventDefault();
    setView(WORKSPACE_VIEWS[next]!.id);
    navRefs.current[next]?.focus();
  }

  function openConversation(conversationId: string) {
    setPendingConversationId(conversationId);
    setView("chats");
  }

  return (
    <div className="ws">
      <header className="ws__topbar">
        <div className="ws__topbarInner">
          <div className="brand ws__brand">
            <span className="brand__mark" aria-hidden="true">
              <BrandMark />
            </span>
            Serviqo
          </div>

          {/*
            Rendered only once a tenant is confirmed. Before that there is
            nothing any of these views could be scoped to, and nav that leads
            to four empty pages is worse than no nav.
          */}
          {activeOrganization !== null && (
            <nav className="ws__nav" role="tablist" aria-label="Workspace">
              {WORKSPACE_VIEWS.map((entry, index) => (
                <button
                  key={entry.id}
                  ref={(element) => {
                    navRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`ws-tab-${entry.id}`}
                  aria-controls={`ws-panel-${entry.id}`}
                  aria-selected={view === entry.id}
                  /*
                    Only the selected item is reachable by Tab; the arrows move
                    within the bar. The WAI-ARIA pattern, and what keeps a
                    five-item nav from costing five stops on the way to the
                    conversation list.
                  */
                  tabIndex={view === entry.id ? 0 : -1}
                  className={view === entry.id ? "ws__navLink ws__navLink--active" : "ws__navLink"}
                  onClick={() => setView(entry.id)}
                  onKeyDown={(event) => handleNavKeyDown(event, index)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          )}

          <div className="ws__topbarRight">
            {/*
              Nothing stands in for the name while it loads. A placeholder that
              reads like a person would be fake identity.
            */}
            {user === null ? (
              <span className="ws__avatar ws__avatar--loading" aria-hidden="true" />
            ) : (
              <>
                {/*
                  The name is text, not only an avatar's tooltip. Which account
                  a workspace is signed in as must be readable without hovering,
                  and an avatar's two initials are not an answer to that.
                */}
                <span className="ws__who">{user.name}</span>
                <span className="ws__avatar" aria-hidden="true">
                  {initials(user.name)}
                </span>
              </>
            )}
            <button type="button" className="ws__signOutAll" onClick={handleSignOutAllDevices}>
              Sign out of all devices
            </button>
            <Button variant="secondary" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="ws__wrap" aria-busy={isLoading}>
        {isLoading ? (
          <div className="ws__identityLoading" role="status">
            <span className="ws__skeleton ws__skeleton--title" />
            <span className="ws__skeleton ws__skeleton--email" />
            <span className="ws__srOnly">Loading your account…</span>
          </div>
        ) : user === null ? (
          /*
            Reached only for a failure that is NOT a 401 — the network, or a
            response this client could not read. A 401 signs the user out and
            ProtectedRoute redirects, so this never renders for one.
          */
          <p className="ws__alert" role="alert">
            {error ?? "Could not load your account."}
          </p>
        ) : (
          <>
            {/*
              The greeting belongs to the PERSON, not to a tenant, so it sits
              in the shell above everything scoped to one.

              That distinction is not cosmetic: it used to live inside the
              overview, which renders only once an organization is confirmed —
              so somebody who had just registered and created nothing was met
              by a bare form with no acknowledgement they had signed in at all.
            */}
            <section className="ws__hero">
              <div>
                <h1 className="ws__heroTitle">Welcome back, {firstNameOf(user.name)}</h1>
                {/*
                  The address, because a greeting is not identity: two accounts
                  belonging to the same person produce the same greeting, and
                  which one you are signed into is what a workspace must answer
                  without being asked (ADR-015).
                */}
                <p className="ws__heroLede">{user.email}</p>
              </div>
              {activeOrganization !== null && (
                <div className="ws__heroActions">
                  <Button variant="primary" onClick={() => setView("chats")}>
                    <ChatIcon aria-hidden="true" />
                    Open my chats
                  </Button>
                </div>
              )}
            </section>

            {/*
              The tenant context, above every view because it is the scope they
              are all read in. Mounted once and never unmounted: it is what
              establishes `activeOrganization`, and hiding it behind a view
              would mean switching views could drop the tenant.
            */}
            <OrganizationSwitcher
              memberships={memberships}
              onActiveOrganizationChange={setActiveOrganization}
              reloadNonce={organizationContextNonce}
            />

            {activeOrganization === null ? (
              /*
                An agent who belongs to no organization (ADR-034 §10).

                They are NOT offered a form to create one. Tenants are the
                admin's to set up — an agent who could create one would be able
                to make themselves the owner of a workspace nobody asked for,
                which is precisely the access this slice removed.

                This state should be unreachable in practice: the invitation
                that created the account also created its membership. It is
                reachable if that membership write failed (ADR-016 §3), which
                is exactly when somebody needs to be told plainly rather than
                handed a form.
              */
              <p className="ws__notice" role="status">
                Your account is not attached to an organization yet. Ask your admin to add you.
              </p>
            ) : (
              <WorkspaceBody
                key={activeOrganization.organizationId}
                view={view}
                organizationId={activeOrganization.organizationId}
                role={activeOrganization.role}
                widgetUrl={activeOrganization.widgetUrl}
                organizationName={activeOrganization.name}
                userId={user.id}
                pendingConversationId={pendingConversationId}
                onConversationHandled={() => setPendingConversationId(null)}
                onNavigate={setView}
                onOpenConversation={openConversation}
                onOrganizationContextStale={() => setOrganizationContextNonce((nonce) => nonce + 1)}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

interface WorkspaceBodyProps {
  view: WorkspaceView;
  organizationId: string;
  role: string;
  widgetUrl: string | null;
  organizationName: string;
  userId: string;
  pendingConversationId: string | null;
  onConversationHandled: () => void;
  onNavigate: (view: WorkspaceView) => void;
  onOpenConversation: (conversationId: string) => void;
  onOrganizationContextStale: () => void;
}

/**
 * Everything below the tenant context, for one tenant.
 *
 * Its own component so it can be KEYED by organization id from the parent:
 * switching tenants tears this subtree down rather than reconciling one
 * tenant's conversations, contacts and roster into a tree that just finished
 * rendering another's (ADR-025 §11). Filtering by organizationId in an effect
 * would be the "rely only on frontend filtering" CONTRIBUTING.md forbids.
 *
 * It also owns the overview read, so the dashboard's figures and the contacts
 * table come from ONE request rather than two that could disagree.
 */
function WorkspaceBody({
  view,
  organizationId,
  role,
  widgetUrl,
  organizationName,
  userId,
  pendingConversationId,
  onConversationHandled,
  onNavigate,
  onOpenConversation,
  onOrganizationContextStale,
}: WorkspaceBodyProps) {
  const overview = useWorkspaceOverview(organizationId, userId);

  return (
    <div className="ws__panelRegion" role="tabpanel" id={`ws-panel-${view}`} aria-labelledby={`ws-tab-${view}`} tabIndex={-1}>
      {/*
        One view is mounted at a time rather than all five hidden with CSS,
        which matters most for the inbox: it holds an open socket, and a
        hidden-but-mounted copy would keep streaming a tenant's messages into
        a component nobody is looking at.
      */}
      {view === "dashboard" && (
        <div className="ws__stack">
          <WorkspaceOverview overview={overview} onNavigate={onNavigate} onOpenConversation={onOpenConversation} />
          {/*
            On the first view, for every member (ADR-038 §4). Handing a customer
            this link is the most common thing an agent does that is not
            answering a chat, so it should not live behind Settings.
          */}
          {widgetUrl !== null && <WidgetLinkCard widgetUrl={widgetUrl} />}
        </div>
      )}

      {view === "chats" && (
        <AgentInbox
          organizationId={organizationId}
          initialConversationId={pendingConversationId}
          onInitialConversationHandled={onConversationHandled}
        />
      )}

      {view === "contacts" && (
        <ContactsPanel contacts={overview.contacts} isLoading={overview.isLoading} isComplete={overview.isComplete} />
      )}

      {view === "team" && (
        /*
          The role it receives is the one the SERVER confirmed for this
          organization on this page load, and `userId` is the account `/me`
          reported — so the section can mark the reader's own row and withhold
          its controls without the client deciding anything about standing. A
          hidden control is an affordance, never a boundary: the server
          re-proves `member.read` and `member.manage` on every request.
        */
        <TeamManagement
          organizationId={organizationId}
          role={role}
          currentUserId={userId}
          onOrganizationContextStale={onOrganizationContextStale}
        />
      )}

      {view === "settings" && (
        <div className="ws__stack">
          {widgetUrl !== null && <WidgetLinkCard widgetUrl={widgetUrl} />}
          <WidgetAppearanceSettings organizationId={organizationId} organizationName={organizationName} />
          {/*
            The team's saved replies (ADR-042 §1). Every member sees them; the
            roles holding `saved_reply.manage` can edit, and the server decides.
          */}
          <SavedRepliesSettings
            organizationId={organizationId}
            canManage={role === "owner" || role === "admin" || role === "supervisor"}
          />
          {/*
            Embedding the chat on the organisation's own website. Its settings
            are `organization.manage`, and the component renders the server's
            refusal for a member who lacks it.
          */}
          <WidgetInstallation organizationId={organizationId} />
        </div>
      )}
    </div>
  );
}

/** The greeting uses a first name; the identity elsewhere uses the whole one. */
function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first === undefined || first.length === 0 ? name : first;
}

/** Up to two letters for the avatar. Never more — three is a word, not a mark. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
