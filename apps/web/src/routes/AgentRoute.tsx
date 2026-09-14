import { Navigate } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { homePathFor, isAgent } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";

import { NoStaffSurface } from "./NoStaffSurface";

import type { ReactNode } from "react";

interface AgentRouteProps {
  children: ReactNode;
}

/**
 * Gates the agent workspace (ADR-034 §9).
 *
 * Two gates that fail differently, the same shape `PlatformAdminRoute` uses.
 * The SESSION gate sends an anonymous visitor to the staff sign-in page. The
 * KIND gate sends the super admin to the console, silently, and signs out any
 * session that belongs on no staff surface at all (ADR-037).
 *
 * A UX control and not a security boundary, like every route guard here. The
 * server re-proves membership and permission on every request the workspace
 * makes, so a client that forced its way past this renders a shell and gets
 * 403s inside it (SECURITY.md §4).
 */
export function AgentRoute({ children }: AgentRouteProps) {
  const { isAuthenticated, isRestoring } = useAuth();
  const { user, isLoading } = useCurrentUser();

  /*
    Until the startup refresh settles, "not authenticated" means "not yet
    known", and acting on it would bounce a signed-in agent to the sign-in page
    on every reload (ADR-012 §8).
  */
  if (isRestoring) {
    return <AuthRestoring />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  /*
    The second "not yet known", and the sharper one: `isAuthenticated` is true
    but the account's kind is still unread, and treating that as "not an
    agent" would send every agent somewhere else for a frame on every load.
  */
  if (isLoading) {
    return <AuthRestoring />;
  }

  /*
    Everyone who is not an agent goes to whichever surface IS theirs, rather
    than to a hardcoded one — and when no surface is theirs, the session ends
    rather than bouncing between guards (`NoStaffSurface`).

    `user === null` lands here too. It means `/me` failed for a reason that was
    not a 401 — a 401 signs out and the branch above catches it — and the right
    reading of "we could not confirm this is an agent" is that it is not.
  */
  if (!isAgent(user)) {
    const home = homePathFor(user);
    return home === null || home === "/agent" ? <NoStaffSurface /> : <Navigate to={home} replace />;
  }

  return <>{children}</>;
}
