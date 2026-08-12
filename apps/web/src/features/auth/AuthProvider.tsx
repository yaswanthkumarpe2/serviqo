import { useCallback, useMemo, useState } from "react";

import { AuthContext } from "./AuthContext";

import type { Session } from "./AuthContext";
import type { ReactNode } from "react";

interface AuthProviderProps {
  children: ReactNode;
  /** Seeds the session. Tests use it to render an authenticated tree directly. */
  initialSession?: Session | null;
}

/**
 * Holds the session for the lifetime of the page (see AuthContext for why it
 * is memory-only). No effects, no storage listeners, no timers — signing out
 * is the single way a session ends in this slice, since token expiry cannot
 * be acted on until there is a refresh flow to act with.
 */
export function AuthProvider({ children, initialSession = null }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(initialSession);

  const signIn = useCallback((next: Session) => {
    setSession(next);
  }, []);

  /**
   * Drops the in-memory token. The refresh cookie is `HttpOnly`, so this
   * cannot clear it — only the server can, and the endpoint that does is the
   * logout slice. Until then the cookie outlives the session it belonged to;
   * it grants nothing on its own, because nothing consumes it yet.
   */
  const signOut = useCallback(() => {
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ session, isAuthenticated: session !== null, signIn, signOut }),
    [session, signIn, signOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
