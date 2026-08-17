import { AuthApiError, NETWORK_ERROR, unwrapEnvelope } from "@/features/auth/authApi";

/**
 * Client for the organization endpoints (ADR-016).
 *
 * The envelope reader and its error type are imported from the auth feature
 * rather than reimplemented. Both are API-wide rather than auth-specific —
 * `authApi.ts` records that the rename to `ApiError` and the move out of that
 * folder belong to the slice with a third consumer. Reusing them keeps one
 * definition of what a Serviqo response looks like.
 */

const ORGANIZATIONS_BASE = "/api/v1/organizations";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

/** The tenant, exactly as the creation endpoint reports it (ADR-016 §8). */
export interface CreatedOrganization {
  id: string;
  name: string;
  /** Derived server-side from the name; the client never chooses one. */
  slug: string;
  status: string;
  createdAt: string;
}

export interface CreateOrganizationResult {
  organization: CreatedOrganization;
  /** The caller's role in what they just created — always `"owner"`. */
  role: string;
}

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Creates an organization owned by the caller.
 *
 * Goes through `authorizedFetch` rather than `fetch`: the endpoint requires a
 * bearer token, and that wrapper attaches the in-memory one and refreshes
 * once on a 401 (ADR-012 §4).
 *
 * The body carries a name and nothing else. There is deliberately no `slug`
 * and no `ownerUserId` to pass — the slug is derived server-side and the
 * owner is the token's subject, so neither is the client's to choose
 * (ADR-016 §1, §5).
 */
export async function createOrganization(
  authorizedFetch: AuthorizedFetch,
  name: string,
): Promise<CreateOrganizationResult> {
  let response: Response;

  try {
    response = await authorizedFetch(ORGANIZATIONS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    // The refresh behind the retry failed, and it already described itself.
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<CreateOrganizationResult>(response);
}
