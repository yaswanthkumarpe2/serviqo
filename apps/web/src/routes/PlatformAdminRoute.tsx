import { Navigate } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { homePathFor, isPlatformAdmin } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";

import type { CurrentUser } from "@/features/auth/authApi";
import type { ReactNode } from "react";

interface PlatformAdminRouteProps {
  /**
   * Given the account the SERVER confirmed holds the grant.
   *
   * A function rather than a plain `ReactNode` so the console below is handed
   * the identity this guard already fetched. The alternative — children that
   * call `useCurrentUser` for themselves — would make every console load ask
   * `/me` twice for one answer.
   */
  children: (user: CurrentUser) => ReactNode;
}

/**
 * Gates the operations console (ADR-032 §13).
 *
 * Two gates, in order, because they fail differently. The SESSION gate sends
 * an unauthenticated visitor to the private sign-in page. The GRANT gate sends
 * a signed-in ordinary user to their own dashboard — not to an error, and not
 * to a page that says "you are not an admin", because the console is unlisted
 * and a refusal naming it would be the one thing that advertises it.
 *
 * Like `ProtectedRoute`, this is a UX control and not a security boundary: it
 * decides what to render, and the server decides what data anyone may have.
 * Every request the console makes is re-authorized by `requirePlatformAdmin`
 * against the database, so a client that forced its way past this guard would
 * render an empty shell and receive 403 from everything in it (SECURITY.md
 * §4 — "security relies entirely on server-side validation, never on the
 * client UI").
 */
export function PlatformAdminRoute({ children }: PlatformAdminRouteProps) {
  const { isAuthenticated, isRestoring } = useAuth();
  const { user, isLoading } = useCurrentUser();

  /*
    Waiting is the whole point of this branch, exactly as in `ProtectedRoute`:
    until the startup refresh settles, "not authenticated" means "not yet
    known", and redirecting on it would bounce a signed-in operator to the
    sign-in page on every reload (ADR-012 §8).
  */
  if (isRestoring) {
    return <AuthRestoring />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/control/login" replace />;
  }

  /*
    A second "not yet known" state, and the sharper one. `isAuthenticated` is
    true here but the grant is still unread, and treating an unread grant as
    "no grant" would redirect every admin to the dashboard for a frame on
    every single load.
  */
  if (isLoading) {
    return <AuthRestoring />;
  }

  /*
    Reached by an ordinary signed-in user who typed the address, and by an
    admin whose grant was revoked between loads. Both go to the dashboard,
    which is the surface they are entitled to — silently, because a message
    explaining why would confirm that a console exists here.

    `user === null` lands here too. It means `/me` failed for a reason that
    was not a 401 (a 401 signs out, and the branch above catches it), and the
    correct reading of "we could not confirm the grant" is "no grant".
  */
  if (!isPlatformAdmin(user)) {
    return <Navigate to={homePathFor(user)} replace />;
  }

  // Non-null by the guard above, which returns for every falsy case.
  return <>{children(user!)}</>;
}
