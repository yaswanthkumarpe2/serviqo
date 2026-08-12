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
 * Signs in an organization user.
 *
 * Resolves with the access token and the user's identity. The refresh token
 * is NOT returned here and never could be — it arrives as an `HttpOnly`
 * cookie the browser stores and this code cannot read, which is the point of
 * the flag.
 */
export async function login(credentials: LoginCredentials): Promise<LoginResult> {
  let response: Response;

  try {
    response = await fetch(`${AUTH_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Sends and accepts the refresh cookie. Same-origin already implies
      // this, but stating it keeps the call correct if the API ever moves.
      credentials: "same-origin",
      body: JSON.stringify(credentials),
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

  if (!isSuccessEnvelope<LoginResult>(body)) {
    throw new AuthApiError(UNEXPECTED_RESPONSE, GENERIC_FAILURE_MESSAGE, response.status);
  }

  return body.data;
}
