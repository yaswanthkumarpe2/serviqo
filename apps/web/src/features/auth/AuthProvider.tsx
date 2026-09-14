import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthContext } from "./AuthContext";
import { AuthApiError, logout, logoutAllDevices, refresh } from "./authApi";
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
        /*
          Only a refusal that means "this credential is not valid" ends the
          session (ADR-035 §3).

          This used to clear on EVERY failure, and that was a real way to lose
          a working session: a refresh refused by the rate limiter, a 500, or a
          dropped connection all read as "signed out", so the tab discarded a
          cookie the server would have honoured a second later. The rate-limit
          case was not hypothetical — the session class was keyed by IP, so a
          few tabs reloading could exhaust it and sign the person out.

          A 401 is different in kind. It is the server saying the cookie is
          gone, expired, or revoked, and there is nothing to preserve.
        */
        if (error instanceof AuthApiError && error.status === 401) {
          applySession(null);
        }

        /*
          Rethrown either way. The caller still has to know the refresh did not
          produce a token — `authorizedRequest` must not replay a request with
          a stale one, and the startup restore still has to lift its splash.
          What changes is only whether a session that might still be good was
          thrown away on the way past.
        */
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
   * Ends the session (ADR-013).
   *
   * Local state goes first, deliberately. The person has asked to leave, and
   * clearing synchronously means `ProtectedRoute` redirects on the next render
   * instead of after a network round trip — so signing out never feels like it
   * is waiting on anything.
   *
   * The server call then revokes the session and clears the `HttpOnly` cookie,
   * which this code cannot touch itself. That is the half that makes signing
   * out survive a reload.
   */
  const signOut = useCallback(async (): Promise<void> => {
    applySession(null);

    try {
      await logout();
    } catch {
      /*
        Best effort, and the right failure mode: the alternative is refusing to
        sign someone out because the network is down. The local session is
        already gone; the cookie may outlive it and restore this browser on the
        next reload, which is a worse outcome than a hung button but a better
        one than being unable to leave.
      */
    }
  }, [applySession]);

  /**
   * Ends every session this user holds, on every device (ADR-014).
   *
   * Mirrors `signOut` exactly — local state first so the redirect is
   * immediate, then the request. The difference is what a failure costs: a
   * failed `signOut` leaves one stale cookie, while a failed `signOutAll`
   * leaves the OTHER devices signed in, which is the opposite of what was
   * asked. The local session still clears, because refusing to sign someone
   * out of the browser in front of them helps nobody.
   */
  const signOutAllDevices = useCallback(async (): Promise<void> => {
    applySession(null);

    try {
      await logoutAllDevices();
    } catch {
      // Swallowed for the same reason `signOut` swallows, and with a worse
      // consequence — recorded in ADR-014's consequences as this slice's
      // weakest point, since the dashboard has no error surface to show it.
    }
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
      signOutAllDevices,
      authorizedFetch,
    }),
    [session, isRestoring, signIn, signOut, signOutAllDevices, authorizedFetch],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
