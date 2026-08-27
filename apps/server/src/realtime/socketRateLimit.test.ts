import { afterEach, describe, expect, it, vi } from "vitest";

import { SocketRateLimiter } from "./socketRateLimit";

describe("SocketRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows attempts up to the limit and refuses the next one", () => {
    const limiter = new SocketRateLimiter(3, 60_000);

    expect(limiter.check("customer-a").allowed).toBe(true);
    expect(limiter.check("customer-a").allowed).toBe(true);
    expect(limiter.check("customer-a").allowed).toBe(true);
    expect(limiter.check("customer-a").allowed).toBe(false);
  });

  it("keeps separate budgets per key", () => {
    const limiter = new SocketRateLimiter(1, 60_000);

    expect(limiter.check("customer-a").allowed).toBe(true);
    expect(limiter.check("customer-b").allowed).toBe(true);
    expect(limiter.check("customer-a").allowed).toBe(false);
    expect(limiter.check("customer-b").allowed).toBe(false);
  });

  it("resets the budget once the window elapses", () => {
    vi.useFakeTimers();
    const limiter = new SocketRateLimiter(1, 1_000);

    expect(limiter.check("customer-a").allowed).toBe(true);
    expect(limiter.check("customer-a").allowed).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter.check("customer-a").allowed).toBe(true);
  });
});
