/**
 * Sends a request carrying the in-memory access token, refreshing once and
 * retrying once if the server says the token is no longer good.
 *
 * Deliberately free of React and of the router: it takes what it needs as
 * dependencies, so it can be exercised without mounting anything, and so the
 * decision to sign someone out stays with the provider that owns the session.
 *
 * NOTE: this has no production caller yet. Nothing on the server consumes an
 * access token — ADR-012 §10 records that the verification middleware belongs
 * to the slice that first protects a route — so the first authenticated call
 * arrives with that slice. It is written and tested now because the retry
 * policy is a rule about the session, and the session is what this slice owns.
 */

/** What the wrapper needs from whoever holds the session. */
export interface AuthorizedRequestContext {
  /** The access token to present, or null when nothing is signed in. */
  getAccessToken: () => string | null;
  /**
   * Obtains a fresh access token, or rejects.
   *
   * The provider's implementation is single-flight and clears the session on
   * failure, so several requests expiring together produce ONE refresh — which
   * matters: concurrent refreshes race each other, and ADR-012 §4 answers the
   * losers with a 401 that would otherwise look like a failed refresh and sign
   * the user out mid-session.
   */
  refreshAccessToken: () => Promise<string>;
}

function withBearer(init: RequestInit, accessToken: string): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
  };
}

/**
 * Performs an authenticated request.
 *
 * On 401 it refreshes once and replays the request once — then returns
 * whatever that second attempt produced, even another 401. There is no loop
 * to bound because there is no recursion: the retry is a single straight-line
 * second call, so "exactly once" is structural rather than a counter someone
 * could get wrong.
 *
 * A refusal that arrives without a token having been sent is NOT retried. The
 * spec is "the access token expired", and nothing expired if nothing was
 * presented — refreshing there would spend a request answering a question the
 * provider's startup restore already asked.
 *
 * Rejects with the refresh failure when refreshing fails. The provider has
 * already cleared the session by then, so the redirect to /login follows from
 * `ProtectedRoute` seeing an unauthenticated tree — no imperative navigation
 * from inside a fetch helper.
 */
export async function authorizedRequest(
  path: string,
  init: RequestInit,
  { getAccessToken, refreshAccessToken }: AuthorizedRequestContext,
): Promise<Response> {
  const accessToken = getAccessToken();

  const response = await fetch(path, {
    // Same-origin, so the refresh cookie's Path scope keeps it off this call
    // (ADR-011 §12). The access token is the credential here.
    credentials: "same-origin",
    ...(accessToken === null ? init : withBearer(init, accessToken)),
  });

  if (response.status !== 401 || accessToken === null) {
    return response;
  }

  const refreshedToken = await refreshAccessToken();

  return fetch(path, {
    credentials: "same-origin",
    ...withBearer(init, refreshedToken),
  });
}
