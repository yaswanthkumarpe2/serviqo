import { AuthApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE, unwrapEnvelope } from "@/features/auth/authApi";

/**
 * Client for the platform operations endpoints (ADR-032 §3).
 *
 * The envelope reader and its error type come from the auth feature — the
 * same reuse `membersApi.ts`, `organizationsApi.ts` and `inboxApi.ts` already
 * established, so there is one definition of what a Serviqo response looks
 * like rather than another copy per feature folder.
 *
 * Every call here goes through `authorizedFetch` and is refused for anyone
 * whose account does not hold the grant. This module renders nothing and
 * decides nothing about who may call it: the console is unlisted, which is a
 * discoverability decision, and `requirePlatformAdmin` is the boundary.
 */

const ADMIN_BASE = "/api/v1/admin";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface PlatformOverview {
  totals: {
    organizations: number;
    users: number;
    customers: number;
    conversations: number;
    messages: number;
  };
  users: {
    verified: number;
    unverified: number;
    disabled: number;
    platformAdmins: number;
  };
  conversations: {
    open: number;
    closed: number;
    unassigned: number;
  };
}

/**
 * One tenant, as the console shows it.
 *
 * `owner` is `null` for an organization whose owning membership does not
 * resolve — a real state rather than an error (ADR-016 §3), and precisely the
 * record an operator would be called in to look at, so the row renders
 * instead of being dropped.
 */
export interface PlatformOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  /** The organisation's customer chat link (ADR-038). */
  widgetUrl: string;
  status: string;
  hasWidgetKey: boolean;
  allowedOriginCount: number;
  memberCount: number;
  conversationCount: number;
  owner: { id: string; name: string; email: string } | null;
  createdAt: string;
}

/** One staff account, as the console shows it. */
export interface PlatformUserSummary {
  id: string;
  name: string;
  email: string;
  status: string;
  /** Null means the address was never confirmed — the state that blocks sign-in. */
  emailVerifiedAt: string | null;
  platformRole: string;
  /**
   * `"agent"` or `"admin"` — or `"customer"` for an account ADR-034 created
   * before ADR-037 removed customer accounts. Shown as stored.
   */
  kind: string;
  membershipCount: number;
  createdAt: string;
}

/**
 * Performs one admin call and unwraps it.
 *
 * A transport failure becomes an `AuthApiError` with status 0 rather than a
 * raw `TypeError`, so every caller branches on one error type — what lets the
 * console tell "the server refused" from "the server was not reachable".
 */
async function callAdmin<T>(authorizedFetch: AuthorizedFetch, path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await authorizedFetch(path, init);
  } catch (error) {
    // The refresh behind the retry failed, and it already described itself.
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<T>(response);
}

/**
 * The totals.
 *
 * Checked rather than asserted, for the reason `fetchCurrentUser` checks its
 * user: `unwrapEnvelope` proves the ENVELOPE and nothing about what is inside
 * it, so a body of `{ success: true, data: {} }` satisfies it and hands back
 * an object whose `totals` is `undefined` — which then throws inside render,
 * taking the whole console down over a malformed response.
 *
 * Failing here instead turns that into the console's ordinary error state,
 * where the tenant and account lists it DID receive still render
 * (`usePlatformConsole` lets the three fail independently).
 */
export async function fetchPlatformOverview(authorizedFetch: AuthorizedFetch): Promise<PlatformOverview> {
  const overview = await callAdmin<unknown>(authorizedFetch, `${ADMIN_BASE}/overview`);

  if (!isPlatformOverview(overview)) {
    throw new AuthApiError(UNEXPECTED_RESPONSE, "The server sent an overview this client could not read.", 200);
  }

  return overview;
}

/** Narrows on the three groups the console renders; individual counts default to 0 on the server. */
function isPlatformOverview(value: unknown): value is PlatformOverview {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlatformOverview>;
  return (
    typeof candidate.totals === "object" &&
    candidate.totals !== null &&
    typeof candidate.users === "object" &&
    candidate.users !== null &&
    typeof candidate.conversations === "object" &&
    candidate.conversations !== null
  );
}

/**
 * The tenant list.
 *
 * Defends against a well-formed envelope with no list, the same way
 * `membersApi.ts` does: `unwrapEnvelope` proves the envelope's SHAPE and
 * nothing about what is inside it, and rendering code that mapped over
 * `undefined` would throw during render and take the console down with it.
 */
export async function fetchPlatformOrganizations(
  authorizedFetch: AuthorizedFetch,
): Promise<{ organizations: PlatformOrganizationSummary[]; total: number }> {
  const page = await callAdmin<{ organizations?: unknown; total?: unknown }>(
    authorizedFetch,
    `${ADMIN_BASE}/organizations`,
  );

  const organizations = Array.isArray(page?.organizations)
    ? (page.organizations as PlatformOrganizationSummary[])
    : [];

  return { organizations, total: typeof page?.total === "number" ? page.total : organizations.length };
}

export async function fetchPlatformUsers(
  authorizedFetch: AuthorizedFetch,
): Promise<{ users: PlatformUserSummary[]; total: number }> {
  const page = await callAdmin<{ users?: unknown; total?: unknown }>(authorizedFetch, `${ADMIN_BASE}/users`);

  const users = Array.isArray(page?.users) ? (page.users as PlatformUserSummary[]) : [];

  return { users, total: typeof page?.total === "number" ? page.total : users.length };
}

/**
 * Adds a support agent (ADR-034 §7).
 *
 * The body carries a name and an address and nothing else. There is
 * deliberately no password to send — the server generates one and emails it —
 * and no role or status either: the request schema is `.strict()`, so a body
 * carrying them is refused rather than silently stripped.
 *
 * The response carries no password either. It exists in exactly one place, the
 * email, and echoing it back would put a working credential into every log and
 * proxy between here and the server.
 */
export type InvitableRole = "owner" | "admin" | "supervisor" | "agent";

export interface InvitedMember {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: InvitableRole;
  status: string;
  verified: boolean;
  joinedAt: string;
}

export interface CreatedOrganizationResult {
  organization: { id: string; name: string; slug: string; status: string; widgetUrl: string; createdAt: string };
  owner: InvitedMember;
  /** False when the owner already had a staff account and was simply added. */
  accountCreated: boolean;
}

/** Creates an organisation and invites its owner (ADR-039 §1). */
export function createOrganizationWithOwner(
  authorizedFetch: AuthorizedFetch,
  input: { name: string; owner: { name: string; email: string } },
): Promise<CreatedOrganizationResult> {
  return callAdmin<CreatedOrganizationResult>(authorizedFetch, `${ADMIN_BASE}/organizations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Suspends or reactivates an organisation (ADR-039 §2). */
export async function updateOrganizationStatus(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  status: "active" | "suspended",
): Promise<void> {
  await callAdmin<unknown>(authorizedFetch, `${ADMIN_BASE}/organizations/${encodeURIComponent(organizationId)}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

/** Invites a person into an organisation in any role, including an owner where there is none (ADR-039 §3). */
export function inviteOrganizationMember(
  authorizedFetch: AuthorizedFetch,
  organizationId: string,
  input: { name: string; email: string; role: InvitableRole },
): Promise<{ member: InvitedMember; accountCreated: boolean }> {
  return callAdmin<{ member: InvitedMember; accountCreated: boolean }>(
    authorizedFetch,
    `${ADMIN_BASE}/organizations/${encodeURIComponent(organizationId)}/members`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}
