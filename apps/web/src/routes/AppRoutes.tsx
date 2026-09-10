import { Navigate, Route, Routes } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { useAuth } from "@/features/auth/useAuth";
import { LoginPage } from "@/pages/auth/LoginPage";
import { SignUpPage } from "@/pages/auth/SignUpPage";
import { VerifyEmailPage } from "@/pages/auth/VerifyEmailPage";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { LandingPage } from "@/pages/marketing/LandingPage";

import { ProtectedRoute } from "./ProtectedRoute";

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

  // Signing in again while already signed in is a dead end, not a form.
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <LoginPage />;
}

/**
 * The sign-up route, gated the same way `SignInRoute` is and for the same
 * reason: someone already signed in has no use for a registration form, and
 * rendering it for a frame during the restore is the flicker that gating
 * exists to remove.
 */
function SignUpRoute() {
  const { isAuthenticated, isRestoring } = useAuth();

  if (isRestoring) {
    return <AuthRestoring />;
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <SignUpPage />;
}

/**
 * Every route in the application.
 *
 * Deliberately flat and eager: a handful of routes does not justify layout
 * routes or lazy boundaries. `ARCHITECTURE.md` §3's code-split experience zones become
 * worth building when there are zones to split — the agent workspace and
 * admin areas do not exist.
 *
 * Customer-facing surfaces are absent by design, not omission: customers
 * never authenticate and reach Serviqo through the widget (ADR-010).
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

      <Route path="/login" element={<SignInRoute />} />

      <Route path="/signup" element={<SignUpRoute />} />

      {/*
        Deliberately NOT gated on the session, unlike the two routes above.
        This page is reached from a link in an email, frequently on a
        different device, and it must work for someone who is signed in as a
        DIFFERENT account — bouncing them to the dashboard would strand the
        address they were asked to verify.
      */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />

      {/* No 404 page yet; an unknown path returns to the landing page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
