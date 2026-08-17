import { useEffect, useRef, useState } from "react";

import { AuthApiError, fetchCurrentUser } from "./authApi";
import { useAuth } from "./useAuth";

import type { CurrentUser } from "./authApi";

/**
 * Loads the signed-in account from `GET /auth/me` (ADR-015).
 *
 * The identity a page displays comes from the server on every mount rather
 * than from the login response held in session state. Those agree today, but
 * only one of them is authoritative, and a page that renders the other is a
 * page showing a name that was true when the user signed in.
 */

export interface CurrentUserState {
  user: CurrentUser | null;
  /** True until the first answer arrives. Nothing real is known before it settles. */
  isLoading: boolean;
  /**
   * A failure that is not an authentication problem — the network, or a
   * response this client could not read. A 401 is deliberately absent from
   * this: it is not an error to show, it is a sign-out.
   */
  error: string | null;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your account. Please try again.";

export function useCurrentUser(): CurrentUserState {
  const { authorizedFetch, signOut } = useAuth();
  const [state, setState] = useState<CurrentUserState>({ user: null, isLoading: true, error: null });

  /**
   * Guards the one load per mount.
   *
   * StrictMode mounts, unmounts and remounts in development, and the effect's
   * dependencies are provider callbacks that change identity when the session
   * does — which a refresh inside this very call would cause. Without this,
   * a successful refresh would re-run the effect that triggered it.
   */
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;

    /*
      Deliberately not guarded by a mounted flag, for the reason AuthProvider's
      startup restore records: StrictMode's cleanup would trip such a guard
      before the request settles, and combined with the ref above there would
      be no second attempt to lift the loading state. A state update after
      unmount is a no-op in React 18+.
    */
    void fetchCurrentUser(authorizedFetch)
      .then((user) => setState({ user, isLoading: false, error: null }))
      .catch((error: unknown) => {
        /*
          A 401 here has already been through `authorizedRequest`'s one
          refresh and one replay. Surviving that means the credential cannot
          be recovered — a revoked session whose refresh also failed, or an
          account the server has stopped serving (ADR-015 §7).

          Signing out is the correct response and the one that reaches
          /login: it clears the session, so `ProtectedRoute` redirects on the
          next render. No imperative navigation from inside a data hook.

          When the refresh itself failed, the provider has ALREADY cleared the
          session and this is redundant — harmlessly so, and cheaper than a
          branch that would have to tell the two apart correctly.
        */
        if (error instanceof AuthApiError && error.status === 401) {
          void signOut();
          setState({ user: null, isLoading: false, error: null });
          return;
        }

        // Anything else is worth showing. The message is this client's own —
        // a server message is display text, and a transport error's can name
        // internal hosts.
        setState({ user: null, isLoading: false, error: GENERIC_FAILURE_MESSAGE });
      });
  }, [authorizedFetch, signOut]);

  return state;
}
