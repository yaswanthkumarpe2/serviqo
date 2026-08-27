import { Navigate, Route, Routes } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { useAuth } from "@/features/auth/useAuth";
import { LoginPage } from "@/pages/auth/LoginPage";
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
 * Every route in the application.
 *
 * Deliberately flat and eager: three routes do not justify layout routes or
 * lazy boundaries. `ARCHITECTURE.md` §3's code-split experience zones become
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
