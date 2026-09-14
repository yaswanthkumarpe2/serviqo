import { Navigate } from "react-router-dom";

import { AuthRestoring } from "@/features/auth/AuthRestoring";
import { homePathFor, isAdminKind, isAgent } from "@/features/auth/authApi";
import { useAuth } from "@/features/auth/useAuth";
import { useCurrentUser } from "@/features/auth/useCurrentUser";

import type { ReactNode } from "react";

interface CustomerRouteProps {
  children: ReactNode;
}

/**
 * Gates the customer dashboard (ADR-034 §9).
 *
 * The mirror of `AgentRoute`, and deliberately a separate component rather than
 * one parameterised guard. They send people to different places for different
 * reasons, and a single `RequireKind` would make both destinations arguments at
 * a call site instead of decisions with reasons written next to them.
 *
 * An agent who lands here is sent to their workspace. Not refused: an agent
 * following an old bookmark has done nothing wrong, and the workspace is the
 * thing they were looking for.
 */
export function CustomerRoute({ children }: CustomerRouteProps) {
  const { isAuthenticated, isRestoring } = useAuth();
  const { user, isLoading } = useCurrentUser();

  if (isRestoring) {
    return <AuthRestoring />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  /*
    Waiting on `/me`, for the reason every guard here waits: treating an unread
    kind as a decision would flash the wrong surface on every load.
  */
  if (isLoading) {
    return <AuthRestoring />;
  }

  /*
    Staff of either kind go to their own surface. Asked of `homePathFor` rather
    than hardcoded, so an admin reaches the console instead of a workspace that
    would refuse them (ADR-035 §4).
  */
  if (isAgent(user) || isAdminKind(user)) {
    return <Navigate to={homePathFor(user)} replace />;
  }

  /*
    `user === null` renders the dashboard rather than redirecting, and the
    asymmetry with `AgentRoute` is deliberate. Failing to confirm an account is
    an agent must not grant the staff surface; failing to confirm it is a
    customer costs nothing, because the customer surface shows only what the
    server will hand this token anyway — and the page states the load failure
    itself.
  */
  return <>{children}</>;
}
