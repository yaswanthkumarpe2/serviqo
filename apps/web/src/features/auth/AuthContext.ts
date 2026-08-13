import { createContext } from "react";

import type { AuthenticatedUser } from "./authApi";

/**
 * The authenticated session, held in memory only.
 *
 * The access token deliberately never reaches `localStorage` or
 * `sessionStorage` (ADR-011 §1): it is a bearer credential, and anything
 * persisted there is readable by any script that gets onto the page. The
 * long-lived credential is the `HttpOnly` refresh cookie, which this code
 * cannot read by design.
 *
 * A full page reload therefore still wipes the session — that has not
 * changed and must not. What changed is what happens next: the provider asks
 * the refresh endpoint to mint a new access token from the cookie the browser
 * kept (ADR-012), so the reload is invisible to the user without the token
 * ever having been stored anywhere a script could read it.
 */
export interface Session {
  user: AuthenticatedUser;
  accessToken: string;
}

export interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  /**
   * True while the startup refresh is still in flight.
   *
   * Consumers that gate on `isAuthenticated` MUST check this first. Before the
   * restore settles, "not authenticated" only means "not yet known", and
   * acting on it is what sends a signed-in user to /login for a moment on
   * every reload.
   *
   * Kept as its own flag rather than folded into a status enum: `session` and
   * this are the two independent facts, and a third derived representation
   * would be one more thing that can disagree with them.
   */
  isRestoring: boolean;
  signIn: (session: Session) => void;
  /**
   * Ends the session: local state first, then the server (ADR-013).
   *
   * The returned promise settles when the server call does, but callers are
   * not required to await it — authentication state is already cleared by the
   * time it is handed back, so a protected route redirects on the very next
   * render rather than after a round trip.
   */
  signOut: () => Promise<void>;
  /**
   * Ends every session this user holds, on every device (ADR-014), including
   * the one calling. Clears local state before the request settles, exactly
   * like `signOut`.
   */
  signOutAllDevices: () => Promise<void>;
  /**
   * Performs a request carrying the access token, refreshing and retrying once
   * if it has expired. Rejects — after clearing the session — when the refresh
   * itself fails.
   */
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Undefined rather than a default object, so `useAuth` can tell "no provider
 * above me" from "provider present, nobody signed in" and fail loudly on the
 * first instead of silently reporting a logged-out user.
 */
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
