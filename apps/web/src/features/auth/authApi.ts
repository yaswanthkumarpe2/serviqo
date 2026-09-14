/**
 * Client for the organization-user authentication endpoints.
 *
 * Requests go to a same-origin `/api/v1` path, which Vite proxies to the
 * backend in development. Same-origin is not a convenience: the refresh
 * cookie is `SameSite=Strict` and `Path=/api/v1/auth`, so a cross-origin
 * call would never receive it.
 *
 * Customers never authenticate (ADR-010), so there is deliberately no
 * customer or visitor client here.
 */

const AUTH_BASE = "/api/v1/auth";

/** One field-level issue, matching the server's failure envelope. */
export interface ApiValidationIssue {
  field: string;
  message: string;
}

/** The authenticated user, exactly as the login endpoint reports it. */
export interface AuthenticatedUser {
  /**
   * Which staff surface this account belongs on (ADR-034 §1, ADR-037).
   *
   * Reported by LOGIN as well as `/me`, because it decides where the browser
   * goes next — an agent to the workspace, the super admin to the console —
   * and making that wait for a second request would show the wrong shell for
   * a frame first.
   */
  kind?: string;
  id: string;
  name: string;
  email: string;
}

/**
 * The caller's own account, as `GET /auth/me` reports it (ADR-015 §9).
 *
 * Wider than `AuthenticatedUser` and deliberately a separate type, matching
 * the server's split: login says the minimum needed to know a sign-in worked,
 * while this is the dashboard's view of an account it has already proved it
 * owns.
 *
 * Timestamps are ISO-8601 strings, because that is what JSON carries — the
 * server's `Date` does not survive the wire, and pretending otherwise here
 * would be a type that lies.
 *
 * No `organizationId` and no `role`: nothing creates a Membership yet, and
 * "current organization" is not a concept this architecture has. That arrives
 * with organization onboarding, on its own endpoint.
 */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  status: string;
  emailVerifiedAt: string;
  /**
   * Whether this account operates Serviqo itself (ADR-032 §6).
   *
   * `"none"` for very nearly everyone, and the only value that matters to
   * this client is `"admin"` — it decides which of the two surfaces to send
   * someone to after they sign in.
   *
   * An AFFORDANCE and never a boundary. Editing this value in a debugger
   * renders the console shell and nothing in it: every request that shell
   * makes is refused by `requirePlatformAdmin`, which re-reads the grant from
   * the database and does not ask the client (SECURITY.md §4).
   *
   * Typed as `string` rather than a union, like `status` and `role` beside
   * it. This is a value the server sent, and narrowing it here would mean a
   * new platform role became a type error in the browser rather than a value
   * the client simply does not recognise.
   */
  platformRole: string;
  /**
   * Which product this account signed up for (ADR-034 §1).
   *
   * An affordance, never a boundary: a client that changed this would render
   * the other surface and be refused by every request that surface makes —
   * `requireCustomerAccount` turns away agents and `requirePermission` turns
   * away customers, both read from the database on the request.
   */
  kind: string;
  createdAt: string;
}

/**
 * One organization the caller belongs to, and their standing in it
 * (ADR-017 §9).
 *
 * The server lists only organizations the caller can actually enter — active
 * memberships in active organizations — so every entry here is a valid
 * switcher option rather than one that 404s when chosen.
 */
export interface CurrentUserMembership {
  membershipId: string;
  /** From the database. Display only — it authorizes nothing client-side. */
  role: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
}

/**
 * The `/me` payload: who the caller is, and where they work.
 *
 * `memberships` is a LIST and never a selection — the server has no notion of
 * a "current" organization. The client chooses, and the server re-proves that
 * choice on every request (ADR-017 §1, §10).
 */
export interface CurrentUserResult {
  user: CurrentUser;
  /** Empty for a user who has registered and not yet onboarded. Never fabricated. */
  memberships: CurrentUserMembership[];
}

export interface LoginResult {
  user: AuthenticatedUser;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/**
 * Refresh answers with the same three fields login does (ADR-012 §8), which
 * is what lets a reloaded tab learn who it is without a second round trip.
 * Aliased rather than redeclared so the two can never drift apart here while
 * agreeing on the server.
 */
export type RefreshResult = LoginResult;

export interface LoginCredentials {
  email: string;
  password: string;
}

/**
 * A failure the server described in its own envelope, or a transport
 * failure this client had to name itself.
 *
 * `code` is what callers branch on — never the message, which is display
 * text the server is free to reword.
 */
export class AuthApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: ApiValidationIssue[];

  constructor(code: string, message: string, status: number, issues: ApiValidationIssue[] = []) {
    super(message);
    this.name = "AuthApiError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

/** Codes this client produces itself, for failures that never reached the server. */
export const NETWORK_ERROR = "NETWORK_ERROR";
export const UNEXPECTED_RESPONSE = "UNEXPECTED_RESPONSE";

const GENERIC_NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
const GENERIC_FAILURE_MESSAGE = "Something went wrong. Please try again.";

interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

interface FailureEnvelope {
  success: false;
  error: { code: string; message: string; details?: ApiValidationIssue[] };
}

function isFailureEnvelope(body: unknown): body is FailureEnvelope {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<FailureEnvelope>;
  return candidate.success === false && typeof candidate.error?.code === "string";
}

function isSuccessEnvelope<T>(body: unknown): body is SuccessEnvelope<T> {
  if (typeof body !== "object" || body === null) return false;
  return (body as Partial<SuccessEnvelope<T>>).success === true;
}

/**
 * Turns a response into its `data`, or raises `AuthApiError`.
 *
 * Split out from `postAuth` when `/me` became the first GET: the envelope is
 * the API's shape rather than any one verb's, and a second copy of this is a
 * second place for the agreement to rot.
 *
 * Exported for the same reason it was split out. The organizations client
 * reads the identical envelope, and duplicating twenty lines of it there
 * would be that second copy. `AuthApiError` travels with it and is likewise
 * API-wide rather than auth-specific — the rename to `ApiError`, and the
 * move of both out of this feature folder, belongs to the slice that adds a
 * third consumer rather than to this one.
 */
export async function unwrapEnvelope<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isFailureEnvelope(body)) {
      throw new AuthApiError(body.error.code, body.error.message, response.status, body.error.details ?? []);
    }
    throw new AuthApiError(UNEXPECTED_RESPONSE, GENERIC_FAILURE_MESSAGE, response.status);
  }

  if (!isSuccessEnvelope<T>(body)) {
    throw new AuthApiError(UNEXPECTED_RESPONSE, GENERIC_FAILURE_MESSAGE, response.status);
  }

  return body.data;
}

/**
 * POSTs to an auth endpoint and unwraps the envelope, raising `AuthApiError`
 * for every failure — transport, server-described, or unrecognized.
 *
 * Shared by login and refresh so envelope handling exists once. The two
 * endpoints answer with the same shape (ADR-012 §8); handling it twice would
 * be two places for that agreement to rot.
 */
async function postAuth<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      // Sends and accepts the refresh cookie. Same-origin already implies
      // this, but stating it keeps the call correct if the API ever moves.
      credentials: "same-origin",
      ...init,
    });
  } catch {
    // The original error is not attached: a transport failure's message can
    // name internal hosts, and it tells the person at the keyboard nothing.
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  return unwrapEnvelope<T>(response);
}

/**
 * POSTs to an auth endpoint that answers 204 with no body.
 *
 * Separate from `postAuth` because `unwrapEnvelope` requires a success
 * envelope and a 204 has nothing to unwrap — passing one through it would
 * turn every success into `UNEXPECTED_RESPONSE`. A FAILURE still carries the
 * usual envelope, so errors are read the same way as everywhere else.
 */
async function postAuthNoContent(path: string, init: RequestInit = {}): Promise<void> {
  let response: Response;

  try {
    response = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      credentials: "same-origin",
      ...init,
    });
  } catch {
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  if (response.ok) return;

  const body: unknown = await response.json().catch(() => null);
  if (isFailureEnvelope(body)) {
    throw new AuthApiError(body.error.code, body.error.message, response.status, body.error.details ?? []);
  }
  throw new AuthApiError(UNEXPECTED_RESPONSE, GENERIC_FAILURE_MESSAGE, response.status);
}

export interface VerifyEmailInput {
  email: string;
  code: string;
}

/**
 * Redeems the six-digit code and completes registration (ADR-030).
 *
 * Both halves are required: a code identifies nothing on its own, so the
 * address routes and the digits prove. Answers 204 on success and on an
 * already-verified account — both mean "this address is verified", which is
 * all the caller needs.
 *
 * Every other outcome is one `INVALID_VERIFICATION_TOKEN`, without saying
 * which: wrong code, expired, already used, too many attempts, and no such
 * account are deliberately indistinguishable.
 */
export async function verifyEmail(input: VerifyEmailInput): Promise<void> {
  await postAuthNoContent("/verify-email", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * Sends a replacement code, superseding any outstanding one (ADR-008).
 *
 * Resolves for every outcome the server recognises — unknown address,
 * already-verified account, code sent — because each answers 204. That is
 * the same anti-enumeration posture `register` takes, and it means the UI
 * can only ever say "if that address needs a code, one is on its way".
 */
export async function resendVerification(email: string): Promise<void> {
  await postAuthNoContent("/resend-verification", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

/**
 * Asks for a password-reset code (ADR-036).
 *
 * Resolves for every address, because the server answers 204 whether or not
 * it has an account, and whether or not that account may be reset by email.
 * The UI can therefore only ever say "if that address has an account".
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await postAuthNoContent("/forgot-password", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export interface ResetPasswordInput {
  email: string;
  code: string;
  newPassword: string;
}

/**
 * Redeems a reset code and sets a new password (ADR-036).
 *
 * Resolves with nothing and signs nobody in — the server issues no session for
 * a reset, so the person signs in with the password they just chose. Every
 * refusal about the code is one `INVALID_PASSWORD_RESET_CODE`.
 */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  await postAuthNoContent("/reset-password", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * Signs in an organization user.
 *
 * Resolves with the access token and the user's identity. The refresh token
 * is NOT returned here and never could be — it arrives as an `HttpOnly`
 * cookie the browser stores and this code cannot read, which is the point of
 * the flag.
 */
export async function login(credentials: LoginCredentials): Promise<LoginResult> {
  return postAuth<LoginResult>("/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
}

/**
 * Exchanges the refresh cookie for a new access token and the session owner's
 * identity (ADR-012).
 *
 * Sends no body and no Authorization header: the credential is the cookie and
 * only the cookie, and the server refuses a token supplied any other way
 * (ADR-012 §1). This code cannot read or send that cookie itself — the
 * browser attaches it because the request is same-origin and under the
 * cookie's `Path` scope.
 *
 * A 401 here is the ordinary answer for a visitor who simply is not signed
 * in, not an exceptional condition. Callers decide what that means.
 */
export async function refresh(): Promise<RefreshResult> {
  return postAuth<RefreshResult>("/refresh");
}

/**
 * Ends the current session on the server and clears the refresh cookie
 * (ADR-013).
 *
 * Like refresh, the credential is the cookie the browser attaches — there is
 * no body and no token to pass, because this code cannot read the one that
 * matters.
 *
 * Resolves with nothing. The endpoint answers 200 on every path, including
 * one that revoked nothing, so there is no outcome to report and deliberately
 * nothing for a caller to branch on (§1). A rejection here means the request
 * did not arrive at all.
 */
export async function logout(): Promise<void> {
  await postAuth<Record<string, never>>("/logout");
}

/**
 * Ends every session this user holds, including the one making the request,
 * and clears the refresh cookie (ADR-014).
 *
 * Same shape as `logout` — the cookie is the credential, there is no body, and
 * the endpoint answers 200 on every path. It reports no count of what it
 * revoked, deliberately: that is a fact about the account rather than about
 * this request (§2).
 */
export async function logoutAllDevices(): Promise<void> {
  await postAuth<Record<string, never>>("/logout-all");
}

/** The provider's `authorizedFetch` — the only thing that can present an access token. */
type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads the caller's own account (ADR-015).
 *
 * The first call in this client whose credential is the access token rather
 * than the refresh cookie, which is why it goes through `authorizedFetch`
 * rather than `fetch`: that wrapper attaches the in-memory token, and on a 401
 * refreshes once and replays once (ADR-012 §4). Calling `fetch` here would
 * present no credential at all.
 *
 * Two failures reach the caller and mean different things. An `AuthApiError`
 * with status 401 is a refusal that survived the retry — the account is no
 * longer being served, so this browser is not signed in. A rejection from the
 * refresh itself arrives already having cleared the session, and the same
 * error is rethrown untouched: wrapping it would hide which of the two
 * happened from the only code that has to tell them apart.
 */
export async function fetchCurrentUser(authorizedFetch: AuthorizedFetch): Promise<CurrentUserResult> {
  let response: Response;

  try {
    response = await authorizedFetch(`${AUTH_BASE}/me`);
  } catch (error) {
    // The refresh behind the retry failed, and it already described itself.
    if (error instanceof AuthApiError) throw error;
    throw new AuthApiError(NETWORK_ERROR, GENERIC_NETWORK_MESSAGE, 0);
  }

  // `memberships` is a sibling of `user`, exactly as the server nests them —
  // a membership is a fact about a relationship, not an attribute of the
  // person (ADR-017 §9).
  const { user, memberships } = await unwrapEnvelope<{ user: unknown; memberships?: unknown }>(response);

  /*
    `isSuccessEnvelope` proves the envelope, not its contents — a body of
    `{ success: true, data: {} }` satisfies it and would hand back
    `undefined` typed as a CurrentUser, which then crashes wherever the name
    is read. The identity this returns is the one thing the dashboard cannot
    render without, so it is checked rather than asserted.
  */
  if (!isCurrentUser(user)) {
    throw new AuthApiError(UNEXPECTED_RESPONSE, GENERIC_FAILURE_MESSAGE, response.status);
  }

  /*
    Every entry is validated rather than trusted, and anything malformed is
    dropped instead of failing the whole response: a switcher missing one
    option is a far better outcome than a dashboard that will not load. The
    user's identity is load-bearing and is checked strictly above; the
    membership list is not.
  */
  return {
    user,
    memberships: Array.isArray(memberships) ? memberships.filter(isCurrentUserMembership) : [],
  };
}

/**
 * Narrows on the fields that are actually rendered; the rest are the server's
 * business.
 *
 * `platformRole` is deliberately NOT among the required fields. A response
 * that omits it is an older server, and the right answer to that is a
 * dashboard — which is what `isPlatformAdmin` returns for an absent value —
 * rather than a client that refuses to load at all.
 */
function isCurrentUser(value: unknown): value is CurrentUser {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CurrentUser>;
  return (
    typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.email === "string"
  );
}

/**
 * Whether this account should be shown the operations console.
 *
 * One function rather than `user.platformRole === "admin"` scattered across
 * the routing, so the string literal exists in one place and the "absent
 * means no" rule above cannot be forgotten at one of the call sites.
 */
export function isPlatformAdmin(user: CurrentUser | null): boolean {
  return user?.platformRole === "admin";
}

/**
 * Whether this account answers conversations rather than starting them.
 *
 * One function rather than `kind === "agent"` scattered through the routing,
 * so the string literal exists once — and so the DEFAULT is stated once:
 * anything that is not explicitly an agent is not one.
 */
export function isAgent(user: { kind?: string } | null): boolean {
  return user?.kind === "agent";
}

/**
 * Whether this account operates the deployment rather than using it
 * (ADR-035 §4).
 *
 * `kind === "admin"`, which is a different question from `platformRole ===
 * "admin"` even though one account holds both today. `platformRole` is the
 * GRANT — what the server will let them read — and this is the SURFACE, which
 * of the three shells to render. Keeping them separate is what lets the login
 * response route somebody correctly without carrying their grant in it.
 */
export function isAdminKind(user: { kind?: string } | null): boolean {
  return user?.kind === "admin";
}

/**
 * Where a staff account belongs after signing in (ADR-034 §9, ADR-037).
 *
 * The one place that decides, so the sign-in page, the console's door and the
 * post-verification redirect cannot disagree about it.
 *
 * `null` for anything that is neither kind of staff. There is no customer
 * surface to default to any more, and inventing a destination would send an
 * unrecognised account into a guard that bounces it straight back — so the
 * caller renders `NoStaffSurface`, which signs the browser out instead.
 */
export function homePathFor(user: { kind?: string } | null): string | null {
  if (isAdminKind(user)) return "/control";
  if (isAgent(user)) return "/agent";
  return null;
}

function isCurrentUserMembership(value: unknown): value is CurrentUserMembership {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CurrentUserMembership>;
  const organization = candidate.organization;
  return (
    typeof candidate.role === "string" &&
    typeof organization === "object" &&
    organization !== null &&
    typeof organization.id === "string" &&
    typeof organization.name === "string"
  );
}
