import { ipKeyGenerator, rateLimit } from "express-rate-limit";

import { REFRESH_COOKIE_NAME } from "../../config/constants";
import { readCookie } from "../http/cookies";
import { parseRefreshToken } from "../../modules/auth/refreshToken";

import {
  AUTHENTICATED_READ_LIMIT,
  AUTHENTICATED_READ_WINDOW_MS,
  AUTHENTICATED_WRITE_LIMIT,
  AUTHENTICATED_WRITE_WINDOW_MS,
  CREDENTIAL_LIMIT,
  CREDENTIAL_WINDOW_MS,
  EMAIL_VERIFICATION_LIMIT,
  EMAIL_VERIFICATION_WINDOW_MS,
  GLOBAL_API_LIMIT,
  GLOBAL_API_WINDOW_MS,
  MEMBER_INVITE_LIMIT,
  MEMBER_INVITE_WINDOW_MS,
  OWNERSHIP_TRANSFER_LIMIT,
  OWNERSHIP_TRANSFER_WINDOW_MS,
  PASSWORD_RESET_LIMIT,
  PASSWORD_RESET_REQUEST_LIMIT,
  PASSWORD_RESET_REQUEST_WINDOW_MS,
  PASSWORD_RESET_WINDOW_MS,
  SESSION_LIMIT,
  SESSION_WINDOW_MS,
  VERIFICATION_RESEND_LIMIT,
  VERIFICATION_RESEND_WINDOW_MS,
  WIDGET_CONVERSATION_READ_LIMIT,
  WIDGET_CONVERSATION_READ_WINDOW_MS,
  WIDGET_CONVERSATION_WRITE_LIMIT,
  WIDGET_CONVERSATION_WRITE_WINDOW_MS,
  WIDGET_DIRECTORY_LIMIT,
  WIDGET_DIRECTORY_WINDOW_MS,
  WIDGET_SESSION_LIMIT,
  WIDGET_SESSION_WINDOW_MS,
} from "../../config/constants";
import { TooManyRequestsError } from "../errors";

import type { RequestHandler } from "express";

/**
 * Rate limiting (ADR-018).
 *
 * One factory builds every limiter, so the store, the response shape, and
 * the logging are decided once. That is also the seam ADR-007 §13 was
 * worried about: a Redis-backed deployment replaces the `store` argument
 * here and changes nothing about the policy, the keys, the responses, or
 * the tests.
 *
 * Storage is `express-rate-limit`'s default `MemoryStore` — correct for a
 * single process, and NOT correct behind a load balancer, where N nodes
 * grant N times the budget. That is the residual deployment gate
 * (ADR-018 §2), recorded in SECURITY.md §3.
 */

/** One message for every class, naming no limit and no window (ADR-018 §6). */
const GENERIC_FAILURE_MESSAGE = "Too many requests. Please wait a few minutes and try again.";

/**
 * Which limiter refused a request. Reaches the log and never a response
 * body — a caller learning which class they tripped learns the shape of the
 * defences (ADR-018 §6).
 */
export type RateLimitClass =
  | "credential"
  | "emailVerification"
  | "verificationResend"
  | "passwordResetRequest"
  | "passwordReset"
  | "session"
  | "authenticatedWrite"
  | "authenticatedRead"
  | "memberInvite"
  | "ownershipTransfer"
  | "widgetSession"
  | "widgetDirectory"
  | "widgetConversationWrite"
  | "widgetConversationRead"
  | "global";

interface LimiterOptions {
  limitClass: RateLimitClass;
  windowMs: number;
  limit: number;
  /**
   * Present for the classes that mount after `requireAccessToken`, which key
   * on the verified user rather than the socket address (ADR-018 §4).
   * Absent means "key by IP".
   */
  keyByUser?: boolean;
  /**
   * Present for the classes that mount after `requireWidgetToken`, which key
   * on the verified customer rather than the socket address (ADR-022 §12) —
   * the widget-side sibling of `keyByUser`.
   */
  keyByCustomer?: boolean;
  /**
   * Present for the session class, which keys on the SESSION the refresh
   * cookie names rather than on the socket address (ADR-035 §2).
   *
   * These routes run before any principal exists — the credential is the
   * cookie — so `keyByUser` cannot apply. But the cookie carries a session id
   * as its non-secret routing component, and that is a far better key than an
   * IP: one browser reloading heavily can then only exhaust its own budget,
   * where an IP key made every tab, every device and every colleague behind
   * one NAT share sixty refreshes.
   */
  keyBySessionCookie?: boolean;
}

function createLimiter({
  limitClass,
  windowMs,
  limit,
  keyByUser = false,
  keyByCustomer = false,
  keyBySessionCookie = false,
}: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    /*
      IETF draft-7 sends `RateLimit` and `Retry-After`. Legacy `X-RateLimit-*`
      is off: two spellings of one fact is one too many.
    */
    standardHeaders: "draft-7",
    legacyHeaders: false,

    keyGenerator: (req) => {
      if (keyByUser) {
        /*
          These classes mount AFTER `requireAccessToken`, so the principal is
          established. Falling back to the IP rather than asserting keeps a
          misordered mount from throwing on a hot path — it degrades to the
          weaker key instead of failing the request.
        */
        const userId = req.principal?.userId;
        if (userId !== undefined) return `user:${userId}`;
      }

      if (keyByCustomer) {
        // Mounts AFTER `requireWidgetToken` (ADR-022 §12). Same degrade-
        // rather-than-throw fallback as keyByUser above.
        const customerId = req.widgetPrincipal?.customerId;
        if (customerId !== undefined) return `customer:${customerId}`;
      }

      if (keyBySessionCookie) {
        /*
          The session id out of the refresh cookie (ADR-035 §2).

          `parseRefreshToken` splits the cookie into its non-secret routing
          component and its secret, and only the FORMER is used here — the
          secret never becomes a limiter key, where it would sit in the
          limiter's memory as a credential in plaintext.

          Nothing is verified: an attacker can invent a well-formed session id
          and get a fresh budget with it. That is accepted, because this key's
          job is isolating honest clients from each other rather than bounding
          an attacker — the `global` per-IP class already does the second, and
          a refresh secret is 256 bits of entropy, so guessing is not the
          threat here.

          Falls back to the IP when no cookie arrives, which is exactly the
          unauthenticated caller who deserves the blunter key.
        */
        const cookie = readCookie(req.get("cookie"), REFRESH_COOKIE_NAME);
        const parsed = cookie === undefined ? null : parseRefreshToken(cookie);
        if (parsed !== null) return `session:${parsed.sessionId}`;
      }

      /*
        `ipKeyGenerator` rather than raw `req.ip`: it masks IPv6 addresses to
        their /64, so a client with a routed prefix cannot take a fresh
        budget per address inside its own subnet.

        `req.ip` is the socket address because `trust proxy` is off, so a
        forged `X-Forwarded-For` changes nothing here (ADR-018 §7).
      */
      return ipKeyGenerator(req.ip ?? "unknown");
    },

    /*
      Routed through the application's own error so the refusal uses the
      approved envelope (ADR-018 §6) rather than the library's default text
      body. `errorHandler` writes it exactly like a 401 or a 400.

      The headers the library already set on `res` survive — `next(err)` does
      not clear them — so `Retry-After` accompanies the enveloped body.
    */
    handler: (req, _res, next) => {
      /*
        Safe fields only (ADR-018 §10): what was limited, and the request id
        `requestContext` bound. No body, no Authorization header, no cookies,
        no token, and no email. The client key is deliberately absent too —
        for IP-keyed classes it is an IP address, and logging one per refusal
        turns the limiter into an access log nobody asked for.
      */
      req.log.warn(
        { event: "security.rate_limit.exceeded", limitClass },
        "Request refused by the rate limiter",
      );
      next(new TooManyRequestsError(GENERIC_FAILURE_MESSAGE));
    },
  });
}

/**
 * The limiter set for one application instance.
 *
 * Built per `createApp` rather than at module scope so each instance owns
 * its counters. In production there is one instance; in tests it means one
 * suite cannot exhaust another's budget through shared module state.
 */
export interface RateLimiters {
  /**
   * `POST /login`, and only that (ADR-031 §2).
   *
   * The three classes below were carved out of this one. Sign-up traffic and
   * password guessing are different behaviours defended against for different
   * reasons, and a shared counter meant an honest sign-up spent a password
   * guesser's budget.
   */
  credential: RequestHandler;
  /**
   * `POST /verify-email` (ADR-031 §4). The outer of two guessing bounds — the
   * inner one, `EMAIL_VERIFICATION_MAX_ATTEMPTS`, destroys the code after five
   * wrong guesses whatever this class allows.
   */
  emailVerification: RequestHandler;
  /**
   * `POST /resend-verification` (ADR-031 §5). The tightest class in the set:
   * every accepted call sends mail to an address the caller names, so
   * generosity here is spent on somebody else's inbox and on the sending
   * domain's reputation.
   */
  verificationResend: RequestHandler;
  /**
   * `POST /forgot-password` (ADR-036 §5). Mails a code to an address the caller
   * names, so it is sized like `verificationResend` — and kept apart from it so
   * waiting on one kind of mail never costs the other.
   */
  passwordResetRequest: RequestHandler;
  /**
   * `POST /reset-password` (ADR-036 §5). The outer guessing bound;
   * `PASSWORD_RESET_MAX_ATTEMPTS` is the inner, real one.
   */
  passwordReset: RequestHandler;
  /**
   * Session endpoints: refresh, logout, logout-all.
   *
   * Keyed by the SESSION the refresh cookie names, not by IP (ADR-035 §2).
   * Reloading a page costs one refresh, and a person with several tabs open
   * used to spend a budget shared with everyone else on their network — which
   * is how a valid session ended up refused, and then discarded by a client
   * that read the refusal as a sign-out.
   */
  session: RequestHandler;
  /** Authenticated writes. Keyed by user. */
  authenticatedWrite: RequestHandler;
  /** Authenticated reads. Keyed by user. */
  authenticatedRead: RequestHandler;
  /**
   * Adding a member: `POST /organizations/:id/members` (ADR-027 §12). Keyed
   * by user.
   *
   * Its own class rather than `authenticatedWrite`, because it bounds
   * ADR-027 §5's account-existence disclosure specifically — sharing a budget
   * with role changes and removals would make ordinary team admin
   * indistinguishable from probing.
   */
  memberInvite: RequestHandler;
  /**
   * Ownership transfer: `POST /organizations/:id/ownership` (ADR-028 §11).
   * Keyed by user.
   *
   * Its own class rather than `authenticatedWrite`, because it bounds the most
   * destructive and rarest operation in the product specifically — sharing a
   * budget with widget-config edits would let ordinary configuration work
   * exhaust it, and would hide a run of transfer attempts inside the write
   * class's ordinary noise.
   */
  ownershipTransfer: RequestHandler;
  /**
   * The public widget session endpoint (ADR-019 §11). Keyed by IP — never by
   * `widgetKey`, which would make one busy tenant's own visitors a shared
   * outage and hand anyone who read that tenant's page source a
   * denial-of-service tool aimed at it.
   */
  widgetSession: RequestHandler;
  /**
   * The public directory lookup behind an organisation's chat link:
   * `GET /widget/organizations/:slug` (ADR-038 §2). Keyed by IP.
   */
  widgetDirectory: RequestHandler;
  /**
   * Conversation and message writes: `POST /widget/conversations`,
   * `POST /widget/conversations/:id/messages` (ADR-022 §12). Keyed by
   * customer — a verified principal already exists by the time this mounts.
   */
  widgetConversationWrite: RequestHandler;
  /** Conversation message history reads: `GET /widget/conversations/:id/messages` (ADR-022 §12). Keyed by customer. */
  widgetConversationRead: RequestHandler;
  /** Blunt per-IP volume bound over the whole API, including requests that 401. */
  global: RequestHandler;
}

export function createRateLimiters(): RateLimiters {
  return {
    credential: createLimiter({
      limitClass: "credential",
      windowMs: CREDENTIAL_WINDOW_MS,
      limit: CREDENTIAL_LIMIT,
    }),
    emailVerification: createLimiter({
      limitClass: "emailVerification",
      windowMs: EMAIL_VERIFICATION_WINDOW_MS,
      limit: EMAIL_VERIFICATION_LIMIT,
    }),
    verificationResend: createLimiter({
      limitClass: "verificationResend",
      windowMs: VERIFICATION_RESEND_WINDOW_MS,
      limit: VERIFICATION_RESEND_LIMIT,
    }),
    passwordResetRequest: createLimiter({
      limitClass: "passwordResetRequest",
      windowMs: PASSWORD_RESET_REQUEST_WINDOW_MS,
      limit: PASSWORD_RESET_REQUEST_LIMIT,
    }),
    passwordReset: createLimiter({
      limitClass: "passwordReset",
      windowMs: PASSWORD_RESET_WINDOW_MS,
      limit: PASSWORD_RESET_LIMIT,
    }),
    session: createLimiter({
      limitClass: "session",
      windowMs: SESSION_WINDOW_MS,
      limit: SESSION_LIMIT,
      keyBySessionCookie: true,
    }),
    authenticatedWrite: createLimiter({
      limitClass: "authenticatedWrite",
      windowMs: AUTHENTICATED_WRITE_WINDOW_MS,
      limit: AUTHENTICATED_WRITE_LIMIT,
      keyByUser: true,
    }),
    authenticatedRead: createLimiter({
      limitClass: "authenticatedRead",
      windowMs: AUTHENTICATED_READ_WINDOW_MS,
      limit: AUTHENTICATED_READ_LIMIT,
      keyByUser: true,
    }),
    memberInvite: createLimiter({
      limitClass: "memberInvite",
      windowMs: MEMBER_INVITE_WINDOW_MS,
      limit: MEMBER_INVITE_LIMIT,
      keyByUser: true,
    }),
    ownershipTransfer: createLimiter({
      limitClass: "ownershipTransfer",
      windowMs: OWNERSHIP_TRANSFER_WINDOW_MS,
      limit: OWNERSHIP_TRANSFER_LIMIT,
      keyByUser: true,
    }),
    /*
      Built by the same factory as every other class, so the widget endpoint
      takes the same store, the same envelope, the same standards-track
      headers, and the same safe-fields-only logging. The security gate is not
      bypassed and there is no ad-hoc limiter (ADR-019 §11) — the endpoint
      also sits under `/api/v1`, so the `global` bound applies to it too.
    */
    widgetSession: createLimiter({
      limitClass: "widgetSession",
      windowMs: WIDGET_SESSION_WINDOW_MS,
      limit: WIDGET_SESSION_LIMIT,
    }),
    widgetDirectory: createLimiter({
      limitClass: "widgetDirectory",
      windowMs: WIDGET_DIRECTORY_WINDOW_MS,
      limit: WIDGET_DIRECTORY_LIMIT,
    }),
    widgetConversationWrite: createLimiter({
      limitClass: "widgetConversationWrite",
      windowMs: WIDGET_CONVERSATION_WRITE_WINDOW_MS,
      limit: WIDGET_CONVERSATION_WRITE_LIMIT,
      keyByCustomer: true,
    }),
    widgetConversationRead: createLimiter({
      limitClass: "widgetConversationRead",
      windowMs: WIDGET_CONVERSATION_READ_WINDOW_MS,
      limit: WIDGET_CONVERSATION_READ_LIMIT,
      keyByCustomer: true,
    }),
    global: createLimiter({
      limitClass: "global",
      windowMs: GLOBAL_API_WINDOW_MS,
      limit: GLOBAL_API_LIMIT,
    }),
  };
}

/**
 * A limiter set that refuses nothing.
 *
 * Used when rate limiting is disabled — the test environment by default
 * (ADR-018 §8) — so every route mounts the same middleware in the same order
 * regardless. A conditional mount would mean the ordering under test
 * differed from the ordering in production, which is the kind of difference
 * that hides a bug until deployment.
 */
export function createDisabledRateLimiters(): RateLimiters {
  const passthrough: RequestHandler = (_req, _res, next) => next();
  return {
    credential: passthrough,
    emailVerification: passthrough,
    verificationResend: passthrough,
    passwordResetRequest: passthrough,
    passwordReset: passthrough,
    session: passthrough,
    authenticatedWrite: passthrough,
    authenticatedRead: passthrough,
    memberInvite: passthrough,
    ownershipTransfer: passthrough,
    widgetSession: passthrough,
    widgetDirectory: passthrough,
    widgetConversationWrite: passthrough,
    widgetConversationRead: passthrough,
    global: passthrough,
  };
}
