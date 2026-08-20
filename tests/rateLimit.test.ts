import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter } from "../lib/rateLimit";

/** Injectable clock so no test has to sleep. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows exactly `limit` requests in a window", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    assert.deepEqual(limiter.check("user_a"), { allowed: true, remaining: 2, retryAfterSeconds: 0 });
    assert.equal(limiter.check("user_a").remaining, 1);
    assert.equal(limiter.check("user_a").remaining, 0);

    const blocked = limiter.check("user_a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
  });

  it("reports how long to wait, rounded up to whole seconds", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check("user_a");

    clock.advance(58_500);
    assert.equal(limiter.check("user_a").retryAfterSeconds, 2);
  });

  it("never reports a retry-after of zero while blocked", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check("user_a");

    clock.advance(59_999);
    const blocked = limiter.check("user_a");
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);
  });

  it("starts a fresh window once the old one expires", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check("user_a");
    assert.equal(limiter.check("user_a").allowed, false);

    clock.advance(60_001);
    assert.equal(limiter.check("user_a").allowed, true);
  });

  it("counts each key independently, so one user cannot block another", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check("user_a");

    assert.equal(limiter.check("user_a").allowed, false);
    assert.equal(limiter.check("user_b").allowed, true);
  });

  it("clears every counter on reset", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.check("user_a");
    limiter.reset();
    assert.equal(limiter.check("user_a").allowed, true);
  });
});
