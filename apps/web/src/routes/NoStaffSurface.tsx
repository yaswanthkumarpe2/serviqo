import { useEffect } from "react";
import { Navigate } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { useAuth } from "@/features/auth/useAuth";

/**
 * Where a signed-in session goes when no staff surface will have it (ADR-037).
 *
 * Every guard in this directory used to answer "not yours" with "go to the one
 * that is", and that works only while every account has one. An account that
 * belongs on neither the workspace nor the console — a legacy customer account,
 * a super admin whose grant was revoked, or `/me` failing for a reason that was
 * not a 401 — would be bounced between two guards that each point at the other.
 *
 * So this ends the loop instead of joining it: it signs the browser out and
 * shows the sign-in page. Silently, like the redirects it replaces, because a
 * message explaining why would tell somebody which surface exists.
 */
export function NoStaffSurface() {
  const { isAuthenticated, signOut } = useAuth();

  useEffect(() => {
    if (isAuthenticated) void signOut();
  }, [isAuthenticated, signOut]);

  // Held on the placeholder until the session is gone, so `/login` does not
  // see an authenticated visitor and send them straight back to `/home`.
  if (isAuthenticated) return <AuthRestoring />;

  return <Navigate to="/login" replace />;
}
