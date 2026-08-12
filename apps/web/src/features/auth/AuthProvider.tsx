import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthContext } from "./AuthContext";
import { refresh } from "./authApi";
import { authorizedRequest } from "./authorizedRequest";

import type { Session } from "./AuthContext";
import type { ReactNode } from "react";

interface AuthProviderProps {
  children: ReactNode;
  /**
   * Seeds the session. Tests use it to render an authenticated tree directly.
   *
   * A seeded session also suppresses the startup refresh, which is the rule
   * itself rather than a testing shortcut: the restore exists to recover a
   * session when no access token is in memory, and here one already is.
   */
  initialSession?: Session | null;
}

/**
 * Owns the session for the lifetime of the page, and the one refresh that
 * recovers it after a reload (ADR-012).
 *
 * The token still lives only in memory and only in this component's state.
 * Nothing here writes to `localStorage` or `sessionStorage`, and nothing can:
 * the only durable credential is the `HttpOnly` cookie, which the browser
 * attaches to the refresh call and this code never sees.
 */
export function AuthProvider({ children, initialSession = null }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(initialSession);
  const [isRestoring, setIsRestoring] = useState(initialSession === null);

  /**
   * Mirrors `session` for readers outside the render cycle.
   *
   * `authorizedFetch` may be called long after it was created, and a closure
   * over the state variable would hand it whichever token was current when the
   * callback was built — reliably the wrong one right after a refresh.
   */
  const sessionRef = useRef<Session | null>(initialSession);

  const applySession = useCallback((next: Session | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  /**
   * The single refresh in flight, if any.
   *
   * Coalescing is a correctness requirement, not an optimization. Rotation is
   * a compare-and-swap on the cookie's secret (ADR-012 §6), so two refreshes
   * fired together mean one wins and the other is answered by the grace
   * window with a 401 (§4). Left uncoalesced, that 401 reads as "refresh
   * failed" and signs out a user whose session was never in doubt.
   */
  const inFlightRefresh = useRef<Promise<string> | null>(null);

  const refreshAccessToken = useCallback((): Promise<string> => {
    inFlightRefresh.current ??= refresh()
      .then((result) => {
        applySession({ user: result.user, accessToken: result.accessToken });
        return result.accessToken;
      })
      .catch((error: unknown) => {
        // The cookie is gone, expired, or was revoked. Whatever the reason,
        // this tab is not signed in — and saying so is what makes
        // ProtectedRoute redirect.
        applySession(null);
        throw error;
      })
      .finally(() => {
        inFlightRefresh.current = null;
      });

    return inFlightRefresh.current;
  }, [applySession]);

  /**
   * Guards the one startup attempt.
   *
   * StrictMode mounts, unmounts and remounts every component in development,
   * so without this the restore would fire twice — and the second would race
   * the first into exactly the grace-window 401 described above.
   */
  const hasAttemptedRestore = useRef(false);

  useEffect(() => {
    if (hasAttemptedRestore.current) return;
    hasAttemptedRestore.current = true;

    // An access token is already in memory; there is nothing to recover.
    if (initialSession !== null) return;

    void refreshAccessToken()
      // A visitor who was never signed in has no cookie, and the 401 that
      // follows is the ordinary answer — not a failure worth surfacing.
      .catch(() => undefined)
      // Runs on both paths and is deliberately not guarded by a mounted flag:
      // StrictMode's cleanup would trip such a guard before the request
      // settles, and the splash would then never lift.
      .finally(() => setIsRestoring(false));
  }, [initialSession, refreshAccessToken]);

  const signIn = useCallback(
    (next: Session) => {
      applySession(next);
    },
    [applySession],
  );

  /**
   * Drops the in-memory token. The refresh cookie is `HttpOnly`, so this
   * cannot clear it — only the server can, and the endpoint that does is the
   * logout slice. Until then the cookie outlives the session it belonged to,
   * which means this tab could restore itself on the next reload.
   */
  const signOut = useCallback(() => {
    applySession(null);
  }, [applySession]);

  const authorizedFetch = useCallback(
    (path: string, init: RequestInit = {}) =>
      authorizedRequest(path, init, {
        getAccessToken: () => sessionRef.current?.accessToken ?? null,
        refreshAccessToken,
      }),
    [refreshAccessToken],
  );

  const value = useMemo(
    () => ({
      session,
      isAuthenticated: session !== null,
      isRestoring,
      signIn,
      signOut,
      authorizedFetch,
    }),
    [session, isRestoring, signIn, signOut, authorizedFetch],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
