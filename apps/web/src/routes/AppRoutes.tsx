import { Navigate, Route, Routes } from "react-router-dom";

import { useAuth } from "@/features/auth/useAuth";
import { LoginPage } from "@/pages/auth/LoginPage";
import { DashboardPage } from "@/pages/dashboard/DashboardPage";
import { LandingPage } from "@/pages/marketing/LandingPage";

import { ProtectedRoute } from "./ProtectedRoute";

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
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />

      {/* Signing in again while already signed in is a dead end, not a form. */}
      <Route path="/login" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />} />

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
