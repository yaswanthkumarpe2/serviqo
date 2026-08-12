import { Navigate } from "react-router-dom";

import { useAuth } from "@/features/auth/useAuth";

import type { ReactNode } from "react";

interface ProtectedRouteProps {
  children: ReactNode;
}

/**
 * Gates a route on there being a session in memory.
 *
 * This is a UX control, not a security boundary: it decides what to render,
 * and the server decides what data anyone may have. Every protected API call
 * is authorized server-side regardless of what this component does
 * (SECURITY.md §4 — "security relies entirely on server-side validation,
 * never on the client UI").
 *
 * `replace` keeps the unauthenticated attempt out of history, so Back does
 * not bounce between the guard and the login page.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
