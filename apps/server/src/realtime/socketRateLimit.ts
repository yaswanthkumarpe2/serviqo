/**
 * A minimal fixed-window rate limiter for the Socket.IO transport
 * (ADR-023 §8).
 *
 * `express-rate-limit` (used everywhere else, `lib/rateLimit`) is built
 * around a per-HTTP-request `req`/`res` lifecycle a long-lived socket
 * connection does not have, so it cannot key a socket event. This
 * implements the identical POLICY SHAPE `lib/rateLimit` already documents as
 * its own assumption — a single process's in-memory `Map`, fixed window,
 * refuse past the limit — rather than a different one: correct for one
 * process, and not correct behind a load balancer, exactly like
 * `MemoryStore` (ADR-018 §2). Closing that gap for both transports at once
 * is ROADMAP Phase 8's Redis adapter, not this file.
 */

export interface RateLimitDecision {
  allowed: boolean;
}

export class SocketRateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one attempt for `key` and reports whether it is within budget. */
  check(key: string): RateLimitDecision {
    const now = Date.now();
    const entry = this.counts.get(key);

    if (entry === undefined || entry.resetAt <= now) {
      this.counts.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }

    entry.count += 1;
    return { allowed: entry.count <= this.limit };
  }
}
