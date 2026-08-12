import { Navigate } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
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
  const { isAuthenticated, isRestoring } = useAuth();

  /*
    Waiting is the whole point of this branch. Until the startup refresh
    settles, "not authenticated" means "not yet known" — redirecting on it
    would bounce a signed-in user to /login on every reload, then bounce them
    back once the token arrived (ADR-012 §8).
  */
  if (isRestoring) {
    return <AuthRestoring />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
