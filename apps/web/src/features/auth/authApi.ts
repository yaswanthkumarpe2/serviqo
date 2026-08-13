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
  id: string;
  name: string;
  email: string;
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
