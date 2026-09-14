import { Navigate, Route, Routes } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { homePathFor, isPlatformAdmin } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";
import { AdminLoginPage } from "@/pages/admin/AdminLoginPage";
import { AdminPortalPage } from "@/pages/admin/AdminPortalPage";
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage";
import { LoginPage } from "@/pages/auth/LoginPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";
import { VerifyEmailPage } from "@/pages/auth/VerifyEmailPage";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { LandingPage } from "@/pages/marketing/LandingPage";
import { HostedWidgetPage } from "@/pages/widget/HostedWidgetPage";

import { AgentRoute } from "./AgentRoute";
import { NoStaffSurface } from "./NoStaffSurface";
import { PlatformAdminRoute } from "./PlatformAdminRoute";

/**
 * The sign-in route, which has the same "not yet known" problem
 * `ProtectedRoute` does — from the other side.
 *
 * Rendering the form while the restore is still running is precisely the
 * flicker this slice exists to remove: a returning user would see the sign-in
 * page for a frame before being sent to the dashboard they were already
 * entitled to.
 */
function SignInRoute() {
  const { isAuthenticated, isRestoring } = useAuth();

  if (isRestoring) {
    return <AuthRestoring />;
  }

  /*
    Signing in again while already signed in is a dead end, not a form. Where
    they go instead is decided by `HomeRoute`, so this file has one answer to
    "where does a signed-in person belong" rather than three that can drift.
  */
  if (isAuthenticated) {
    return <Navigate to="/home" replace />;
  }

  return <LoginPage />;
}

/**
 * Sends a signed-in person to the surface their account belongs to
 * (ADR-034 §9).
 *
 * A route rather than a helper, because the answer is not known synchronously:
 * it comes from `/me`, and every caller would otherwise need its own waiting
 * state. Rendering the restore placeholder while that settles is what stops
 * the super admin seeing the agent workspace, or the reverse, for a frame.
 */
function HomeRoute() {
  const { isAuthenticated, isRestoring } = useAuth();
  const { user, isLoading } = useCurrentUser();

  if (isRestoring || (isAuthenticated && isLoading)) {
    return <AuthRestoring />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const home = homePathFor(user);
  return home === null ? <NoStaffSurface /> : <Navigate to={home} replace />;
}

/**
 * The private sign-in route (ADR-032 §14).
 *
 * Gated differently from `SignInRoute`, and the difference is the point. That
 * one bounces ANY signed-in visitor to the dashboard; this one bounces only
 * someone who already holds the grant, and shows the form to everyone else —
 * including a signed-in ordinary user, who may well be an operator sitting on
 * their own tenant account and wanting to switch to their staff one.
 *
 * The grant is read from `/me` rather than assumed, which costs one request on
 * a page almost nobody visits and avoids the alternative: rendering the form
 * for an admin who is already signed in, letting them retype a password they
 * did not need, and landing them exactly where they would have been anyway.
 */
function AdminSignInRoute() {
  const { isAuthenticated, isRestoring } = useAuth();
  const { user, isLoading } = useCurrentUser();

  if (isRestoring) {
    return <AuthRestoring />;
  }

  /*
    Not signed in is the ordinary case here, and it must NOT wait on `/me` —
    there is no session for that request to use, so waiting would hold the
    form behind a request that cannot answer.
  */
  if (!isAuthenticated) {
    return <AdminLoginPage />;
  }

  if (isLoading) {
    return <AuthRestoring />;
  }

  // Already an admin: signing in again is a dead end, not a form.
  if (isPlatformAdmin(user)) {
    return <Navigate to="/control" replace />;
  }

  return <AdminLoginPage />;
}

/**
 * Every route in the application.
 *
 * Deliberately flat and eager: a handful of routes does not justify layout
 * routes or lazy boundaries. `ARCHITECTURE.md` §3's code-split experience
 * zones become worth building when there are zones to split — and as of
 * ADR-032 there are two, the workspace and the operations console, which is
 * the first real argument for splitting this file that has existed. It is
 * still not enough: both zones are one page each today, and a lazy boundary
 * around a single component buys a spinner and no bytes.
 *
 * Customer-facing surfaces are absent by design, not omission: customers
 * never authenticate and reach Serviqo through an organisation's widget
 * (ADR-010, ADR-037).
 */
export function AppRoutes() {
  return (
    <Routes>
      {/*
        The landing page is deliberately NOT gated on the restore. It is public
        marketing, it renders the same either way, and holding it behind a
        placeholder would make every anonymous visitor wait on an auth request
        that cannot change what they see.
      */}
      <Route path="/" element={<LandingPage />} />

      {/*
        An organisation's customer chat link (ADR-038 §6) — the one customer
        surface in Serviqo. Outside every guard and never waiting on the auth
        restore: customers do not sign in (ADR-037), so there is no session
        whose arrival could change what this page shows.
      */}
      <Route path="/widget/:slug" element={<HostedWidgetPage />} />

      {/*
        The one staff sign-in page (ADR-037). `/agent/login` is kept as an alias
        because invitation emails already sent point at it.
      */}
      <Route path="/login" element={<SignInRoute />} />
      <Route path="/agent/login" element={<SignInRoute />} />

      {/*
        Deliberately NOT gated on the session, unlike the two routes above.
        This page is reached from a link in an email, frequently on a
        different device, and it must work for someone who is signed in as a
        DIFFERENT account — bouncing them to the dashboard would strand the
        address they were asked to verify.
      */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      {/*
        Password reset (ADR-036), ungated for the reason `/verify-email` is:
        the code form is opened from an email, often on another device, and
        somebody signed in as a different account there must still be able to
        use it. Bouncing a signed-in visitor would also be wrong in principle —
        a person who suspects their password has leaked may well be signed in
        when they decide to reset it.
      */}
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/*
        Where a signed-in person belongs, resolved once (ADR-034 §9).

        Every "you are already signed in" redirect in this file points here
        rather than guessing, because the answer depends on the account's kind
        and only the server knows it. One hop through a component that waits
        for `/me` is the cost of never showing somebody the wrong surface.
      */}
      <Route path="/home" element={<HomeRoute />} />

      {/*
        `/dashboard` was the customer's chat (ADR-034 §6) until ADR-037 removed
        customer accounts, and the agent workspace before that. Anything still
        pointing here is somebody who belongs on a staff surface, so it resolves
        through `/home` rather than falling through to the landing page.
      */}
      <Route path="/dashboard" element={<Navigate to="/home" replace />} />

      {/* The agent workspace (ADR-033). */}
      <Route
        path="/agent"
        element={
          <AgentRoute>
            <DashboardPage />
          </AgentRoute>
        }
      />

      {/*
        The operations console (ADR-032 §14), and the two routes in this file
        that NOTHING links to.

        Not a secret — `/control` is as guessable as any other word, and the
        server refuses every request behind it from anyone without the grant.
        Unlisted is a product decision about what belongs in the customer's
        experience, not a security control, and treating it as one would be the
        mistake. The reason it is worth doing anyway is that a support product
        whose marketing site advertises a staff door invites people to knock on
        it, and there is nothing to gain from the invitation.

        `/control/login` is deliberately declared BEFORE `/control`, even
        though React Router ranks by specificity rather than by order — the
        pair reads as "the door, then the room", and a future change to a
        wildcard child would otherwise silently swallow the login path.
      */}
      <Route path="/control/login" element={<AdminSignInRoute />} />

      <Route
        path="/control"
        element={<PlatformAdminRoute>{(user) => <AdminPortalPage user={user} />}</PlatformAdminRoute>}
      />

      {/* No 404 page yet; an unknown path returns to the landing page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
