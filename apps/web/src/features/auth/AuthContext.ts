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
 * The consequence is real and intentional: a full page reload clears the
 * session and returns the user to /login. Rehydrating it silently is what
 * the refresh endpoint is for, and that slice has not been built.
 */
export interface Session {
  user: AuthenticatedUser;
  accessToken: string;
}

export interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  signIn: (session: Session) => void;
  signOut: () => void;
}

/**
 * Undefined rather than a default object, so `useAuth` can tell "no provider
 * above me" from "provider present, nobody signed in" and fail loudly on the
 * first instead of silently reporting a logged-out user.
 */
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
