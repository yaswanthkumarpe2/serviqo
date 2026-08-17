import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/icons";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";

import "./DashboardPage.css";

/**
 * Placeholder workspace shell. It exists to prove the session round trip —
 * sign in, land somewhere authenticated, sign out — and nothing more.
 *
 * The IDENTITY on this page is real: it comes from `GET /auth/me` (ADR-015),
 * not from the login response and not from anything hardcoded. The METRICS
 * below are SAMPLE VALUES, labelled as such in the UI. No conversation,
 * ticket, or queue model exists yet, and CONTRIBUTING.md requires demo data
 * to say so rather than imply a working feature.
 */

interface StatCard {
  label: string;
  value: string;
  hint: string;
}

const SAMPLE_STATS: StatCard[] = [
  { label: "Total conversations", value: "—", hint: "Needs the conversations model" },
  { label: "Open tickets", value: "—", hint: "Needs the ticketing slice" },
  { label: "Waiting customers", value: "—", hint: "Needs the queue and presence slices" },
];

export function DashboardPage() {
  const { session, signOut, signOutAllDevices } = useAuth();
  const { user, isLoading, error } = useCurrentUser();
  const navigate = useNavigate();

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
            These figures are placeholders. Nothing on this page reads real data — the conversation, ticket and queue
            models have not been built.
          </p>
        </section>
      </main>
    </div>
  );
}
